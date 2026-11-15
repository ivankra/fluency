import { describe, expect, it } from 'vitest'
import type { Card, Deck, Review, Snapshot } from './db'
import { canonical, merge, sortSnapshot } from './merge'
import { SAMPLE_DECKS } from './sampleDecks'
import { normalizeSampleDecks } from './sampleIdentity'

const spanish = SAMPLE_DECKS.find((deck) => deck.targetLanguage === 'es')!
const empty = (): Snapshot => ({ decks: [], cards: [], reviews: [], deletions: [] })

// A copy of the Spanish sample deck as an old install made it: random ids.
function oldSpanish(prefix: string, { skip = [] as number[], updatedAt = 1 } = {}): Snapshot {
  const deckId = `${prefix}-deck`
  const decks: Deck[] = [{ id: deckId, name: 'Spanish', sourceLanguage: 'en', targetLanguage: 'es', updatedAt }]
  const cards: Card[] = spanish.cards
    .map(([front, back], i): Card => ({
      id: `${prefix}-card-${i}`,
      deckId,
      front,
      back,
      updatedAt,
      sched: { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, updatedAt },
    }))
    .filter((_, i) => !skip.includes(i))
  return { ...empty(), decks, cards }
}
const review = (id: string, cardId: string): Review => ({ id, cardId, at: 5, grade: 3 })
const same = (a: Snapshot, b: Snapshot) => canonical(sortSnapshot(a)) === canonical(sortSnapshot(b))

describe('normalizeSampleDecks', () => {
  it('gives an old sample deck its fixed ids, moving reviews along', () => {
    const phone = oldSpanish('phone')
    phone.reviews.push(review('r1', 'phone-card-0'))
    const result = normalizeSampleDecks(phone)
    expect(result.decks.map((d) => d.id)).toEqual(['sample-es'])
    expect(result.cards.map((c) => c.id).sort()).toEqual(spanish.cards.map((_, i) => `sample-es-${i + 1}`).sort())
    expect(result.cards.every((c) => c.deckId === 'sample-es')).toBe(true)
    expect(result.reviews).toEqual([review('r1', 'sample-es-1')])
    expect(result.deletions.map((d) => d.id)).toContain('phone-deck')
  })

  it('makes two devices end up with one deck, keeping both review histories', () => {
    const phone = oldSpanish('phone', { updatedAt: 1 })
    phone.reviews.push(review('r-phone', 'phone-card-0'))
    const laptop = oldSpanish('laptop', { updatedAt: 2 })
    laptop.reviews.push(review('r-laptop', 'laptop-card-0'))
    const { result } = merge(normalizeSampleDecks(phone), normalizeSampleDecks(laptop))
    expect(result.decks.map((d) => d.id)).toEqual(['sample-es'])
    expect(result.cards).toHaveLength(spanish.cards.length)
    expect(result.reviews.map((r) => `${r.id}→${r.cardId}`).sort()).toEqual(['r-laptop→sample-es-1', 'r-phone→sample-es-1'])
  })

  it('a card removed on one device is removed on the other too', () => {
    const phone = oldSpanish('phone', { skip: [2] }) // deleted the third card
    const laptop = oldSpanish('laptop')
    for (const [a, b] of [[phone, laptop], [laptop, phone]]) {
      const { result } = merge(normalizeSampleDecks(a), normalizeSampleDecks(b))
      expect(result.cards.map((c) => c.id)).not.toContain('sample-es-3')
      expect(result.cards).toHaveLength(spanish.cards.length - 1)
    }
  })

  it('fixes duplicates that already synced: both copies on one device become one deck', () => {
    const phone = oldSpanish('phone', { skip: [2] })
    const laptop = oldSpanish('laptop')
    const both: Snapshot = { ...empty(), decks: [...phone.decks, ...laptop.decks], cards: [...phone.cards, ...laptop.cards] }
    const result = normalizeSampleDecks(both)
    expect(result.decks.map((d) => d.id)).toEqual(['sample-es'])
    expect(result.deletions.map((d) => d.id)).toContain('sample-es-3')
    expect(merge(result, empty()).result.cards).toHaveLength(spanish.cards.length - 1)
  })

  it('keeps cards the user added, and edits to shipped cards', () => {
    const phone = oldSpanish('phone')
    phone.cards.push({ ...phone.cards[0], id: 'mine', front: 'My own sentence', back: 'Mi frase' })
    phone.cards[1] = { ...phone.cards[1], back: 'edited', updatedAt: 9 }
    const result = merge(normalizeSampleDecks(phone), empty()).result
    expect(result.cards.find((c) => c.front === 'My own sentence')).toMatchObject({ id: 'sample-es~mine', deckId: 'sample-es' })
    expect(result.cards.find((c) => c.back === 'edited')).toMatchObject({ deckId: 'sample-es' })
  })

  it('leaves alone decks that are not sample decks, and is stable', () => {
    const renamed = oldSpanish('a')
    renamed.decks[0] = { ...renamed.decks[0], name: 'My Spanish' }
    const own: Snapshot = { ...empty(), decks: [{ id: 'own', name: 'Spanish', updatedAt: 1 }], cards: [{ ...oldSpanish('x').cards[0], id: 'own-1', deckId: 'own', front: 'Mine', back: 'Mío' }] }
    expect(normalizeSampleDecks(renamed)).toBe(renamed)
    expect(normalizeSampleDecks(own)).toBe(own)
    const once = normalizeSampleDecks(oldSpanish('b'))
    expect(same(normalizeSampleDecks(once), once)).toBe(true)
  })
})
