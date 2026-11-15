import { describe, expect, it } from 'vitest'
import { DefaultScheduler, Rating } from 'ts-fsrs'
import { newSched, type Card, type FsrsSched } from './db'
import { createFsrs } from './fsrs'
import { createScheduler, isLearning, preview, skip, sm2Scheduler } from './scheduler'
import { DEFAULT_FSRS, type SchedulerSettings } from './schedulerSettings'
import { DAY, MINUTE } from './time'

const NOW = Date.UTC(2026, 0, 1)
const noFuzz = { ...DEFAULT_FSRS, enableFuzz: false }
const fsrsSettings: SchedulerSettings = { algorithm: 'fsrs', fsrs: noFuzz }
const card = (sched: Card['sched'] = newSched(NOW)): Card => ({ id: 'c1', deckId: 'd', front: 'f', back: 'b', sched, updatedAt: NOW })

describe('fsrs', () => {
  it('matches ts-fsrs for each grade on a new card', async () => {
    const fsrs = await createFsrs(noFuzz)
    const engine = await DefaultScheduler({ version: 'FSRS-6', enableFuzz: false, enableShortTerm: true })
    const fresh = fsrs.rebuild([], 'c1', NOW)
    for (const [grade, rating] of [[1, Rating.Again], [2, Rating.Hard], [3, Rating.Good]] as const) {
      const expected = engine.review({ card: engine.newCard({ now: new Date(NOW), cardId: 'c1' }), grade: rating, now: new Date(NOW) }).card
      const got = fsrs.schedule(fresh, 'c1', grade, NOW)
      expect(got).toMatchObject({ algo: 'fsrs', due: expected.dueAt.getTime(), stability: expected.stability, state: expected.state })
    }
  })

  it('round-trips its state through a review', async () => {
    const fsrs = await createFsrs(noFuzz)
    let sched: FsrsSched = fsrs.rebuild([], 'c1', NOW)
    // Good twice graduates a new card out of the 1m/10m learning steps.
    sched = fsrs.schedule(sched, 'c1', 3, NOW)
    expect(sched).toMatchObject({ state: 1, due: NOW + 10 * MINUTE, lastReview: NOW, reps: 1 })
    sched = fsrs.schedule(sched, 'c1', 3, sched.due)
    expect(sched.state).toBe(2)
    expect(sched.due - sched.lastReview!).toBeGreaterThanOrEqual(DAY)
    // A lapse sends it to relearning.
    const lapsed = fsrs.schedule(sched, 'c1', 1, sched.due)
    expect(lapsed).toMatchObject({ state: 3, lapses: 1 })
  })

  it('rebuild equals grading step by step, and keeps the due date without reviews', async () => {
    const fsrs = await createFsrs(noFuzz)
    const reviews = [
      { at: NOW + 3 * DAY, grade: 2 as const },
      { at: NOW, grade: 3 as const },
      { at: NOW + 10 * MINUTE, grade: 3 as const },
    ]
    let stepwise = fsrs.rebuild([], 'c1', NOW)
    for (const review of [...reviews].sort((a, b) => a.at - b.at)) stepwise = fsrs.schedule(stepwise, 'c1', review.grade, review.at)
    expect(fsrs.rebuild(reviews, 'c1', 0)).toEqual(stepwise)
    expect(fsrs.rebuild([], 'c1', NOW + 5)).toMatchObject({ state: 0, due: NOW + 5, reps: 0 })
  })

  it('applies the options', async () => {
    const strict = await createFsrs({ ...noFuzz, desiredRetention: 0.97 })
    const loose = await createFsrs({ ...noFuzz, desiredRetention: 0.8 })
    const graduate = (fsrs: typeof strict) => {
      const first = fsrs.schedule(fsrs.rebuild([], 'c1', NOW), 'c1', 3, NOW)
      return fsrs.schedule(first, 'c1', 3, first.due)
    }
    const interval = (s: FsrsSched) => s.due - s.lastReview!
    expect(interval(graduate(loose))).toBeGreaterThan(interval(graduate(strict)))

    const capped = await createFsrs({ ...noFuzz, maximumInterval: 2 })
    expect(interval(graduate(capped))).toBeLessThanOrEqual(2 * DAY)

    const noSteps = await createFsrs({ ...noFuzz, learningSteps: [] })
    expect(noSteps.schedule(noSteps.rebuild([], 'c1', NOW), 'c1', 3, NOW).state).toBe(2)
  })

  it('rejects invalid options', async () => {
    await expect(createFsrs({ ...noFuzz, weights: [1, 2, 3] })).rejects.toThrow()
  })
})

describe('scheduler', () => {
  it('converts a card from the other algorithm instead of failing', async () => {
    const fsrs = await createScheduler(fsrsSettings)
    expect(fsrs.matches(newSched(NOW))).toBe(false)
    expect(fsrs.schedule(card(), 3, NOW)).toMatchObject({ algo: 'fsrs', reps: 1 })
    const fsrsSched = fsrs.schedule(card(), 3, NOW)
    expect(sm2Scheduler.matches(fsrsSched)).toBe(false)
    expect(sm2Scheduler.schedule(card(fsrsSched), 3, NOW)).toMatchObject({ interval: 1, reps: 1 })
  })

  it('rebuilds a card for the active algorithm, in both directions', async () => {
    const fsrs = await createScheduler(fsrsSettings)
    const reviews = [
      { at: NOW, grade: 3 as const },
      { at: NOW + DAY, grade: 3 as const },
    ]
    expect(fsrs.rebuild(card(), reviews)).toMatchObject({ algo: 'fsrs', reps: 2 })
    expect(sm2Scheduler.rebuild(card(fsrs.rebuild(card(), reviews)), reviews)).toMatchObject({ interval: 3, reps: 2 })
  })

  it('isLearning and skip work for both shapes', async () => {
    const fsrs = await createScheduler(fsrsSettings)
    const failed = fsrs.schedule(card(), 1, NOW)
    expect(isLearning(failed)).toBe(true)
    expect(isLearning(sm2Scheduler.schedule(card(), 1, NOW))).toBe(true)
    expect(isLearning(sm2Scheduler.schedule(card(), 3, NOW))).toBe(false)
    expect(skip(failed, NOW)).toEqual({ ...failed, due: NOW + 3 * DAY })
  })

  it('preview gives the due date for each grade, matching schedule', async () => {
    const fsrs = await createScheduler({ algorithm: 'fsrs', fsrs: DEFAULT_FSRS }) // with fuzz
    const due = preview(fsrs, card(), NOW)
    for (const grade of [1, 2, 3] as const) expect(due[grade]).toBe(fsrs.schedule(card(), grade, NOW).due)
    expect(due[1]).toBeLessThan(due[3])
  })
})
