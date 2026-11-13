import { describe, expect, it, vi } from 'vitest'
import { Session, type Grader } from './check'
import { newSched, type Card } from './db'
import type { Assessment } from './grader'
import { HandsFree, parseCommand } from './handsFree'
import { abortError, SpeechError, type Heard, type VoiceSettings } from './speech'

const NOW = 1_000_000_000_000
const HINT = 'Say good, fair or bad.'

const makeCard = (id: string): Card => ({ id, deckId: 'deck', front: `front ${id}`, back: `back ${id}`, sched: newSched(NOW), updatedAt: NOW })

const assessment = (grade: 1 | 2 | 3, extra: Partial<Assessment> = {}): Assessment => ({
  grade,
  summary: 'summary',
  errors: [],
  suggestions: [],
  corrected: 'x',
  ...extra,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve))
}

// A hands-free loop over a real Session with mocked I/O. Every listen waits until the
// test replies; speech resolves at once unless the test holds a text.
function setup({ cards = [makeCard('a'), makeCard('b')], grading = true, voice = {} as Partial<VoiceSettings> } = {}) {
  const assessCalls: ReturnType<typeof deferred<{ assessment: Assessment }>>[] = []
  const grader: Grader = {
    model: 'test-model',
    context: { sourceLanguage: 'en', targetLanguage: 'es', feedbackLanguage: 'en', gradingRules: '' },
    assess: () => {
      const result = deferred<{ assessment: Assessment }>()
      assessCalls.push(result)
      return result.promise
    },
  }
  const online = { value: true }
  const deps = {
    grader: () => (grading ? grader : null),
    isOnline: () => online.value,
    now: () => NOW,
    recordReview: vi.fn(async () => 'review'),
    skipCard: vi.fn(async () => {}),
    undoAttempt: vi.fn(async () => {}),
    editCard: vi.fn(async () => {}),
  }
  const session = new Session(deps)
  session.load(cards)

  const spoken: string[] = []
  const held = new Map<string, Promise<void>>()
  const speak = vi.fn(async (text: string, _lang: string, options: { rate?: number; signal: AbortSignal }) => {
    spoken.push(text)
    await held.get(text)
    if (options.signal.aborted) throw abortError()
  })
  const listens: { result: ReturnType<typeof deferred<Heard>>; signal: AbortSignal }[] = []
  const listen = vi.fn((options: { signal: AbortSignal }) => {
    const result = deferred<Heard>()
    options.signal.addEventListener('abort', () => result.reject(abortError()))
    listens.push({ result, signal: options.signal })
    return { result: result.promise, finish() {} }
  })
  const release = vi.fn()
  const keepAwake = vi.fn(() => release)
  const handsFree = new HandsFree({
    session,
    languages: () => ({ source: 'en', target: 'es', feedback: 'en' }),
    speak,
    listen,
    settings: () => ({ rate: 1, otherRate: 1, spokenFeedback: 'short' as const, confirmGrade: false, ...voice }),
    keepAwake,
  })

  // Answer the pending listen with `text` and let the loop run on.
  const reply = async (text: string) => {
    await settle()
    const pending = listens.at(-1)
    if (!pending || pending.signal.aborted) throw new Error(`nothing is listening for "${text}"`)
    pending.result.resolve({ text, alternatives: text ? [text] : [] })
    await settle()
  }
  const phase = () => handsFree.getState().phase
  return { session, deps, assessCalls, online, spoken, held, speak, listens, release, keepAwake, handsFree, reply, phase }
}

describe('parseCommand', () => {
  it('matches whole phrases, ignoring case and punctuation', () => {
    expect(parseCommand(['Good.'])).toEqual({ grade: 3 })
    expect(parseCommand(['Skip!'])).toBe('skip')
    expect(parseCommand(['OK!'])).toBe('accept')
    expect(parseCommand(['Go back'])).toBe('undo')
    expect(parseCommand(['good morning'])).toBeNull()
    expect(parseCommand([])).toBeNull()
    expect(parseCommand([''])).toBeNull()
  })

  it('accepts digits and common mishearings', () => {
    expect(parseCommand(['3'])).toEqual({ grade: 3 })
    expect(parseCommand(['to'])).toEqual({ grade: 2 })
    expect(parseCommand(['fare'])).toEqual({ grade: 2 })
    expect(parseCommand(['won'])).toEqual({ grade: 1 })
  })

  it('takes the first alternative that is a command', () => {
    expect(parseCommand(['bat', 'bad'])).toEqual({ grade: 1 })
  })
})

