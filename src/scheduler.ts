// The active scheduling algorithm behind one interface, so the study session doesn't
// know which one runs. SM-2 is in sm2.ts, FSRS in fsrs.ts. Design: doc/fsrs.md.
import type { Card, Grade, Sched } from './db'
import { createFsrs } from './fsrs'
import type { SchedulerSettings } from './schedulerSettings'
import * as sm2 from './sm2'
import { DAY } from './time'

const SKIP_DAYS = 3

export interface Scheduler {
  readonly algorithm: SchedulerSettings['algorithm']
  // Whether the card's schedule belongs to this algorithm. Cards that don't are rebuilt
  // from their history (rebuild) before they are studied.
  matches(sched: Sched): boolean
  schedule(card: Card, grade: Grade, now: number): Sched
  rebuild(card: Card, reviews: { at: number; grade: Grade }[]): Sched
}

// Hide a card for a few days without changing anything else about its schedule.
export const skip = <S extends Sched>(sched: S, now: number): S => ({ ...sched, due: now + SKIP_DAYS * DAY })

// New or failed and still in (re)learning: the session shows it again.
export const isLearning = (sched: Sched) =>
  sched.algo === 'fsrs' ? sched.state === 1 || sched.state === 3 : sched.interval === 0

export const sm2Scheduler: Scheduler = {
  algorithm: 'sm2',
  matches: (sched) => sched.algo !== 'fsrs',
  // A mismatched schedule here means rebuild was skipped; start the card over rather than fail.
  schedule: (card, grade, now) => sm2.schedule(card.sched.algo === 'fsrs' ? sm2.rebuild([], card.sched.due) : card.sched, grade, now),
  rebuild: (card, reviews) => sm2.rebuild(reviews, card.sched.due),
}

export async function createScheduler(settings: SchedulerSettings): Promise<Scheduler> {
  if (settings.algorithm === 'sm2') return sm2Scheduler
  const fsrs = await createFsrs(settings.fsrs)
  return {
    algorithm: 'fsrs',
    matches: (sched) => sched.algo === 'fsrs',
    schedule: (card, grade, now) =>
      fsrs.schedule(card.sched.algo === 'fsrs' ? card.sched : fsrs.rebuild([], card.id, card.sched.due), card.id, grade, now),
    rebuild: (card, reviews) => fsrs.rebuild(reviews, card.id, card.sched.due),
  }
}

// When the card would be due after each grade, for labels like "Good · 4d".
export const preview = (scheduler: Scheduler, card: Card, now: number): Record<Grade, number> => ({
  1: scheduler.schedule(card, 1, now).due,
  2: scheduler.schedule(card, 2, now).due,
  3: scheduler.schedule(card, 3, now).due,
})
