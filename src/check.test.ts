import { describe, expect, it, vi } from 'vitest'
import { failCheck, invalidateCheck, resolveCheck, Session, startCheck, type CheckRequest, type Grader, type Slot } from './check'
import { newSched, type Card } from './db'
import { PROMPT_VERSION, type Assessment } from './grader'
import { LlmError } from './llm'

const NOW = 1_000_000_000_000

const makeCard = (id: string): Card => ({ id, deckId: 'deck', front: `front ${id}`, back: `back ${id}`, sched: newSched(NOW), updatedAt: NOW })

const assessment = (grade: 1 | 2 | 3): Assessment => ({ grade, summary: 'ok', errors: [], suggestions: [], corrected: 'x' })

// A promise the test resolves or rejects by hand.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

// A session over the given cards with every I/O dependency mocked. Each call to
// `assess` and `recordReview` gets its own deferred promise, kept in order.
function setup(cards = [makeCard('a'), makeCard('b')]) {
  const assessCalls: { input: unknown; signal: AbortSignal; result: ReturnType<typeof deferred<{ assessment: Assessment }>> }[] = []
  const writes: ReturnType<typeof deferred<string>>[] = []
  const grader: Grader = {
    model: 'test-model',
    context: { sourceLanguage: 'en', targetLanguage: 'es', feedbackLanguage: 'en', gradingRules: '' },
    assess: (input, signal) => {
      const result = deferred<{ assessment: Assessment }>()
      assessCalls.push({ input, signal, result })
      return result.promise
    },
  }
  const online = { value: true }
  const deps = {
    grader: () => grader,
    isOnline: () => online.value,
    now: () => NOW,
    recordReview: vi.fn(() => {
      const write = deferred<string>()
      writes.push(write)
      return write.promise
    }),
    skipCard: vi.fn(async () => {}),
    undoAttempt: vi.fn(async () => {}),
    editCard: vi.fn(async () => {}),
  }
  const session = new Session(deps)
  session.load(cards)
  const current = () => session.current!
  // Answer and submit the current card.
  const answer = (text = 'mi respuesta') => {
    session.setAnswer(text)
    session.submit()
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve))
  return { session, deps, assessCalls, writes, online, current, answer, settle }
}

describe('check transitions', () => {
  const request: CheckRequest = {
    id: 7,
    model: 'm',
    promptVersion: 1,
    input: { sourceLanguage: 'en', targetLanguage: 'es', feedbackLanguage: 'en', gradingRules: '', source: 's', reference: 'r', answer: 'a' },
  }
  const slot: Slot = { key: 1, card: makeCard('a'), answer: 'a', answerMode: 'typed', revealed: true, check: { status: 'idle' } }
  const pending = startCheck(slot, request)

  it('applies a result only to the pending request with the same id', () => {
    expect(resolveCheck(pending, 7, assessment(3)).check.status).toBe('done')
    expect(resolveCheck(pending, 8, assessment(3))).toBe(pending)
    expect(failCheck(pending, 7, new LlmError('network', 'x')).check.status).toBe('error')
    expect(failCheck(pending, 8, new LlmError('network', 'x'))).toBe(pending)
  })

  it('drops results for an invalidated slot', () => {
    const idle = invalidateCheck(pending)
    expect(idle.check.status).toBe('idle')
    expect(resolveCheck(idle, 7, assessment(3))).toBe(idle)
  })
})

