// Merges two copies of the database (this device's and the one in Drive) item by item.
// Pure, deterministic and symmetric, so devices converge whichever syncs first.
// Design: doc/drive-sync.md.
//
// Assumes a card never moves to another deck and a review never to another card (true
// today: nothing changes deckId or cardId). A "move card" feature would need a rule
// here, or a card moved on one device into a deck deleted on another could survive or
// not depending on the order devices sync.
import type { Card, Deck, Deletion, Review, Snapshot } from './db'

// JSON with object keys sorted, so equal data gives equal strings on every device.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  )
}

const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// A snapshot in a fixed order, for comparing two of them.
export const sortSnapshot = (s: Snapshot): Snapshot => ({
  decks: byId(s.decks),
  cards: byId(s.cards),
  reviews: byId(s.reviews),
  deletions: byId(s.deletions),
})

// The later of two versions of an item. On equal timestamps the larger canonical JSON
// of the compared part wins, so both devices pick the same one.
function newer<T>(a: T, b: T, time: (item: T) => number, part: (item: T) => unknown = (item) => item): T {
  const [ta, tb] = [time(a), time(b)]
  if (ta !== tb) return ta > tb ? a : b
  return canonical(part(a)) >= canonical(part(b)) ? a : b
}

// Cards written before schedules had their own timestamp take the card's. Done before
// merging: a merged card can combine one copy's text with another's schedule, and the
// schedule must keep its own time, not inherit the text's.
const withSchedTime = (card: Card): Card =>
  card.sched.updatedAt === undefined ? { ...card, sched: { ...card.sched, updatedAt: card.updatedAt } } : card
const schedTime = (card: Card) => card.sched.updatedAt!

// Content (front, back, deck) and schedule are merged separately, so an edit on one
// device and a review on another both survive. Ties compare only the part being
// merged; otherwise merging an already merged card could pick differently.
function mergeCards(a: Card, b: Card): Card {
  const content = newer(a, b, (card) => card.updatedAt, ({ sched: _, ...rest }) => rest)
  const schedule = newer(a, b, schedTime, (card) => card.sched)
  return content === schedule ? content : { ...content, sched: schedule.sched }
}

// Reviews never change, so two copies are the same review; pick one deterministically.
const mergeReviews = (a: Review, b: Review) => (canonical(a) >= canonical(b) ? a : b)

function union<T extends { id: string }>(a: T[], b: T[], pick: (x: T, y: T) => T): Map<string, T> {
  const items = new Map(a.map((item) => [item.id, item]))
  for (const item of b) {
    const existing = items.get(item.id)
    items.set(item.id, existing ? pick(existing, item) : item)
  }
  return items
}

export interface MergeResult {
  result: Snapshot
  localChanged: boolean // the result differs from `local`: write it to IndexedDB
  remoteChanged: boolean // the result differs from `remote`: upload it
}

export function merge(local: Snapshot, remote: Snapshot): MergeResult {
  // 1. Deletions: both sides', keeping the earliest record of each.
  const deletions = union(local.deletions, remote.deletions, (a, b) =>
    a.at !== b.at ? (a.at < b.at ? a : b) : canonical(a) <= canonical(b) ? a : b,
  )
  const deleted = (id: string) => deletions.has(id)

  // 2. Deletes win: anything deleted on either side is dropped, even if edited since.
  const decks = new Map([...union<Deck>(local.decks, remote.decks, (a, b) => newer(a, b, (deck) => deck.updatedAt))].filter(([id]) => !deleted(id)))
  const cards = new Map([...union(local.cards.map(withSchedTime), remote.cards.map(withSchedTime), mergeCards)].filter(([id]) => !deleted(id)))
  const reviews = new Map([...union(local.reviews, remote.reviews, mergeReviews)].filter(([id]) => !deleted(id)))

  // 3. Cascade: a card whose deck is gone, or a review whose card is gone (e.g. added on
  // one device while the parent was deleted on the other), is dropped and recorded as
  // deleted at the time of its parent's deletion.
  const cascade = <T extends { id: string }>(items: Map<string, T>, table: Deletion['table'], parentId: (item: T) => string, parents: Map<string, unknown>) => {
    for (const [id, item] of items) {
      if (parents.has(parentId(item))) continue
      items.delete(id)
      deletions.set(id, { id, table, at: deletions.get(parentId(item))?.at ?? 0 })
    }
  }
  cascade(cards, 'cards', (card) => card.deckId, decks)
  cascade(reviews, 'reviews', (review) => review.cardId, cards)

  const result = sortSnapshot({
    decks: [...decks.values()],
    cards: [...cards.values()],
    reviews: [...reviews.values()],
    deletions: [...deletions.values()],
  })
  const same = (other: Snapshot) => canonical(sortSnapshot(other)) === canonical(result)
  return { result, localChanged: !same(local), remoteChanged: !same(remote) }
}
