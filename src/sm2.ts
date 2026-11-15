// Simplified SM-2. Three grades (bad / fair / good), intervals in whole days.
//
// A card with `interval === 0` is new or relearning: it has no spaced interval yet.
// Failing a card sends it back to that state, due again in RELEARN_DELAY, so it
// returns in the same session (Study requeues it); the next success graduates it to 1 day.
import { newSched, type Grade, type Sm2Sched } from './db'
import { DAY, MINUTE } from './time'

const RELEARN_DELAY = 10 * MINUTE
const MIN_EASE = 1.3
const FAIR_FACTOR = 1.2 // interval multiplier for "fair"; "good" uses the card's ease
const EASE_DELTA: Record<Grade, number> = { 1: -0.2, 2: -0.15, 3: 0 }

export function schedule(sched: Sm2Sched, grade: Grade, now = Date.now()): Sm2Sched {
  const reps = sched.reps + 1

  if (sched.interval === 0) {
    if (grade === 1) return { ...sched, reps, due: now + RELEARN_DELAY }
    return { ...sched, reps, interval: 1, due: now + DAY }
  }

  const ease = Math.max(MIN_EASE, sched.ease + EASE_DELTA[grade])
  if (grade === 1) {
    return { ...sched, reps, ease, interval: 0, lapses: sched.lapses + 1, due: now + RELEARN_DELAY }
  }
  // Always grow by at least a day, even when the multiplier rounds back down.
  const factor = grade === 3 ? sched.ease : FAIR_FACTOR
  const interval = Math.max(sched.interval + 1, Math.round(sched.interval * factor))
  return { ...sched, reps, ease, interval, due: now + interval * DAY }
}

// Replays a card's reviews, oldest first. Without reviews the card is new, still due at `due`.
export function rebuild(reviews: { at: number; grade: Grade }[], due: number): Sm2Sched {
  if (!reviews.length) return newSched(due)
  const sorted = [...reviews].sort((a, b) => a.at - b.at)
  return sorted.reduce((sched, review) => schedule(sched, review.grade, review.at), newSched(sorted[0].at))
}
