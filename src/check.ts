// Study session controller: the queue, LLM checks and every database write.
// Plain code with its I/O injected, so it is tested without React (check.test.ts);
// the Study screen only renders its state and calls its actions.
import type { Card, Grade, Sched } from './db'
import { PROMPT_VERSION, type AnswerMode, type Assessment, type GradingInput, type ReviewAssessment } from './grader'
import { LlmError } from './llm'
import { schedule, skip } from './scheduler'

// A failed card is requeued this many times at most per session, so it can't loop forever.
export const MAX_RETRIES = 2

// Snapshot taken when a check starts; review metadata comes from here.
export interface CheckRequest {
  id: number
  input: GradingInput
  model: string
  promptVersion: number
}

export type Check =
  | { status: 'idle' } // not requested, or invalidated
  | { status: 'pending'; request: CheckRequest }
  | { status: 'done'; request: CheckRequest; assessment: Assessment; returnedModel?: string }
  | { status: 'error'; request: CheckRequest; error: LlmError }

// A queue entry. Retry copies of a card are separate entries with their own key.
export interface Slot {
  key: number
  card: Card
  answer: string
  answerMode: AnswerMode // 'spoken' once any part of the answer was dictated
  revealed: boolean
  check: Check
}

// --- Pure check transitions ---

const IDLE: Check = { status: 'idle' }

export const startCheck = (slot: Slot, request: CheckRequest): Slot => ({
  ...slot,
  check: { status: 'pending', request },
})

// A result applies only to the request that is still pending on the slot.
export function resolveCheck(slot: Slot, id: number, assessment: Assessment, returnedModel?: string): Slot {
  if (slot.check.status !== 'pending' || slot.check.request.id !== id) return slot
  return { ...slot, check: { status: 'done', request: slot.check.request, assessment, returnedModel } }
}

export function failCheck(slot: Slot, id: number, error: LlmError): Slot {
  if (slot.check.status !== 'pending' || slot.check.request.id !== id) return slot
  return { ...slot, check: { status: 'error', request: slot.check.request, error } }
}

// Back to idle: drops a pending request's claim on the slot, or a finished result.
export const invalidateCheck = (slot: Slot): Slot => (slot.check.status === 'idle' ? slot : { ...slot, check: IDLE })

// --- Session controller ---

// Everything a check needs besides the card and the answer; null if grading can't run.
export interface Grader {
  model: string
  context: Pick<GradingInput, 'sourceLanguage' | 'targetLanguage' | 'feedbackLanguage' | 'gradingRules'>
  assess(input: GradingInput, signal: AbortSignal): Promise<{ assessment: Assessment; model?: string }>
}

export interface SessionDeps {
  grader(): Grader | null
  isOnline(): boolean
  now(): number
  recordReview(
    card: Card,
    grade: Grade,
    sched: Sched,
    extra: { answer?: string; answerMode?: AnswerMode; assessment?: ReviewAssessment },
  ): Promise<string>
  skipCard(card: Card, sched: Sched): Promise<unknown>
  undoAttempt(cardId: string, sched: Sched, reviewId?: string): Promise<unknown>
  editCard(id: string, front: string, back: string): Promise<unknown>
}

// A finished review or skip, kept so it can be undone.
interface Attempt {
  card: Card // as it was before, i.e. with the old schedule
  reviewId?: string
  requeuedKey?: number // the retry copy it appended
}

export interface SessionState {
  queue: Slot[] | null // null until loaded; a snapshot, so the order doesn't shift
  index: number
  history: Attempt[]
  writing: boolean // a database write is in flight; other writes are refused
  saveError: string | null
}

export class Session {
  private state: SessionState = { queue: null, index: 0, history: [], writing: false, saveError: null }
  private listeners = new Set<() => void>()
  private retries = new Map<string, number>()
  private parked: Slot | null = null // retry copy removed by undo, so its text returns if the card fails again
  private requests = new Map<number, AbortController>()
  private nextKey = 1
  private nextRequestId = 1

  constructor(private deps: SessionDeps) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getState = () => this.state

