import { describe, expect, it } from 'vitest'
import { newSched } from './db'
import { DAY, schedule } from './scheduler'

const NOW = 1_000_000_000_000
const review = (interval: number, ease = 2.5) => ({ ...newSched(NOW), interval, ease, reps: 3 })

describe('schedule', () => {
  it('graduates a new card to 1 day on fair or good', () => {
    for (const g of [2, 3] as const) {
      const s = schedule(newSched(NOW), g, NOW)
      expect(s).toMatchObject({ interval: 1, due: NOW + DAY, reps: 1, ease: 2.5, lapses: 0 })
    }
  })

  it('retries a failed new card in 10 minutes without counting a lapse', () => {
    const s = schedule(newSched(NOW), 1, NOW)
    expect(s).toMatchObject({ interval: 0, due: NOW + 600_000, lapses: 0, ease: 2.5 })
  })

  it('multiplies the interval by ease on good', () => {
    expect(schedule(review(10), 3, NOW)).toMatchObject({ interval: 25, due: NOW + 25 * DAY, ease: 2.5 })
  })

  it('grows slower and lowers ease on fair', () => {
    expect(schedule(review(10), 2, NOW)).toMatchObject({ interval: 12, ease: 2.35 })
  })

  it('always grows by at least a day', () => {
    expect(schedule(review(1), 2, NOW).interval).toBe(2)
    expect(schedule(review(1, 1.3), 3, NOW).interval).toBe(2)
  })

  it('lapses a review card on bad', () => {
    const s = schedule(review(10), 1, NOW)
    expect(s).toMatchObject({ interval: 0, due: NOW + 600_000, lapses: 1, ease: 2.3 })
  })

  it('does not penalise ease again while relearning', () => {
    const lapsed = schedule(review(10), 1, NOW)
    const again = schedule(lapsed, 1, NOW)
    expect(again).toMatchObject({ interval: 0, lapses: 1, ease: 2.3 })
    expect(schedule(lapsed, 3, NOW)).toMatchObject({ interval: 1, due: NOW + DAY })
  })

  it('never lets ease drop below 1.3', () => {
    expect(schedule(review(10, 1.35), 1, NOW).ease).toBe(1.3)
  })

  it('does not mutate its input', () => {
    const s = newSched(NOW)
    schedule(s, 3, NOW)
    expect(s).toEqual(newSched(NOW))
  })
})
