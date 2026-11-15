import { describe, expect, it } from 'vitest'
import type { Card, Deck, Deletion, Review, Snapshot } from './db'
import { canonical, merge } from './merge'

const deck = (id: string, updatedAt: number, name = id): Deck => ({ id, name, updatedAt })
const card = (id: string, deckId: string, updatedAt: number, front = id, schedAt?: number, due = 0): Card => ({
  id,
  deckId,
  front,
  back: 'b',
  updatedAt,
  sched: { due, interval: 0, ease: 2.5, reps: 0, lapses: 0, ...(schedAt !== undefined && { updatedAt: schedAt }) },
})
const review = (id: string, cardId: string, at = 1): Review => ({ id, cardId, at, grade: 3 })
const gone = (id: string, table: Deletion['table'], at: number): Deletion => ({ id, table, at })
const snap = (s: Partial<Snapshot>): Snapshot => ({ decks: [], cards: [], reviews: [], deletions: [], ...s })

describe('merge', () => {
  it('combines new items from both sides and reports which side changed', () => {
    const local = snap({ decks: [deck('d1', 1)], cards: [card('c1', 'd1', 1, 'c1', 1)] })
    const remote = snap({ decks: [deck('d1', 1), deck('d2', 2)], cards: [card('c1', 'd1', 1, 'c1', 1)], reviews: [review('r1', 'c1')] })
    const { result, localChanged, remoteChanged } = merge(local, remote)
    expect(result.decks.map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(result.reviews.map((r) => r.id)).toEqual(['r1'])
    expect([localChanged, remoteChanged]).toEqual([true, false])
    expect(merge(result, result)).toMatchObject({ localChanged: false, remoteChanged: false })
  })

  it('takes the newer deck', () => {
    const { result } = merge(snap({ decks: [deck('d1', 5, 'new')] }), snap({ decks: [deck('d1', 3, 'old')] }))
    expect(result.decks[0].name).toBe('new')
  })

  it('merges card text and schedule separately', () => {
    // Laptop: edited the text at 10. Phone: reviewed at 20, text unchanged since 1.
    const laptop = snap({ decks: [deck('d', 1)], cards: [card('c', 'd', 10, 'edited', 5, 100)] })
    const phone = snap({ decks: [deck('d', 1)], cards: [card('c', 'd', 1, 'original', 20, 999)] })
    const merged = merge(laptop, phone).result.cards[0]
    expect(merged.front).toBe('edited')
    expect(merged.sched.due).toBe(999)
    expect(merge(phone, laptop).result.cards[0]).toEqual(merged)
  })

  it("gives schedules saved before they had a timestamp the card's, once", () => {
    const older = snap({ decks: [deck('d', 1)], cards: [card('c', 'd', 5, 'x', undefined, 1)] })
    const newer = snap({ decks: [deck('d', 1)], cards: [card('c', 'd', 1, 'x', 8, 2)] })
    expect(merge(older, newer).result.cards[0].sched).toMatchObject({ due: 2, updatedAt: 8 })
    const { result, localChanged } = merge(older, older)
    expect(result.cards[0].sched.updatedAt).toBe(5)
    expect(localChanged).toBe(true) // written back once with the timestamp
    expect(merge(result, older).localChanged).toBe(false)
  })

  it('lets deletes win over later edits, keeping the earliest deletion', () => {
    const local = snap({ decks: [deck('d', 1)], cards: [card('c', 'd', 50, 'edited after the delete')] })
    const remote = snap({ decks: [deck('d', 1)], deletions: [gone('c', 'cards', 10)] })
    const { result } = merge(local, remote)
    expect(result.cards).toEqual([])
    expect(merge(result, snap({ deletions: [gone('c', 'cards', 4)] })).result.deletions).toEqual([gone('c', 'cards', 4)])
  })

  it('drops cards added to a deck deleted elsewhere, and reviews of deleted cards', () => {
    const phone = snap({ decks: [deck('d', 1)], cards: [card('c', 'd', 30)], reviews: [review('r', 'c')] })
    const laptop = snap({ deletions: [gone('d', 'decks', 20)] })
    const { result } = merge(phone, laptop)
    expect(result).toMatchObject({ decks: [], cards: [], reviews: [] })
    expect(result.deletions).toEqual([gone('c', 'cards', 20), gone('d', 'decks', 20), gone('r', 'reviews', 20)])
  })

  it('keeps unknown fields from newer app versions', () => {
    const remote = snap({ decks: [{ ...deck('d', 2), color: 'blue' } as Deck] })
    expect(merge(snap({ decks: [deck('d', 1)] }), remote).result.decks[0]).toMatchObject({ color: 'blue' })
  })
})

// Property checks over random histories. Each device's snapshot is consistent on its
// own, as a real database is: cards point at its decks, reviews at its cards, and
// nothing it has is also recorded as deleted. As in the app, a card always belongs to
// the deck it was created in, and a review to its card.
const DECK_OF: Record<string, string> = { c1: 'd1', c2: 'd2', c3: 'd1' }
const CARD_OF: Record<string, string> = { r1: 'c1', r2: 'c2', r3: 'c3', r4: 'c1' }

function randomSnapshot(random: () => number): Snapshot {
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]
  const time = () => Math.floor(random() * 4) // few values, so ties are common
  const decks = ['d1', 'd2'].filter(() => random() < 0.8).map((id) => deck(id, time(), pick(['a', 'b'])))
  const deletions: Deletion[] = ['d1', 'd2'].filter((id) => !decks.some((d) => d.id === id) && random() < 0.5).map((id) => gone(id, 'decks', time()))
  const cards = ['c1', 'c2', 'c3']
    .filter((id) => decks.some((d) => d.id === DECK_OF[id]) && random() < 0.8)
    .map((id) => card(id, DECK_OF[id], time(), pick(['x', 'y']), random() < 0.8 ? time() : undefined, time()))
  for (const id of ['c1', 'c2', 'c3']) if (!cards.some((c) => c.id === id) && random() < 0.3) deletions.push(gone(id, 'cards', time()))
  const reviews = ['r1', 'r2', 'r3', 'r4'].filter((id) => cards.some((c) => c.id === CARD_OF[id]) && random() < 0.7).map((id) => review(id, CARD_OF[id]))
  for (const id of ['r1', 'r2']) if (!reviews.some((r) => r.id === id) && random() < 0.3) deletions.push(gone(id, 'reviews', time()))
  return snap({ decks, cards, reviews, deletions })
}

