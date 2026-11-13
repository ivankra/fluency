// Hands-free study: reads the card, listens to the answer, says the grade and moves on
// (or takes the grade as a spoken command when the answer wasn't checked). Drives the Session through its public actions,
// like the keyboard does. Speech I/O is injected, so it is tested without a browser
// (handsFree.test.ts). Design: doc/voice.md.
import type { Session, Slot } from './check'
import { GRADES, type Grade } from './db'
import { abortError, isAbort, SpeechError, type listen, type speak } from './speech'

const ENGLISH = 'en-US' // the UI language: commands and announcements
const HINT = 'Say good, fair or bad.'
const gradeLabel = (grade: Grade) => GRADES.find((entry) => entry.grade === grade)!.label

export type Command = { grade: Grade } | 'skip' | 'repeat' | 'undo' | 'stop'

// Whole phrases, including common mishearings and digits.
const PHRASES = new Map<string, Command>()
const phrases = (command: Command, words: string[]) => words.forEach((word) => PHRASES.set(word, command))
phrases({ grade: 3 }, ['good', 'three', '3'])
phrases({ grade: 2 }, ['fair', 'fare', 'two', '2', 'to', 'too'])
phrases({ grade: 1 }, ['bad', 'one', '1', 'won'])
phrases('skip', ['skip'])
phrases('repeat', ['repeat', 'again'])
phrases('undo', ['undo', 'go back'])
phrases('stop', ['stop', 'pause'])

// The first of the recognizer's alternatives that is a command, or null.
export function parseCommand(alternatives: string[]): Command | null {
  for (const alternative of alternatives) {
    const phrase = alternative
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const command = PHRASES.get(phrase)
    if (command) return command
  }
  return null
}

export interface HandsFreeDeps {
  session: Session
  languages(): { source: string; target: string; feedback: string } | null
  speak: typeof speak
  listen: typeof listen
  rate(): number // for the target language
  keepAwake(): () => void // returns release
}

export type HandsFreePhase =
  | 'off'
  | 'starting' // unlocking speech, asking for permissions
  | 'speaking'
  | 'listening-answer'
  | 'waiting'
  | 'listening-command'
  | 'paused'

export interface HandsFreeState {
  phase: HandsFreePhase
  interim: string // what the recognizer hears so far
  message: string | null // why it paused
}

// What a pass is bound to: the current slot and whether it is revealed.
type Position = { key: number; revealed: boolean } | null
const positionOf = (slot: Slot | undefined): Position => (slot ? { key: slot.key, revealed: slot.revealed } : null)
const samePosition = (a: Position, b: Position) => a?.key === b?.key && a?.revealed === b?.revealed

export class HandsFree {
  private state: HandsFreeState = { phase: 'off', interim: '', message: null }
  private listeners = new Set<() => void>()
  private pass: AbortController | null = null
  private starting: object | null = null // the start() in progress; cleared by stop()
  private expected: Position = null
  private acting = false // one of our own Session actions is running
  private unsubscribe: (() => void) | null = null
  private release: (() => void) | null = null

  constructor(private deps: HandsFreeDeps) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getState = () => this.state

  // Call from a tap. `prime` runs synchronously inside it (primeFromGesture: unlock
  // speech on iOS, ask for permissions); the loop starts once it succeeds, unless
  // stopped meanwhile.
  async start(prime?: () => Promise<void>) {
    if (this.state.phase !== 'off' && this.state.phase !== 'paused') return
    const token = {}
    this.starting = token
    this.set({ phase: 'starting', message: null })
    try {
      await prime?.()
    } catch (error) {
      if (this.starting !== token) return
      this.starting = null
      const message = isAbort(error) ? "Couldn't start. Try again." : error instanceof Error ? error.message : String(error)
      return this.halt('paused', message)
    }
    if (this.starting !== token) return
    this.starting = null
    this.release = this.deps.keepAwake()
    this.unsubscribe = this.deps.session.subscribe(this.onSessionChange)
    this.next()
  }

  stop() {
    this.starting = null
    this.halt('off', null)
  }

  dispose() {
    this.stop()
  }

  // --- internals ---

