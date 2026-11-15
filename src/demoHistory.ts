// Development only: plausible past reviews for a deck, so FSRS and the scheduling
// settings can be tried without weeks of real study. Pure; the caller writes them.
import { newSched, type Grade, type Review } from './db'
import { schedule } from './sm2'
import { DAY, HOUR } from './time'

// Reviews for each card over the last `days` days, as if studied with SM-2. Whether
// each review is remembered follows a simple forgetting curve, so the grades are
// realistic enough for the schedulers.
export function demoReviews(cardIds: string[], now: number, days = 60, seed = 1): Review[] {
  let state = seed >>> 0 || 1
  const random = () => {
    // xorshift32: deterministic, so tests and demos are repeatable.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 2 ** 32
  }
  const reviews: Review[] = []
  for (const cardId of cardIds) {
    let at = now - days * DAY + Math.floor(random() * (days / 3)) * DAY + 9 * HOUR
    let sched = newSched(at)
    let stability = 1 + random() * 2 // days until recall drops to 90%
    let last = at
    while (at < now) {
      const elapsed = (at - last) / DAY
      const recalled = sched.reps === 0 || random() < Math.pow(0.9, elapsed / stability)
      const grade: Grade = !recalled ? 1 : random() < 0.25 ? 2 : 3
      reviews.push({ id: crypto.randomUUID(), cardId, at, grade })
      stability = recalled ? stability * (grade === 3 ? 2.5 : 1.6) : Math.max(0.5, stability * 0.4)
      last = at
      sched = schedule(sched, grade, at)
      // Studied at a random time of day, never in the future.
      at = Math.max(sched.due, at + HOUR) + Math.floor(random() * 6) * HOUR
    }
  }
  return reviews
}
