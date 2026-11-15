import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// db.ts opens the database on first use, so it is imported after the version-1
// database below exists, as it would on a device that installed an older version.
let db: typeof import('./db')

beforeAll(async () => {
  const old = new Dexie('fluency')
  old.version(1).stores({ decks: 'id', cards: 'id, deckId, [deckId+sched.due]', reviews: 'id, cardId, at' })
  await old.table('decks').add({ id: 'old-deck', name: 'Old', updatedAt: 1 })
  old.close()
  db = await import('./db')
})

describe('upgrade', () => {
  it('keeps existing data when the deletions table is added', async () => {
    expect((await db.exportAll()).decks.map((deck) => deck.id)).toEqual(['old-deck'])
    expect(await db.listDeletions()).toEqual([])
  })
})

describe('deletions', () => {
  // Two decks; deck A has two cards with reviews, deck B one card.
  async function seed() {
    await db.importAll({ decks: [], cards: [], reviews: [] })
    const a = await db.addDeck('A')
    const b = await db.addDeck('B')
    const a1 = await db.addCard(a.id, 'a1', 'x')
    const a2 = await db.addCard(a.id, 'a2', 'x')
    const b1 = await db.addCard(b.id, 'b1', 'x')
    const r1 = await db.recordReview(a1, 3, a1.sched)
    const r2 = await db.recordReview(a2, 1, a2.sched)
    const r3 = await db.recordReview(b1, 2, b1.sched)
    return { a, b, a1, a2, b1, r1, r2, r3 }
  }
  const deleted = async () =>
    (await db.listDeletions()).map(({ table, id }) => `${table}:${id}`).sort()

  beforeEach(async () => {
    await db.importAll({ decks: [], cards: [], reviews: [] })
  })

  it('records nothing for adding, editing, reviewing or skipping', async () => {
    const { a1 } = await seed()
    await db.editCard(a1.id, 'new', 'new')
    await db.skipCard(a1, a1.sched)
    await db.renameDeck(a1.deckId, 'Renamed')
    expect(await db.listDeletions()).toEqual([])
  })

  it('deleting a deck records the deck, its cards and their reviews', async () => {
    const { a, a1, a2, r1, r2, b1 } = await seed()
    const before = Date.now()
    await db.deleteDeck(a.id)
    expect(await deleted()).toEqual(
      [`decks:${a.id}`, `cards:${a1.id}`, `cards:${a2.id}`, `reviews:${r1}`, `reviews:${r2}`].sort(),
    )
    for (const deletion of await db.listDeletions()) expect(deletion.at).toBeGreaterThanOrEqual(before)
    // The other deck is untouched.
    const backup = await db.exportAll()
    expect(backup.cards.map((card) => card.id)).toEqual([b1.id])
    expect(backup.reviews).toHaveLength(1)
  })

  it('deleting a card records it and its reviews', async () => {
    const { a1, r1, a2 } = await seed()
    await db.deleteCard(a1.id)
    expect(await deleted()).toEqual([`cards:${a1.id}`, `reviews:${r1}`].sort())
    expect((await db.listCards(a2.deckId)).map((card) => card.id)).toEqual([a2.id])
  })

  it('undo records the review it removes, and nothing for an undone skip', async () => {
    const { a1, r1 } = await seed()
    await db.undoAttempt(a1.id, a1.sched)
    expect(await db.listDeletions()).toEqual([])
    await db.undoAttempt(a1.id, a1.sched, r1)
    expect(await deleted()).toEqual([`reviews:${r1}`])
    expect((await db.exportAll()).reviews.map((review) => review.id)).not.toContain(r1)
  })

  it('backups carry deletions; importing replaces them, and accepts older backups', async () => {
    const { a1 } = await seed()
    await db.deleteCard(a1.id)
    const backup = await db.exportAll()
    expect(backup.deletions).toHaveLength(2)

    await db.importAll({ decks: [], cards: [], reviews: [] }) // an older backup, without deletions
    expect(await db.listDeletions()).toEqual([])

    await db.importAll(backup)
    expect(await db.listDeletions()).toEqual(backup.deletions)
  })
})

describe('timestamps', () => {
  beforeEach(async () => {
    await db.importAll({ decks: [], cards: [], reviews: [] })
  })

  it('schedule changes stamp the schedule; text edits stamp the card', async () => {
    const deck = await db.addDeck('D')
    const card = await db.addCard(deck.id, 'f', 'b')
    expect(card.sched.updatedAt).toBe(card.updatedAt)
    const get = async () => (await db.listCards(deck.id))[0]

    await new Promise((resolve) => setTimeout(resolve, 5))
    await db.recordReview(card, 3, { ...card.sched, due: 123 })
    const reviewed = await get()
    expect(reviewed.updatedAt).toBe(card.updatedAt)
    expect(reviewed.sched.updatedAt).toBeGreaterThan(card.updatedAt)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await db.editCard(card.id, 'new', 'new')
    const edited = await get()
    expect(edited.updatedAt).toBeGreaterThan(reviewed.updatedAt)
    expect(edited.sched.updatedAt).toBe(reviewed.sched.updatedAt)

    // The schedule passed in may carry an old stamp (the scheduler copies it); it's replaced.
    await db.skipCard(edited, { ...edited.sched, updatedAt: 1 })
    expect((await get()).sched.updatedAt).toBeGreaterThan(1)
  })
})

describe('snapshot and applyMerge', () => {
  beforeEach(async () => {
    await db.importAll({ decks: [], cards: [], reviews: [] })
  })

  it('writes only the differences and returns true', async () => {
    const keep = await db.addDeck('Keep')
    const drop = await db.addDeck('Drop')
    const before = await db.snapshot()
    const result = {
      ...before,
      decks: [{ ...keep, name: 'Renamed elsewhere' }, { id: 'new', name: 'New', updatedAt: 1 }],
      deletions: [{ id: drop.id, table: 'decks' as const, at: 1 }],
    }
    expect(await db.applyMerge(before, result)).toBe(true)
    const after = await db.snapshot()
    expect(after.decks.map((d) => d.name).sort()).toEqual(['New', 'Renamed elsewhere'])
    expect(after.deletions).toEqual(result.deletions)
  })

  it('writes nothing if the database changed since the snapshot', async () => {
    const deck = await db.addDeck('D')
    const card = await db.addCard(deck.id, 'f', 'b')
    const before = await db.snapshot()
    await db.recordReview(card, 3, card.sched) // e.g. studied while the sync was downloading
    const changed = await db.snapshot()
    expect(await db.applyMerge(before, { ...before, decks: [] })).toBe(false)
    expect(await db.snapshot()).toEqual(changed)
  })
})

describe('sample decks', () => {
  it('get the same ids on every device', async () => {
    const store = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage
    await db.importAll({ decks: [], cards: [], reviews: [] })
    const { seedSampleDecks } = await import('./sampleDecks')
    await seedSampleDecks()
    const { decks, cards } = await db.snapshot()
    expect(decks.map((d) => d.id).sort()).toEqual(['sample-es', 'sample-ja', 'sample-zh-CN'])
    expect(cards.filter((c) => c.deckId === 'sample-es').map((c) => c.id)).toContain('sample-es-1')
    expect(cards).toHaveLength(30)
  })
})
