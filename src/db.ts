// On-device storage (IndexedDB via Dexie). Works on Android, iOS and desktop Chrome.
//
// Every entity has a unique `id` and an `updatedAt` timestamp (ms), so Google Drive
// sync can detect conflicts now and merge per-entity later.
import Dexie, { type EntityTable, type IDType } from 'dexie'
import type { AnswerMode, ReviewAssessment } from './grader'
import { noteChange } from './changes'
import { canonical, sortSnapshot } from './merge'

export interface Deck {
  id: string
  name: string
  sourceLanguage?: string // BCP 47 tags; both are needed for LLM grading
  targetLanguage?: string
  updatedAt: number
}

// Scheduling state, owned by the scheduler (see scheduler.ts). Each algorithm has its
// own shape; `due` is shared and indexed. Records without `algo` are SM-2.
export interface Sm2Sched {
  algo?: 'sm2'
  updatedAt?: number // when the schedule last changed (ms); missing means the card's updatedAt
  due: number // ms timestamp; the card is up for review once now >= due
  interval: number // days
  ease: number // SM-2 ease factor
  reps: number
  lapses: number
}

export interface FsrsSched {
  algo: 'fsrs'
  updatedAt?: number // as in Sm2Sched
  due: number
  stability: number
  difficulty: number
  state: 0 | 1 | 2 | 3 // new, learning, review, relearning (ts-fsrs State)
  learningStep: number
  scheduledDays: number
  lastReview: number | null // ms
  reps: number
  lapses: number
}

export type Sched = Sm2Sched | FsrsSched

export interface Card {
  id: string
  deckId: string
  front: string // sentence in the user's native language (prompt)
  back: string // expected sentence in the target language
  sched: Sched
  // When front, back or deck last changed. Schedule changes set sched.updatedAt instead,
  // so sync can merge an edit on one device with a review on another.
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
  answer?: string // what the user typed or said
  answerMode?: AnswerMode // set only when spoken; missing means typed
  assessment?: ReviewAssessment // the LLM's suggestion, if it was checked; grade is the user's final say
}

// A record that something was deleted, so sync can delete it on other devices too
// instead of bringing it back. Kept forever; each is a few dozen bytes.
export interface Deletion {
  id: string // the deleted deck, card or review
  table: 'decks' | 'cards' | 'reviews'
  at: number // ms
}

// Everything sync merges: the whole database, deletion records included.
export interface Snapshot {
  decks: Deck[]
  cards: Card[]
  reviews: Review[]
  deletions: Deletion[]
}

export interface Backup {
  decks: Deck[]
  cards: Card[]
  reviews: Review[]
  deletions?: Deletion[] // missing in backups made before deletions were recorded
}

const db = new Dexie('fluency') as Dexie & {
  decks: EntityTable<Deck, 'id'>
  cards: EntityTable<Card, 'id'>
  reviews: EntityTable<Review, 'id'>
  deletions: EntityTable<Deletion, 'id'>
}

// Only indexed fields are listed. Add a new version() block for schema changes.
db.version(1).stores({
  decks: 'id',
  cards: 'id, deckId, [deckId+sched.due]',
  reviews: 'id, cardId, at',
})
db.version(2).stores({ deletions: 'id' })

// Records deletions; call inside the transaction that deletes, so both happen or neither.
const recordDeletions = (table: Deletion['table'], ids: string[]) => {
  const at = Date.now()
  return db.deletions.bulkPut(ids.map((id) => ({ id, table, at })))
}

const newId = () => crypto.randomUUID()

// Every user write goes through this, so Drive sync knows something changed (changes.ts).
// Sync's own writes (applyMerge) don't.
const changed = <T>(write: PromiseLike<T>): Promise<T> =>
  Promise.resolve(write).then((value) => {
    noteChange()
    return value
  })

// Marks a schedule as changed now. The scheduler copies the old schedule into the new
// one, so every write of a schedule goes through this.
const stamp = <S extends Sched>(sched: S, at = Date.now()): S => ({ ...sched, updatedAt: at })

