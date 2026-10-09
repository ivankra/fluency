// On-device storage (IndexedDB via Dexie). Works on Android, iOS and desktop Chrome.
//
// Every entity has a unique `id` and an `updatedAt` timestamp (ms), so Google Drive
// sync can detect conflicts now and merge per-entity later.
import Dexie, { type EntityTable } from 'dexie'

export interface Deck {
  id: string
  name: string
  updatedAt: number
}

// Scheduling state, owned by the scheduler. Kept as a nested object so another
// algorithm (e.g. FSRS) can swap in its own fields without touching Card.
export interface Sched {
  due: number // ms timestamp; the card is up for review once now >= due
  interval: number // days
  ease: number // SM-2 ease factor
  reps: number
  lapses: number
}

export interface Card {
  id: string
  deckId: string
  front: string // sentence in the user's native language (prompt)
  back: string // expected sentence in the target language
  sched: Sched
  updatedAt: number
}

export type Grade = 1 | 2 | 3 // bad, fair, good
export const GRADES: { grade: Grade; label: string }[] = [
  { grade: 1, label: 'Bad' },
  { grade: 2, label: 'Fair' },
  { grade: 3, label: 'Good' },
]

// One past attempt. Skipped cards are not recorded here.
export interface Review {
  id: string
  cardId: string
  at: number
  grade: Grade
  answer?: string // what the user typed/said, once we have LLM grading
}

export interface Backup {
  decks: Deck[]
  cards: Card[]
  reviews: Review[]
}

const db = new Dexie('fluency') as Dexie & {
  decks: EntityTable<Deck, 'id'>
  cards: EntityTable<Card, 'id'>
  reviews: EntityTable<Review, 'id'>
}

// Only indexed fields are listed. Add a new version() block for schema changes.
db.version(1).stores({
  decks: 'id',
  cards: 'id, deckId, [deckId+sched.due]',
  reviews: 'id, cardId, at',
})

const newId = () => crypto.randomUUID()

export const newSched = (now = Date.now()): Sched => ({
  due: now,
  interval: 0,
  ease: 2.5,
  reps: 0,
  lapses: 0,
})

// --- Decks ---

// `name` isn't indexed, so sort in memory rather than with orderBy().
export const listDecks = () => db.decks.toCollection().sortBy('name')

export const getDeck = async (id: string) => (await db.decks.get(id)) ?? null

export async function addDeck(name: string): Promise<Deck> {
  const deck = { id: newId(), name, updatedAt: Date.now() }
  await db.decks.add(deck)
  return deck
}

export const renameDeck = (id: string, name: string) =>
  db.decks.update(id, { name, updatedAt: Date.now() })

export const deleteDeck = (id: string) =>
  db.transaction('rw', db.decks, db.cards, db.reviews, async () => {
    const cardIds = await db.cards.where('deckId').equals(id).primaryKeys()
    await db.reviews.where('cardId').anyOf(cardIds).delete()
    await db.cards.bulkDelete(cardIds)
    await db.decks.delete(id)
  })

// --- Cards ---

export const listCards = (deckId: string) => db.cards.where('deckId').equals(deckId).toArray()

export async function addCard(deckId: string, front: string, back: string): Promise<Card> {
  const now = Date.now()
  const card = { id: newId(), deckId, front, back, sched: newSched(now), updatedAt: now }
  await db.cards.add(card)
  return card
}

export const editCard = (id: string, front: string, back: string) =>
  db.cards.update(id, { front, back, updatedAt: Date.now() })

export const deleteCard = (id: string) =>
  db.transaction('rw', db.cards, db.reviews, async () => {
    await db.reviews.where('cardId').equals(id).delete()
    await db.cards.delete(id)
  })

const dueCards = (deckId: string, now: number) =>
  db.cards.where('[deckId+sched.due]').between([deckId, Dexie.minKey], [deckId, now], true, true)

// Cards due for review, soonest first.
export const getDueCards = (deckId: string, now = Date.now(), limit = 20) =>
  dueCards(deckId, now).limit(limit).toArray()

export const countDueCards = (deckId: string, now = Date.now()) => dueCards(deckId, now).count()

// --- Reviews ---

// Log an attempt and store the card's new schedule atomically.
// The caller (scheduler) computes `sched` from the grade.
export const recordReview = (card: Card, grade: Grade, sched: Sched, answer?: string) =>
  db.transaction('rw', db.cards, db.reviews, async () => {
    const now = Date.now()
    const id = newId()
    await db.reviews.add({ id, cardId: card.id, at: now, grade, answer })
    await db.cards.update(card.id, { sched, updatedAt: now })
    return id
  })

// Take back a review or skip: restore the card's old schedule and drop the review, if any.
export const undoAttempt = (cardId: string, sched: Sched, reviewId?: string) =>
  db.transaction('rw', db.cards, db.reviews, async () => {
    if (reviewId) await db.reviews.delete(reviewId)
    await db.cards.update(cardId, { sched, updatedAt: Date.now() })
  })

// Skip: not a review, so no history entry. The caller (scheduler) computes `sched`.
export const skipCard = (card: Card, sched: Sched) =>
  db.cards.update(card.id, { sched, updatedAt: Date.now() })

// Per-card attempt counts as [bad, fair, good], for cards in a deck.
export async function gradeCounts(deckId: string) {
  const counts = new Map<string, [number, number, number]>()
  const cardIds = await db.cards.where('deckId').equals(deckId).primaryKeys()
  await db.reviews
    .where('cardId')
    .anyOf(cardIds)
    .each((r) => {
      const c = counts.get(r.cardId) ?? [0, 0, 0]
      c[r.grade - 1]++
      counts.set(r.cardId, c)
    })
  return counts
}

// --- Backup (JSON export/import, also the basis for Drive sync) ---

export const exportAll = (): Promise<Backup> =>
  db.transaction('r', db.decks, db.cards, db.reviews, async () => ({
    decks: await db.decks.toArray(),
    cards: await db.cards.toArray(),
    reviews: await db.reviews.toArray(),
  }))

// Replaces the entire local database.
export const importAll = (data: Backup) =>
  db.transaction('rw', db.decks, db.cards, db.reviews, async () => {
    await Promise.all([db.decks.clear(), db.cards.clear(), db.reviews.clear()])
    await db.decks.bulkAdd(data.decks)
    await db.cards.bulkAdd(data.cards)
    await db.reviews.bulkAdd(data.reviews)
  })

// Ask the browser not to evict our data under storage pressure (matters on iOS/Safari).
export const requestPersistentStorage = () => navigator.storage?.persist?.()
