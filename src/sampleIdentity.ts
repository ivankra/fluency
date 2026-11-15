// Gives sample decks created before they had fixed ids (random ids, one set per device)
// their fixed ids, so the copies on different devices become one deck when synced.
// Sync applies it to both sides before merging. Pure and deterministic: every device
// turns the same data into the same result. Design: doc/drive-sync.md.
import type { Card, Deck, Deletion, Snapshot } from './db'
import { canonical } from './merge'
import { SAMPLE_DECKS, sampleDeckId } from './sampleDecks'

const key = (front: string, back: string) => `${front}\u0000${back}`

// The later of two versions; ties go to the larger canonical JSON, as in merge.ts.
const later = <T,>(a: T, b: T, time: (item: T) => number, part: (item: T) => unknown = (item) => item) =>
  time(a) !== time(b) ? (time(a) > time(b) ? a : b) : canonical(part(a)) >= canonical(part(b)) ? a : b

/**
 * A deck with a random id is taken for a sample deck if it has a sample deck's name and
 * at least half of its cards (and at least one) have that deck's shipped text. Then:
 * - the deck gets the fixed id (`sample-es`), and its shipped cards theirs
 *   (`sample-es-1` …); other cards keep their place with an id derived from the old one;
 * - copies that end up with the same id are combined (newer text, newer schedule);
 * - reviews follow their cards;
 * - a shipped card missing from a copy was deleted there, so it is recorded as deleted
 *   and sync removes it from the other copies too;
 * - the old ids are recorded as deleted.
 * Decks a user renamed or filled with their own cards are left alone.
 */
export function normalizeSampleDecks(snapshot: Snapshot): Snapshot {
  const newDeckId = new Map<string, string>() // old → fixed
  const newCardId = new Map<string, string>()
  const deletions: Deletion[] = []

  for (const deck of snapshot.decks) {
    const sample = SAMPLE_DECKS.find((s) => s.name === deck.name)
    if (!sample) continue
    const fixed = sampleDeckId(sample.targetLanguage)
    if (deck.id === fixed) continue
    const shipped = sample.cards.map(([front, back]) => key(front, back))
    const cards = snapshot.cards.filter((card) => card.deckId === deck.id)
    const index = (card: Card) => shipped.indexOf(key(card.front, card.back))
    const matched = cards.filter((card) => index(card) >= 0)
    if (!matched.length || matched.length * 2 < cards.length) continue

    newDeckId.set(deck.id, fixed)
    deletions.push({ id: deck.id, table: 'decks', at: 0 })
    for (const card of cards) {
      const i = index(card)
      newCardId.set(card.id, i >= 0 ? `${fixed}-${i + 1}` : `${fixed}~${card.id}`)
      deletions.push({ id: card.id, table: 'cards', at: 0 })
    }
    const present = new Set(matched.map(index))
    shipped.forEach((_, i) => present.has(i) || deletions.push({ id: `${fixed}-${i + 1}`, table: 'cards', at: 0 }))
  }
  if (!newDeckId.size) return snapshot

  const decks = new Map<string, Deck>()
  for (const deck of snapshot.decks) {
    const moved = { ...deck, id: newDeckId.get(deck.id) ?? deck.id }
    const existing = decks.get(moved.id)
    decks.set(moved.id, existing ? later(existing, moved, (d) => d.updatedAt) : moved)
  }

  const cards = new Map<string, Card>()
  for (const card of snapshot.cards) {
    const moved = { ...card, id: newCardId.get(card.id) ?? card.id, deckId: newDeckId.get(card.deckId) ?? card.deckId }
    const existing = cards.get(moved.id)
    if (!existing) {
      cards.set(moved.id, moved)
      continue
    }
    const content = later(existing, moved, (c) => c.updatedAt, ({ sched: _, ...rest }) => rest)
    const schedule = later(existing, moved, (c) => c.sched.updatedAt ?? c.updatedAt, (c) => c.sched)
    cards.set(moved.id, { ...content, sched: schedule.sched })
  }

  // Keep the earliest record of each deletion, as merge does.
  const allDeletions = new Map<string, Deletion>()
  for (const deletion of [...snapshot.deletions, ...deletions]) {
    const existing = allDeletions.get(deletion.id)
    if (!existing || deletion.at < existing.at) allDeletions.set(deletion.id, deletion)
  }

  return {
    decks: [...decks.values()],
    cards: [...cards.values()],
    reviews: snapshot.reviews.map((review) => (newCardId.has(review.cardId) ? { ...review, cardId: newCardId.get(review.cardId)! } : review)),
    deletions: [...allDeletions.values()],
  }
}