  get current(): Slot | undefined {
    return this.state.queue?.[this.state.index]
  }

  load(cards: Card[]) {
    this.dispose()
    this.retries.clear()
    this.parked = null
    this.set({
      queue: cards.map((card) => this.newSlot(card)),
      index: 0,
      history: [],
      writing: false,
      saveError: null,
    })
  }

  // Abort pending checks, e.g. when leaving the screen.
  dispose() {
    for (const controller of this.requests.values()) controller.abort()
    this.requests.clear()
    if (this.state.queue) this.set({ queue: this.state.queue.map(this.cancel) })
  }

  // A spoken answer stays spoken through later edits (fixing recognition errors), until
  // the field is cleared. With `key`, applies only if that slot is still the current
  // one, so a late transcript can't land on the next card.
  setAnswer(answer: string, mode: AnswerMode = 'typed', key?: number) {
    const slot = this.answerable(key)
    if (!slot) return
    const answerMode = !answer.trim() ? 'typed' : mode === 'spoken' ? 'spoken' : slot.answerMode
    this.updateSlot(slot.key, (current) => ({ ...current, answer, answerMode }))
  }

  // Freeze the answer and reveal the reference; check it if possible. Offline, the
  // automatic check is skipped, but an explicit check() still works. `key` as in setAnswer.
  submit(key?: number) {
    const slot = this.answerable(key)
    if (!slot) return
    this.updateSlot(slot.key, (current) => ({ ...current, revealed: true }))
    if (this.deps.isOnline()) this.check()
  }

  // Start a check of the current answer (also Retry after an error).
  check() {
    const slot = this.current
    const status = slot?.check.status
    if (!slot || !slot.revealed || !slot.answer.trim() || status === 'pending' || status === 'done') return
    const grader = this.deps.grader()
    if (!grader) return
    const request: CheckRequest = {
      id: this.nextRequestId++,
      model: grader.model,
      promptVersion: PROMPT_VERSION,
      input: {
        ...grader.context,
        source: slot.card.front,
        reference: slot.card.back,
        answer: slot.answer.trim(),
        ...(slot.answerMode === 'spoken' && { answerMode: 'spoken' as const }),
      },
    }
    const controller = new AbortController()
    this.requests.set(request.id, controller)
    this.updateSlot(slot.key, (current) => startCheck(current, request))
    grader
      .assess(request.input, controller.signal)
      .then(
        (result) =>
          this.updateSlot(slot.key, (current) => resolveCheck(current, request.id, result.assessment, result.model)),
        (failure) => {
          const error = failure instanceof LlmError ? failure : new LlmError('network', String(failure))
          this.updateSlot(slot.key, (current) => failCheck(current, request.id, error))
        },
      )
      .finally(() => this.requests.delete(request.id))
  }

  // Grade the current card; grading while a check is pending cancels it. Like skip()
  // and undo(), resolves to true only if the write was made.
  async grade(grade: Grade): Promise<boolean> {
    const slot = this.current
    if (!slot || this.state.writing) return false
    const { check } = slot
    const assessment: ReviewAssessment | undefined =
      check.status === 'done'
        ? {
            ...check.assessment,
            promptVersion: check.request.promptVersion,
            model: check.request.model,
            returnedModel: check.returnedModel,
            input: check.request.input,
          }
        : undefined
    this.updateSlot(slot.key, this.cancel)
    const card = slot.card
    const sched = schedule(card.sched, grade, this.deps.now())

    const answer = slot.answer.trim() || undefined
    return this.write(async () => {
      const reviewId = await this.deps.recordReview(card, grade, sched, {
        answer,
        ...(answer && slot.answerMode === 'spoken' && { answerMode: 'spoken' as const }),
        assessment,
      })
      // interval 0 means the card is back to (re)learning: show it again this session.
      let queue = this.state.queue!
      let requeuedKey: number | undefined
      const tries = this.retries.get(card.id) ?? 0
      if (sched.interval === 0 && tries < MAX_RETRIES) {
        this.retries.set(card.id, tries + 1)
        const kept = this.parked?.card.id === card.id ? this.parked : this.newSlot(card)
        this.parked = null
        requeuedKey = this.nextKey++
        queue = [...queue, { ...kept, key: requeuedKey, card: { ...card, sched } }]
      }
      this.set({
        queue,
        history: [...this.state.history, { card, reviewId, requeuedKey }],
        index: this.state.index + 1,
      })
    })
  }