describe('Session', () => {
  it('submitting twice starts one request', () => {
    const { session, assessCalls, answer } = setup()
    answer()
    session.submit()
    session.check()
    expect(assessCalls).toHaveLength(1)
    expect(assessCalls[0].input).toMatchObject({ source: 'front a', reference: 'back a', answer: 'mi respuesta' })
  })

  it('does not check an empty answer', () => {
    const { assessCalls, answer, current } = setup()
    answer('  ')
    expect(assessCalls).toHaveLength(0)
    expect(current().revealed).toBe(true)
  })

  it('offline: no automatic request, but an explicit check works', () => {
    const { session, assessCalls, answer, online } = setup()
    online.value = false
    answer()
    expect(assessCalls).toHaveLength(0)
    session.check()
    expect(assessCalls).toHaveLength(1)
  })

  it('stores the assessment and its request snapshot with the review', async () => {
    const { session, deps, assessCalls, writes, answer, current, settle } = setup()
    answer()
    assessCalls[0].result.resolve({ assessment: assessment(2) })
    await settle()
    expect(current().check.status).toBe('done')
    const grading = session.accept()
    writes[0].resolve('review-1')
    await grading
    expect(deps.recordReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 2, expect.anything(), {
      answer: 'mi respuesta',
      assessment: expect.objectContaining({ grade: 2, model: 'test-model', promptVersion: PROMPT_VERSION, input: assessCalls[0].input }),
    })
    expect(session.getState().index).toBe(1)
  })

  it('grading while checking aborts the check and saves no assessment', async () => {
    const { session, deps, assessCalls, writes, answer, settle } = setup()
    answer()
    const grading = session.grade(3)
    expect(assessCalls[0].signal.aborted).toBe(true)
    writes[0].resolve('review-1')
    await grading
    // A reply that arrives anyway changes nothing.
    assessCalls[0].result.resolve({ assessment: assessment(1) })
    await settle()
    expect(deps.recordReview.mock.calls[0]).toContainEqual({ answer: 'mi respuesta', assessment: undefined })
    expect(session.getState().queue![0].check.status).toBe('idle')
  })

  it('a failed check shows the error and can be retried', async () => {
    const { session, assessCalls, answer, current, settle } = setup()
    answer()
    assessCalls[0].result.reject(new LlmError('auth', 'bad key'))
    await settle()
    expect(current().check).toMatchObject({ status: 'error', error: { kind: 'auth' } })
    session.check()
    expect(assessCalls).toHaveLength(2)
  })

  it('committing twice before the write resolves writes and advances once', async () => {
    const { session, deps, writes, answer } = setup()
    answer()
    const first = session.grade(3)
    const second = session.grade(3)
    writes[0].resolve('review-1')
    await Promise.all([first, second])
    expect(deps.recordReview).toHaveBeenCalledTimes(1)
    expect(session.getState().index).toBe(1)
  })

  it('refuses skip and undo while a grade is being written', async () => {
    const { session, deps, writes, answer } = setup()
    answer()
    const grading = session.grade(3)
    await session.skip()
    await session.undo()
    writes[0].resolve('review-1')
    await grading
    expect(deps.skipCard).not.toHaveBeenCalled()
    expect(deps.undoAttempt).not.toHaveBeenCalled()
    expect(session.getState()).toMatchObject({ index: 1, history: [expect.anything()] })
  })

  it('a failed write keeps the card and its feedback, and reports the error', async () => {
    const { session, assessCalls, writes, answer, current, settle } = setup()
    answer()
    assessCalls[0].result.resolve({ assessment: assessment(2) })
    await settle()
    const grading = session.accept()
    writes[0].reject(new Error('quota'))
    await grading
    expect(session.getState()).toMatchObject({ index: 0, history: [], writing: false, saveError: expect.any(String) })
    expect(current().check.status).toBe('done')
  })

  it('undo restores the previous card with its feedback, without a new request', async () => {
    const { session, assessCalls, writes, answer, current, settle } = setup()
    answer()
    assessCalls[0].result.resolve({ assessment: assessment(3) })
    await settle()
    const grading = session.accept()
    writes[0].resolve('review-1')
    await grading
    await session.undo()
    await session.undo() // nothing left to undo
    expect(session.getState().index).toBe(0)
    expect(current()).toMatchObject({ answer: 'mi respuesta', revealed: true, check: { status: 'done' } })
    expect(assessCalls).toHaveLength(1)
  })

  it('a failed card is requeued as a fresh attempt, and undo removes the copy', async () => {
    const { session, writes, answer, settle } = setup([makeCard('a')])
    answer()
    const grading = session.grade(1)
    writes[0].resolve('review-1')
    await grading
    const { queue } = session.getState()
    expect(queue).toHaveLength(2)
    expect(queue![1]).toMatchObject({ card: { id: 'a' }, answer: '', revealed: false, check: { status: 'idle' } })
    expect(queue![1].key).not.toBe(queue![0].key)
    await session.undo()
    await settle()
    expect(session.getState().queue).toHaveLength(1)
  })

  it('reports whether an edit was saved: not while another write runs, nor when it fails', async () => {
    const { session, deps, writes, answer } = setup()
    answer()
    const grading = session.grade(3)
    expect(await session.saveEdit('new front', 'new back')).toBe(false)
    expect(deps.editCard).not.toHaveBeenCalled()
    writes[0].resolve('review-1')
    await grading
    deps.editCard.mockRejectedValueOnce(new Error('quota'))
    expect(await session.saveEdit('new front', 'new back')).toBe(false)
    expect(await session.saveEdit('new front', 'new back')).toBe(true)
  })

  it('editing a card invalidates the checks of all its copies', async () => {
    const { session, deps, assessCalls, answer, current, settle } = setup()
    answer()
    assessCalls[0].result.resolve({ assessment: assessment(3) })
    await settle()
    await session.saveEdit('new front', 'new back')
    expect(deps.editCard).toHaveBeenCalledWith('a', 'new front', 'new back')
    expect(current()).toMatchObject({ card: { front: 'new front' }, check: { status: 'idle' } })
  })

  it('tracks a spoken answer through edits, sends it to the grader and stores it with the review', async () => {
    const { session, deps, assessCalls, writes, current } = setup()
    session.setAnswer('mi respuesta', 'spoken')
    session.setAnswer('mi respuesta.') // fixing a recognition error keeps it spoken
    expect(current().answerMode).toBe('spoken')
    session.setAnswer('')
    expect(current().answerMode).toBe('typed')
    session.setAnswer('hablado', 'spoken')
    session.submit()
    expect(assessCalls[0].input).toMatchObject({ answer: 'hablado', answerMode: 'spoken' })
    const grading = session.grade(3)
    writes[0].resolve('review-1')
    await grading
    expect(deps.recordReview).toHaveBeenCalledWith(expect.anything(), 3, expect.anything(), expect.objectContaining({ answerMode: 'spoken' }))
  })

  it('leaves answerMode out for typed answers', async () => {
    const { session, deps, assessCalls, writes, answer } = setup()
    answer()
    expect(assessCalls[0].input).not.toHaveProperty('answerMode')
    const grading = session.grade(3)
    writes[0].resolve('review-1')
    await grading
    expect(deps.recordReview.mock.calls[0]).not.toContainEqual(expect.objectContaining({ answerMode: expect.anything() }))
  })

  it('new retry copies start typed; a parked copy keeps its mode', async () => {
    const { session, writes, current, settle } = setup([makeCard('a')])
    session.setAnswer('x', 'spoken')
    session.submit()
    let grading = session.grade(1)
    writes[0].resolve('review-1')
    await grading
    expect(current()).toMatchObject({ answer: '', answerMode: 'typed' })
    session.setAnswer('otra vez', 'spoken')
    await session.undo() // parks the retry copy
    await settle()
    grading = session.grade(1)
    writes[1].resolve('review-2')
    await grading
    expect(current()).toMatchObject({ answer: 'otra vez', answerMode: 'spoken' })
  })

  it('ignores an answer or submit meant for another slot', () => {
    const { session, current } = setup()
    const key = current().key
    session.setAnswer('late', 'spoken', key + 100)
    session.submit(key + 100)
    expect(current()).toMatchObject({ answer: '', revealed: false })
    session.setAnswer('on time', 'spoken', key)
    session.submit(key)
    expect(current()).toMatchObject({ answer: 'on time', revealed: true })
  })

  it('grade, skip and undo report whether they wrote', async () => {
    const { session, deps, writes, answer } = setup()
    answer()
    const grading = session.grade(3)
    expect(await session.skip()).toBe(false)
    expect(await session.undo()).toBe(false)
    writes[0].resolve('review-1')
    expect(await grading).toBe(true)
    expect(await session.undo()).toBe(true)
    deps.skipCard.mockRejectedValueOnce(new Error('quota'))
    expect(await session.skip()).toBe(false)
    expect(await session.skip()).toBe(true)
  })
})

