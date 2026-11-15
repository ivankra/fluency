import { describe, expect, it } from 'vitest'
import { demoReviews } from './demoHistory'
import { DAY } from './time'

const NOW = Date.UTC(2026, 5, 1)

describe('demoReviews', () => {
  const reviews = demoReviews(['a', 'b', 'c'], NOW, 60)

  it('stays within the window and is repeatable', () => {
    expect(reviews.length).toBeGreaterThan(6)
    for (const review of reviews) {
      expect(review.at).toBeGreaterThanOrEqual(NOW - 60 * DAY)
      expect(review.at).toBeLessThan(NOW)
    }
    expect(demoReviews(['a', 'b', 'c'], NOW, 60).map((r) => [r.cardId, r.at, r.grade])).toEqual(
      reviews.map((r) => [r.cardId, r.at, r.grade]),
    )
  })

  it('covers every card with increasing times and a mix of grades', () => {
    for (const id of ['a', 'b', 'c']) {
      const times = reviews.filter((r) => r.cardId === id).map((r) => r.at)
      expect(times.length).toBeGreaterThan(1)
      expect(times).toEqual([...times].sort((x, y) => x - y))
    }
    const many = demoReviews(Array.from({ length: 30 }, (_, i) => `c${i}`), NOW, 60)
    expect(new Set(many.map((r) => r.grade))).toEqual(new Set([1, 2, 3]))
  })
})
