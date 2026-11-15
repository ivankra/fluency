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