// New cards start with an SM-2 schedule; under FSRS, Study converts them before use.
export const newSched = (now = Date.now()): Sm2Sched => ({
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

export async function addDeck(
  name: string,
  languages?: Pick<Deck, 'sourceLanguage' | 'targetLanguage'>,
  id: string = newId(), // fixed for sample decks, so devices that sync share them
): Promise<Deck> {
  const deck = { id, name, ...languages, updatedAt: Date.now() }
  await changed(db.decks.add(deck))
  return deck
}

export const renameDeck = (id: string, name: string) =>
  changed(db.decks.update(id, { name, updatedAt: Date.now() }))

export const setDeckLanguages = (id: string, sourceLanguage: string, targetLanguage: string) =>
  changed(db.decks.update(id, { sourceLanguage, targetLanguage, updatedAt: Date.now() }))

export const deleteDeck = (id: string) =>
  changed(
    db.transaction('rw', [db.decks, db.cards, db.reviews, db.deletions], async () => {
      const cardIds = await db.cards.where('deckId').equals(id).primaryKeys()
      const reviewIds = await db.reviews.where('cardId').anyOf(cardIds).primaryKeys()
      await db.reviews.bulkDelete(reviewIds)
      await db.cards.bulkDelete(cardIds)
      await db.decks.delete(id)
      await recordDeletions('reviews', reviewIds)
      await recordDeletions('cards', cardIds)
      await recordDeletions('decks', [id])
    }),
  )

// --- Cards ---

export const listCards = (deckId: string) => db.cards.where('deckId').equals(deckId).toArray()

export async function addCard(deckId: string, front: string, back: string, id: string = newId()): Promise<Card> {
  const now = Date.now()
  const card = { id, deckId, front, back, sched: stamp(newSched(now), now), updatedAt: now }
  await changed(db.cards.add(card))
  return card
}

export const editCard = (id: string, front: string, back: string) =>
  changed(db.cards.update(id, { front, back, updatedAt: Date.now() }))

export const deleteCard = (id: string) =>
  changed(
    db.transaction('rw', [db.cards, db.reviews, db.deletions], async () => {
      const reviewIds = await db.reviews.where('cardId').equals(id).primaryKeys()
      await db.reviews.bulkDelete(reviewIds)
      await db.cards.delete(id)
      await recordDeletions('reviews', reviewIds)
      await recordDeletions('cards', [id])
    }),
  )

const dueCards = (deckId: string, now: number) =>
  db.cards.where('[deckId+sched.due]').between([deckId, Dexie.minKey], [deckId, now], true, true)

// Cards due for review, soonest first.
export const getDueCards = (deckId: string, now = Date.now(), limit = 20) =>
  dueCards(deckId, now).limit(limit).toArray()

export const countDueCards = (deckId: string, now = Date.now()) => dueCards(deckId, now).count()

// --- Reviews ---

// Log an attempt and store the card's new schedule atomically.
// The caller (scheduler) computes `sched` from the grade.
export const recordReview = (
  card: Card,
  grade: Grade,
  sched: Sched,
  extra: { answer?: string; answerMode?: AnswerMode; assessment?: ReviewAssessment } = {},
) =>
  changed(
    db.transaction('rw', db.cards, db.reviews, async () => {
      const now = Date.now()
      const id = newId()
      await db.reviews.add({ id, cardId: card.id, at: now, grade, ...extra })
      await db.cards.update(card.id, { sched: stamp(sched, now) })
      return id
    }),
  )

// Take back a review or skip: restore the card's old schedule and drop the review, if any.
export const undoAttempt = (cardId: string, sched: Sched, reviewId?: string) =>
  changed(
    db.transaction('rw', [db.cards, db.reviews, db.deletions], async () => {
      if (reviewId) {
        await db.reviews.delete(reviewId)
        // It may already have been synced to another device.
        await recordDeletions('reviews', [reviewId])
      }
      await db.cards.update(cardId, { sched: stamp(sched) })
    }),
  )

// Skip: not a review, so no history entry. The caller (scheduler) computes `sched`.
export const skipCard = (card: Card, sched: Sched) =>
  changed(db.cards.update(card.id, { sched: stamp(sched) }))

// Recompute schedules from review history, e.g. after switching algorithm. `cardIds`
// limits it to those cards; returns how many cards were updated.
export const rebuildSchedules = (rebuild: (card: Card, reviews: Review[]) => Sched, cardIds?: string[]) =>
  changed(
    db.transaction('rw', db.cards, db.reviews, async () => {
      const cards = cardIds ? (await db.cards.bulkGet(cardIds)).filter((card) => card !== undefined) : await db.cards.toArray()
      const reviews = cardIds ? await db.reviews.where('cardId').anyOf(cardIds).toArray() : await db.reviews.toArray()
      const byCard = new Map<string, Review[]>()
      for (const review of reviews) {
        const list = byCard.get(review.cardId)
        if (list) list.push(review)
        else byCard.set(review.cardId, [review])
      }
      const now = Date.now()
      await db.cards.bulkPut(cards.map((card) => ({ ...card, sched: stamp(rebuild(card, byCard.get(card.id) ?? []), now) })))
      return cards.length
    }),
  )

// Development only (demo history): add past reviews in bulk.
export const addReviews = (reviews: Review[]) => changed(db.reviews.bulkAdd(reviews))

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
  db.transaction('r', [db.decks, db.cards, db.reviews, db.deletions], async () => ({
    decks: await db.decks.toArray(),
    cards: await db.cards.toArray(),
    reviews: await db.reviews.toArray(),
    deletions: await db.deletions.toArray(),
  }))

export const listDeletions = () => db.deletions.toArray()

// --- Sync ---

const readSnapshot = async (): Promise<Snapshot> => ({
  decks: await db.decks.toArray(),
  cards: await db.cards.toArray(),
  reviews: await db.reviews.toArray(),
  deletions: await db.deletions.toArray(),
})

// The whole database at one moment.
export const snapshot = () => db.transaction('r', [db.decks, db.cards, db.reviews, db.deletions], readSnapshot)

// Writes a merge result over `before` (a snapshot read earlier), changing only what
// differs, in one transaction. If anything changed since `before` was read (say, a
// review recorded during the sync), it writes nothing and returns false, and the caller
// merges again; otherwise the newer change would be overwritten.
export const applyMerge = (before: Snapshot, result: Snapshot) =>
  db.transaction('rw', [db.decks, db.cards, db.reviews, db.deletions], async () => {
    if (canonical(sortSnapshot(await readSnapshot())) !== canonical(sortSnapshot(before))) return false
    const write = async <T extends { id: string }>(table: EntityTable<T, 'id'>, old: T[], next: T[]) => {
      const previous = new Map(old.map((item) => [item.id, canonical(item)]))
      const keep = new Set(next.map((item) => item.id))
      await table.bulkPut(next.filter((item) => previous.get(item.id) !== canonical(item)))
      await table.bulkDelete(old.filter((item) => !keep.has(item.id)).map((item) => item.id as IDType<T, 'id'>))
    }
    await write(db.decks, before.decks, result.decks)
    await write(db.cards, before.cards, result.cards)
    await write(db.reviews, before.reviews, result.reviews)
    await write(db.deletions, before.deletions, result.deletions)
    return true
  })

// Replaces the entire local database, deletion records included.
export const importAll = (data: Backup) =>
  changed(
    db.transaction('rw', [db.decks, db.cards, db.reviews, db.deletions], async () => {
      await Promise.all([db.decks.clear(), db.cards.clear(), db.reviews.clear(), db.deletions.clear()])
      await db.decks.bulkAdd(data.decks)
      await db.cards.bulkAdd(data.cards)
      await db.reviews.bulkAdd(data.reviews)
      await db.deletions.bulkAdd(data.deletions ?? [])
    }),
  )

// Ask the browser not to evict our data under storage pressure (matters on iOS/Safari).
export const requestPersistentStorage = () => navigator.storage?.persist?.()