function seeded(seed: number) {
  let state = seed
  return () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

// Deletion times can differ by merge order for cascaded deletions; they converge on the
// next merge because the earliest wins. Compare everything else exactly.
const items = (s: Snapshot) => canonical({ ...s, deletions: s.deletions.map((d) => d.id).sort() })

describe('merge properties', () => {
  const RUNS = 300

  it('gives the same result whichever side is local', () => {
    for (let run = 0; run < RUNS; run++) {
      const random = seeded(run + 1)
      const [a, b] = [randomSnapshot(random), randomSnapshot(random)]
      expect(canonical(merge(a, b).result), `run ${run}`).toBe(canonical(merge(b, a).result))
    }
  })

  it('is stable: merging a result again with either input changes nothing', () => {
    for (let run = 0; run < RUNS; run++) {
      const random = seeded(run + 1000)
      const [a, b] = [randomSnapshot(random), randomSnapshot(random)]
      const { result } = merge(a, b)
      for (const input of [a, b, result]) {
        const again = merge(result, input)
        expect(canonical(again.result), `run ${run}`).toBe(canonical(result))
        expect(again.localChanged, `run ${run}`).toBe(false)
      }
    }
  })

  it('three devices end up with the same items in any order of syncing', () => {
    for (let run = 0; run < RUNS; run++) {
      const random = seeded(run + 5000)
      const [a, b, c] = [randomSnapshot(random), randomSnapshot(random), randomSnapshot(random)]
      const left = merge(merge(a, b).result, c).result
      const right = merge(a, merge(b, c).result).result
      expect(items(left), `run ${run}`).toBe(items(right))
    }
  })
})
