// FSRS through ts-fsrs (FSRS-6 model): converts between our stored FsrsSched (ms
// timestamps) and ts-fsrs cards (Dates), and maps our three grades to its ratings.
import { DefaultScheduler, Rating } from 'ts-fsrs'
import { Reschedule } from 'ts-fsrs/reschedule'
import type { FsrsSched, Grade } from './db'
import type { FsrsOptions } from './schedulerSettings'

// Easy is never used: the app has three grades.
const RATING = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good } as const satisfies Record<Grade, number>

type Engine = Awaited<ReturnType<typeof DefaultScheduler<'FSRS-6'>>>
type EngineCard = ReturnType<Engine['newCard']>

export interface Fsrs {
  schedule(sched: FsrsSched, cardId: string, grade: Grade, now: number): FsrsSched
  rebuild(reviews: { at: number; grade: Grade }[], cardId: string, due: number): FsrsSched
}

const toSched = (card: EngineCard): FsrsSched => ({
  algo: 'fsrs',
  due: card.dueAt.getTime(),
  stability: card.stability,
  difficulty: card.difficulty,
  state: card.state as FsrsSched['state'],
  learningStep: card.learningStep,
  scheduledDays: card.scheduledDays,
  lastReview: card.lastReviewAt ? card.lastReviewAt.getTime() : null,
  reps: card.reps,
  lapses: card.lapses,
})

// Throws if the options are invalid (ts-fsrs validates them); the settings screen relies
// on that to check user input.
export async function createFsrs(options: FsrsOptions): Promise<Fsrs> {
  const engine = await DefaultScheduler({
    version: 'FSRS-6',
    weights: options.weights ?? undefined,
    desiredRetention: options.desiredRetention,
    maximumInterval: options.maximumInterval,
    learningSteps: options.learningSteps,
    relearningSteps: options.relearningSteps,
    enableFuzz: options.enableFuzz,
    enableShortTerm: true,
  })

  const toCard = (sched: FsrsSched, cardId: string): EngineCard => ({
    ...engine.newCard({ now: new Date(sched.due), cardId }),
    dueAt: new Date(sched.due),
    stability: sched.stability,
    difficulty: sched.difficulty,
    state: sched.state,
    scheduleStatus: sched.state === 0 ? 'new' : sched.state === 2 ? 'review' : 'learning',
    learningStep: sched.learningStep,
    scheduledDays: sched.scheduledDays,
    lastReviewAt: sched.lastReview === null ? null : new Date(sched.lastReview),
    reps: sched.reps,
    lapses: sched.lapses,
  })

  return {
    schedule: (sched, cardId, grade, now) =>
      toSched(engine.review({ card: toCard(sched, cardId), grade: RATING[grade], now: new Date(now) }).card),

    rebuild(reviews, cardId, due) {
      if (!reviews.length) return toSched(engine.newCard({ now: new Date(due), cardId }))
      const history = reviews.map((review) => ({ rating: RATING[review.grade], reviewTime: new Date(review.at) }))
      const first = Math.min(...reviews.map((review) => review.at))
      const initialCard = engine.newCard({ now: new Date(first), cardId })
      return toSched(new Reschedule(engine).reschedule({ history, initialCard }).card)
    },
  }
}