  private set(patch: Partial<HandsFreeState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private halt(phase: 'off' | 'paused', message: string | null) {
    this.pass?.abort()
    this.pass = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.release?.()
    this.release = null
    this.set({ phase, message, interim: '' })
  }

  // Our own actions, check results and answer edits keep the position. Anything else
  // that moves it (a tapped grade, a key, a typed submit) restarts on the current slot.
  private onSessionChange = () => {
    if (this.acting || !this.pass) return
    if (!samePosition(positionOf(this.deps.session.current), this.expected)) this.next()
  }

  // Start a pass on the current slot, aborting the running one.
  private next() {
    this.pass?.abort()
    const pass = new AbortController()
    this.pass = pass
    this.expected = positionOf(this.deps.session.current)
    this.run(pass.signal).catch((error) => {
      if (pass.signal.aborted) return
      this.halt('paused', error instanceof Error ? error.message : String(error))
    })
  }

  // Run a Session action as our own: Session notifies synchronously, so mark it first.
  // If the pass was stopped meanwhile (e.g. Stop during a write), it ends here.
  private async act<T>(action: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    this.acting = true
    try {
      const result = await action()
      signal.throwIfAborted()
      return result
    } finally {
      this.acting = false
      this.expected = positionOf(this.deps.session.current)
    }
  }

  // One of our own writes (grade, skip, undo). False if refused because another write is
  // running, so the caller listens again; a failed save pauses the loop.
  private async write(action: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    if (this.deps.session.getState().writing) return false
    if (!(await this.act(action, signal))) throw new Error("Couldn't save.")
    return true
  }

  private async run(signal: AbortSignal) {
    const { session } = this.deps
    const languages = this.deps.languages()
    if (!languages) throw new SpeechError('failed', "Set this deck's languages to study hands-free.")
    const slot = session.current

    if (!slot) {
      await this.say('Done. Say undo to go back.', ENGLISH, signal)
      if ((await this.hear(signal)) === 'undo' && (await this.write(() => session.undo(), signal))) return this.next()
      return this.stop()
    }

    if (!slot.revealed) {
      await this.say(slot.card.front, languages.source, signal)
      let text = (await this.answer(languages.target, signal)) || (await this.answer(languages.target, signal))
      if (!text) {
        await this.say(slot.card.front, languages.source, signal)
        text = await this.answer(languages.target, signal)
      }
      if (!text) return this.halt('paused', "Didn't hear an answer.")
      await this.act(() => {
        session.setAnswer(text, 'spoken', slot.key)
        session.submit(slot.key)
      }, signal)
      return this.next()
    }

    // Short feedback only, the rest stays on screen: the LLM's grade is taken as is.
    const rate = this.deps.rate()
    if (session.current?.check.status === 'pending') {
      await this.checkSettled(signal)
      signal.throwIfAborted()
    }
    const { check } = session.current!
    if (check.status === 'done') {
      const { grade } = check.assessment
      await this.say(`${gradeLabel(grade)}.`, ENGLISH, signal)
      if (grade !== 3) await this.say(slot.card.back, languages.target, signal, rate)
      if (await this.write(() => session.grade(grade), signal)) return this.next()
    } else {
      await this.say(slot.card.back, languages.target, signal, rate)
      if (check.status === 'error') await this.say("Couldn't check.", ENGLISH, signal)
    }
    // No grade from the LLM (or another write was running): ask for one.
    await this.say(HINT, ENGLISH, signal)
    await this.takeCommand(signal)
  }

  // Listen for commands on a revealed card until one is carried out.
  private async takeCommand(signal: AbortSignal) {
    const { session } = this.deps
    let hinted = false
    for (;;) {
      const command = await this.hear(signal)
      if (command === 'repeat') return this.next()
      if (command === 'stop') return this.stop()
      if (command === 'undo') {
        if (!session.getState().history.length) await this.say('Nothing to undo.', ENGLISH, signal)
        else if (await this.write(() => session.undo(), signal)) return this.next()
        continue
      }
      if (command) {
        const grade = command === 'skip' ? undefined : command.grade
        if (!(await this.write(() => (grade ? session.grade(grade) : session.skip()), signal))) continue
        await this.say(grade ? `${gradeLabel(grade)}.` : 'Skipped.', ENGLISH, signal)
        return this.next()
      }
      if (hinted) return this.halt('paused', "Didn't catch a command.")
      hinted = true
      await this.say(HINT, ENGLISH, signal)
    }
  }

  private async say(text: string, lang: string, signal: AbortSignal, rate = 1) {
    if (!text.trim()) return
    this.set({ phase: 'speaking' })
    await this.deps.speak(text, lang, { rate, signal })
    signal.throwIfAborted() // the pass may have been replaced while the promise settled
  }

  private async listenOnce(lang: string, signal: AbortSignal) {
    try {
      const heard = await this.deps.listen({ lang, signal, onInterim: (interim) => this.set({ interim }) }).result
      signal.throwIfAborted()
      return heard
    } finally {
      this.set({ interim: '' })
    }
  }

  private async answer(lang: string, signal: AbortSignal): Promise<string> {
    this.set({ phase: 'listening-answer' })
    return (await this.listenOnce(lang, signal)).text.trim()
  }

  private async hear(signal: AbortSignal): Promise<Command | null> {
    this.set({ phase: 'listening-command' })
    return parseCommand((await this.listenOnce(ENGLISH, signal)).alternatives)
  }

  // Wait until the current slot's check is no longer pending.
  private checkSettled(signal: AbortSignal): Promise<void> {
    const { session } = this.deps
    this.set({ phase: 'waiting' })
    return new Promise((resolve, reject) => {
      const check = () => {
        if (session.current?.check.status === 'pending') return
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        reject(abortError())
      }
      const unsubscribe = session.subscribe(check)
      const cleanup = () => {
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }
}

// Screen Wake Lock while hands-free runs, where supported. Returns release.
export function keepScreenAwake(): () => void {
  let released = false
  let lock: { release(): Promise<void> } | null = null
  const wakeLock = (navigator as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock
  wakeLock?.request('screen').then(
    (sentinel) => {
      lock = sentinel
      if (released) void sentinel.release().catch(() => {})
    },
    () => {}, // not allowed (e.g. low battery): the loop works while the screen stays on
  )
  return () => {
    released = true
    void lock?.release().catch(() => {})
  }
}
