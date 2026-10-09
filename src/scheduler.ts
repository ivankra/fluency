import { type Grade, type Sched } from './db'

const DAY = 86_400_000

// STUB: fixed one-day interval whatever the grade. Replace with SM-2 in the next commit;
// the signature is what Study relies on.
export function schedule(sched: Sched, _grade: Grade, now = Date.now()): Sched {
  return { ...sched, interval: 1, due: now + DAY, reps: sched.reps + 1 }
}