  // Accept the LLM's suggested grade.
  async accept(): Promise<boolean> {
    const check = this.current?.check
    return check?.status === 'done' ? this.grade(check.assessment.grade) : false
  }

  async skip(): Promise<boolean> {
    const slot = this.current
    if (!slot || this.state.writing) return false
    this.updateSlot(slot.key, this.cancel)
    return this.write(async () => {
      await this.deps.skipCard(slot.card, skip(slot.card.sched, this.deps.now()))
      this.set({ history: [...this.state.history, { card: slot.card }], index: this.state.index + 1 })
    })
  }

  // Step back one attempt: restore the card's schedule, drop its review and retry copy.
  // The previous slot comes back as it was, feedback included, without a new request.
  async undo(): Promise<boolean> {
    const last = this.state.history.at(-1)
    if (!last || this.state.writing) return false
    return this.write(async () => {
      await this.deps.undoAttempt(last.card.id, last.card.sched, last.reviewId)
      const { index } = this.state
      let queue = this.state.queue!.map((slot, position) => (position === index ? this.cancel(slot) : slot))
      if (last.requeuedKey !== undefined) {
        this.parked = queue.find((slot) => slot.key === last.requeuedKey) ?? null
        queue = queue.filter((slot) => slot.key !== last.requeuedKey)
        this.retries.set(last.card.id, (this.retries.get(last.card.id) ?? 1) - 1)
      }
      this.set({ queue, history: this.state.history.slice(0, -1), index: index - 1 })
    })
  }

  // Edit the current card; every queued and parked copy is updated and its check
  // invalidated. Re-checking is explicit. Resolves to false if the edit wasn't saved.
  async saveEdit(front: string, back: string): Promise<boolean> {
    const slot = this.current
    if (!slot || this.state.writing) return false
    const id = slot.card.id
    return this.write(async () => {
      await this.deps.editCard(id, front, back)
      const edit = (copy: Slot): Slot =>
        copy.card.id !== id || (copy.card.front === front && copy.card.back === back)
          ? copy
          : { ...invalidateCheck(this.cancel(copy)), card: { ...copy.card, front, back } }
      if (this.parked) this.parked = edit(this.parked)
      this.set({ queue: this.state.queue!.map(edit) })
    })
  }

  // --- internals ---

  private newSlot(card: Card): Slot {
    return { key: this.nextKey++, card, answer: '', answerMode: 'typed', revealed: false, check: IDLE }
  }

  // The current slot if it still takes an answer (and is the slot `key`, if given).
  private answerable(key?: number): Slot | undefined {
    const slot = this.current
    return slot && !slot.revealed && (key === undefined || slot.key === key) ? slot : undefined
  }

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private updateSlot(key: number, update: (slot: Slot) => Slot) {
    const queue = this.state.queue
    if (queue) this.set({ queue: queue.map((slot) => (slot.key === key ? update(slot) : slot)) })
  }

  // Abort a pending check on the slot and set it back to idle; other states are kept.
  private cancel = (slot: Slot): Slot => {
    if (slot.check.status !== 'pending') return slot
    this.requests.get(slot.check.request.id)?.abort()
    return invalidateCheck(slot)
  }

  // One database write at a time. A failed write leaves the session where it was.
  // Resolves to true only if the write ran and succeeded.
  private async write(action: () => Promise<void>): Promise<boolean> {
    if (this.state.writing) return false
    this.set({ writing: true, saveError: null })
    try {
      await action()
      this.set({ writing: false })
      return true
    } catch {
      this.set({ writing: false, saveError: "Couldn't save. Try again." })
      return false
    }
  }
}