describe('HandsFree', () => {
  it('runs a card: prompt, spoken answer, then the LLM grade, without asking', async () => {
    const { session, deps, assessCalls, spoken, handsFree, reply, phase } = setup()
    handsFree.start()
    await reply('mi respuesta')
    expect(session.current).toMatchObject({ answer: 'mi respuesta', answerMode: 'spoken', revealed: true })
    expect(phase()).toBe('waiting')
    assessCalls[0].resolve({ assessment: assessment(3) })
    await settle()
    expect(deps.recordReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 3, expect.anything(), expect.objectContaining({ answerMode: 'spoken' }))
    expect(spoken).toEqual(['front a', 'Good.', 'front b'])
    expect(phase()).toBe('listening-answer')
  })

  it('below Good, reads the reference before moving on, with the feedback still on screen', async () => {
    const { session, deps, assessCalls, spoken, held, handsFree, reply } = setup()
    const reading = deferred<void>()
    held.set('back a', reading.promise)
    handsFree.start()
    await reply('la casa es blanco')
    assessCalls[0].resolve({ assessment: assessment(2, { errors: [{ kind: 'grammar', note: 'n' }], corrected: 'La casa es blanca.' }) })
    await settle()
    expect(session.current).toMatchObject({ key: expect.anything(), revealed: true })
    expect(deps.recordReview).not.toHaveBeenCalled()
    reading.resolve()
    await settle()
    expect(spoken).toEqual(['front a', 'Fair.', 'back a', 'front b'])
    expect(deps.recordReview).toHaveBeenCalledWith(expect.anything(), 2, expect.anything(), expect.anything())
  })

  it('a grade tapped while the grade is said moves on without grading twice', async () => {
    const { session, deps, assessCalls, spoken, held, handsFree, reply } = setup()
    const saying = deferred<void>()
    held.set('Good.', saying.promise)
    handsFree.start()
    await reply('mi respuesta')
    assessCalls[0].resolve({ assessment: assessment(3) })
    await settle()
    await session.grade(1)
    saying.resolve()
    await settle()
    expect(deps.recordReview).toHaveBeenCalledTimes(1)
    expect(deps.recordReview).toHaveBeenCalledWith(expect.anything(), 1, expect.anything(), expect.anything())
    expect(spoken.at(-1)).toBe('front b')
  })

  it('minimal feedback says the grade only', async () => {
    const { assessCalls, spoken, handsFree, reply } = setup({ voice: { spokenFeedback: 'minimal' } })
    handsFree.start()
    await reply('mi respuesta')
    assessCalls[0].resolve({ assessment: assessment(1) })
    await settle()
    expect(spoken).toEqual(['front a', 'Bad.', 'front b'])
  })

  it('full feedback reads the reference, a spoken answer, the correction and the summary', async () => {
    const { assessCalls, spoken, handsFree, reply } = setup({ voice: { spokenFeedback: 'full' } })
    handsFree.start()
    await reply('la casa es blanco')
    assessCalls[0].resolve({ assessment: assessment(2, { errors: [{ kind: 'grammar', note: 'n' }], corrected: 'La casa es blanca.' }) })
    await settle()
    expect(spoken).toEqual(['front a', 'Fair.', 'back a', 'You said:', 'la casa es blanco', 'Corrected:', 'La casa es blanca.', 'summary', 'front b'])
  })

  it('with confirmGrade, suggests the grade, takes "yes" and offers undo', async () => {
    const { session, deps, assessCalls, spoken, handsFree, reply } = setup({ voice: { confirmGrade: true } })
    handsFree.start()
    await reply('mi respuesta')
    assessCalls[0].resolve({ assessment: assessment(3) })
    await settle()
    expect(deps.recordReview).not.toHaveBeenCalled()
    await reply('yes')
    expect(deps.recordReview).toHaveBeenCalledWith(expect.anything(), 3, expect.anything(), expect.anything())
    await reply('undo')
    expect(session.getState()).toMatchObject({ index: 0, history: [] })
    expect(spoken).toEqual(['front a', 'Suggested: Good.', 'Good.', 'Suggested: Good.'])
  })

  it('with confirmGrade, hints at "yes", and says when only "undo" is listened for', async () => {
    const { assessCalls, spoken, handsFree, reply, phase } = setup({ voice: { confirmGrade: true } })
    handsFree.start()
    await reply('mi respuesta')
    assessCalls[0].resolve({ assessment: assessment(2) })
    await reply('banana')
    expect(spoken.at(-1)).toBe('Say yes, or good, fair or bad.')
    await reply('good')
    expect(phase()).toBe('listening-undo')
  })

  it('reads target-language text at its own rate and the rest at the other', async () => {
    const { assessCalls, speak, handsFree, reply } = setup({ voice: { rate: 0.7, otherRate: 1.4 } })
    handsFree.start()
    await reply('mi respuesta')
    assessCalls[0].resolve({ assessment: assessment(2) })
    await settle()
    const rates = Object.fromEntries(speak.mock.calls.map(([text, , options]) => [text, options.rate]))
    expect(rates).toEqual({ 'front a': 1.4, 'Fair.': 1.4, 'back a': 0.7, 'front b': 1.4 })
  })

  it('without an LLM grade, reads the reference and asks for one', async () => {
    const { deps, spoken, handsFree, reply } = setup({ grading: false })
    handsFree.start()
    await reply('mi respuesta')
    await reply('yes')
    await reply('good')
    expect(spoken).toEqual(['front a', 'back a', HINT, HINT, 'Good.', 'front b'])
    expect(deps.recordReview).toHaveBeenCalledWith(expect.anything(), 3, expect.anything(), expect.anything())
  })

  it('a failed check says so and asks for a grade', async () => {
    const { assessCalls, spoken, handsFree, reply, phase } = setup()
    handsFree.start()
    await reply('mi respuesta')
    assessCalls[0].reject(new Error('boom'))
    await settle()
    expect(spoken.slice(1)).toEqual(['back a', "Couldn't check.", HINT])
    expect(phase()).toBe('listening-command')
  })

  it('never pays for a check on an idle slot', async () => {
    const { assessCalls, online, spoken, handsFree, reply } = setup()
    online.value = false
    handsFree.start()
    await reply('mi respuesta')
    expect(spoken.at(-1)).toBe(HINT)
    expect(assessCalls).toHaveLength(0)
  })

  it('on silence, reads the prompt again, then pauses', async () => {
    const { spoken, handsFree, reply, phase, release } = setup()
    handsFree.start()
    await reply('')
    await reply('')
    await reply('')
    expect(spoken).toEqual(['front a', 'front a'])
    expect(handsFree.getState()).toMatchObject({ phase: 'paused', message: "Didn't hear an answer." })
    expect(phase()).toBe('paused')
    expect(release).toHaveBeenCalled()
  })

  it('on unknown commands, gives the hint once, then pauses', async () => {
    const { handsFree, reply } = setup({ grading: false })
    handsFree.start()
    await reply('mi respuesta')
    await reply('banana')
    await reply('banana')
    expect(handsFree.getState()).toMatchObject({ phase: 'paused', message: "Didn't catch a command." })
  })

  it('a grade tapped while listening moves on to the next card', async () => {
    const { session, spoken, listens, handsFree, reply } = setup({ grading: false })
    handsFree.start()
    await reply('mi respuesta')
    const listening = listens.at(-1)!
    await session.grade(3)
    await settle()
    expect(listening.signal.aborted).toBe(true)
    expect(spoken.at(-1)).toBe('front b')
  })

  it('a typed submit while listening for the answer moves to the reveal', async () => {
    const { session, spoken, handsFree, phase } = setup({ grading: false })
    handsFree.start()
    await settle()
    session.setAnswer('typed')
    session.submit()
    await settle()
    expect(spoken).toEqual(['front a', 'back a', HINT])
    expect(phase()).toBe('listening-command')
  })

  it('"undo" on the next revealed card goes back and reads the card again', async () => {
    const { session, spoken, handsFree, reply } = setup({ grading: false })
    handsFree.start()
    await reply('mi respuesta')
    await reply('good')
    await reply('otra respuesta')
    await reply('undo')
    expect(session.getState()).toMatchObject({ index: 0, history: [] })
    expect(spoken.filter((text) => text === 'back a')).toHaveLength(2)
  })

  it('at the end, "undo" goes back; otherwise it stops', async () => {
    const { session, spoken, handsFree, reply, phase } = setup({ cards: [makeCard('a')], grading: false })
    handsFree.start()
    await reply('mi respuesta')
    await reply('good')
    expect(spoken.at(-1)).toBe('Done. Say undo to go back.')
    await reply('undo')
    expect(session.getState().index).toBe(0)
    expect(spoken.at(-1)).toBe(HINT)
    await reply('good')
    await reply('') // at the end again
    expect(phase()).toBe('off')
  })

  it('listens again when a command is refused because another write is running', async () => {
    const { session, deps, handsFree, reply, phase } = setup({ grading: false })
    const edit = deferred<void>()
    deps.editCard.mockReturnValueOnce(edit.promise)
    handsFree.start()
    await reply('mi respuesta')
    const saving = session.saveEdit('new front', 'new back')
    await reply('good')
    expect(deps.recordReview).not.toHaveBeenCalled()
    expect(phase()).toBe('listening-command')
    edit.resolve()
    await saving
    await reply('good')
    expect(deps.recordReview).toHaveBeenCalledTimes(1)
  })

  it('pauses when saving fails or speech fails', async () => {
    const failing = setup({ grading: false })
    failing.deps.recordReview.mockRejectedValueOnce(new Error('quota'))
    failing.handsFree.start()
    await failing.reply('mi respuesta')
    await failing.reply('good')
    expect(failing.handsFree.getState()).toMatchObject({ phase: 'paused', message: "Couldn't save." })

    const mute = setup()
    mute.speak.mockRejectedValueOnce(new SpeechError('no-voice', 'No voice.'))
    mute.handsFree.start()
    await settle()
    expect(mute.handsFree.getState()).toMatchObject({ phase: 'paused', message: 'No voice.' })
  })

  it('starts only after priming succeeds, and not if stopped meanwhile', async () => {
    const { handsFree, speak, release, keepAwake, phase } = setup()
    const priming = deferred<void>()
    void handsFree.start(() => priming.promise)
    void handsFree.start(() => priming.promise) // a double tap is ignored
    expect(phase()).toBe('starting')
    handsFree.stop()
    priming.resolve()
    await settle()
    expect(phase()).toBe('off')
    expect(speak).not.toHaveBeenCalled()
    expect(keepAwake).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('pauses with the error when priming fails', async () => {
    const { handsFree, speak } = setup()
    await handsFree.start(async () => {
      throw new SpeechError('not-allowed', 'Blocked.')
    })
    expect(handsFree.getState()).toMatchObject({ phase: 'paused', message: 'Blocked.' })
    expect(speak).not.toHaveBeenCalled()
  })

  it('"stop" while asking for a grade stops; a failed undo pauses', async () => {
    const stopping = setup({ grading: false })
    stopping.handsFree.start()
    await stopping.reply('mi respuesta')
    await stopping.reply('stop')
    expect(stopping.phase()).toBe('off')

    const failing = setup({ grading: false })
    failing.deps.undoAttempt.mockRejectedValueOnce(new Error('quota'))
    failing.handsFree.start()
    await failing.reply('mi respuesta')
    await failing.reply('good')
    await failing.reply('otra respuesta')
    await failing.reply('undo')
    expect(failing.handsFree.getState()).toMatchObject({ phase: 'paused', message: "Couldn't save." })
  })

  it('stopping during its own save ends the loop for good', async () => {
    for (const command of ['good', 'undo']) {
      const { deps, handsFree, listens, reply, phase } = setup({ grading: false })
      const write = deferred<string>()
      deps.recordReview.mockReturnValueOnce(command === 'good' ? write.promise : Promise.resolve('review'))
      const undo = deferred<void>()
      deps.undoAttempt.mockReturnValueOnce(undo.promise)
      handsFree.start()
      await reply('mi respuesta')
      if (command === 'undo') {
        await reply('good')
        await reply('otra respuesta')
      }
      await reply(command)
      handsFree.stop()
      write.resolve('review')
      undo.resolve()
      await settle()
      expect(phase(), command).toBe('off')
      expect(listens.every((listening) => listening.signal.aborted), command).toBe(true)
    }
  })

  it('says "Nothing to undo" even after an earlier failed save', async () => {
    const { session, deps, spoken, handsFree, reply, phase } = setup({ grading: false })
    deps.recordReview.mockRejectedValueOnce(new Error('quota'))
    handsFree.start()
    await reply('mi respuesta')
    await session.grade(3) // a tapped grade that fails to save; the loop keeps listening
    await reply('undo')
    expect(spoken.at(-1)).toBe('Nothing to undo.')
    expect(phase()).toBe('listening-command')
  })

  it('stop aborts what is running and releases the wake lock', async () => {
    const { listens, handsFree, release, phase } = setup()
    handsFree.start()
    await settle()
    handsFree.stop()
    expect(listens.at(-1)!.signal.aborted).toBe(true)
    expect(release).toHaveBeenCalled()
    expect(phase()).toBe('off')
  })
})
