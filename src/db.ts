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

// Cards due for review, soonest first.
export const getDueCards = (deckId: string, now = Date.now(), limit = 20) =>
  db.cards
    .where('[deckId+sched.due]')
    .between([deckId, Dexie.minKey], [deckId, now], true, true)
    .limit(limit)
    .toArray()

// --- Reviews ---

// Log an attempt and store the card's new schedule atomically.
// The caller (scheduler) computes `sched` from the grade.
export const recordReview = (card: Card, grade: Grade, sched: Sched, answer?: string) =>
  db.transaction('rw', db.cards, db.reviews, async () => {
    const now = Date.now()
    await db.reviews.add({ id: newId(), cardId: card.id, at: now, grade, answer })
    await db.cards.update(card.id, { sched, updatedAt: now })
  })

// Skip: hide the card for a few days. Not a review, so no history entry.
export const skipCard = (card: Card, days = 3) =>
  db.cards.update(card.id, {
    sched: { ...card.sched, due: Date.now() + days * 86_400_000 },
    updatedAt: Date.now(),
  })

export const listReviews = (cardId: string) =>
  db.reviews.where('cardId').equals(cardId).sortBy('at')

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
