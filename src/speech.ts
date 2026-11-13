// Text-to-speech and speech recognition through the browser's Web Speech API, and the
// voice settings. Design: doc/voice.md.
import { languageName } from './languages'
import { readStored, writeStored } from './storage'

export type SpeechErrorKind =
  | 'unsupported' // from feature detection only: no API, or an iOS home-screen app
  | 'no-voice' // no TTS voice for the language
  | 'not-allowed' // microphone or speech service blocked
  | 'no-microphone'
  | 'network'
  | 'language' // the recognizer doesn't support the language
  | 'failed' // retryable: didn't start, stalled, or was interrupted

export class SpeechError extends Error {
  constructor(
    readonly kind: SpeechErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export const abortError = () => new DOMException('Aborted', 'AbortError')
export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

// --- The part of SpeechRecognition we use (TypeScript's DOM types lack it) ---

interface RecognitionAlternative {
  transcript: string
}
interface RecognitionResult {
  readonly length: number
  readonly isFinal: boolean
  [index: number]: RecognitionAlternative
}
interface RecognitionEvent {
  results: { readonly length: number; [index: number]: RecognitionResult }
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
interface RecognitionConstructor {
  new (): Recognition
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>
}

const recognitionClass = (): RecognitionConstructor | undefined => {
  const scope = globalThis as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

// iOS home-screen apps have the constructor, but start() does nothing (WebKit bug 225298).
export const isIosHomeScreenApp = () => (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true

export const canSpeak = () => 'speechSynthesis' in globalThis && 'SpeechSynthesisUtterance' in globalThis
export const canListen = () => !!recognitionClass() && !isIosHomeScreenApp()

// --- Voices ---

export type VoiceLike = Pick<SpeechSynthesisVoice, 'lang' | 'default' | 'localService'>

const normalizeTag = (tag: string) => tag.replace(/_/g, '-').toLowerCase()

// Chinese voices must match in script and language: Mandarin in simplified or
// traditional characters, or Cantonese (often tagged zh-HK).
function chineseVariant(tag: string) {
  if (/-(hk|mo)\b|^yue/.test(tag)) return 'yue'
  if (/-(tw|hant)\b/.test(tag)) return 'hant'
  return 'hans'
}

// How well `voice` fits `lang`: exact tag, then the same language; then the browser
// default, then local voices (they work offline). 0 if it doesn't speak the language.
function voiceScore(voice: VoiceLike, lang: string) {
  const wanted = normalizeTag(lang)
  const base = wanted.split('-')[0]
  const tag = normalizeTag(voice.lang)
  if (tag.split('-')[0] !== base) return 0
  if (base === 'zh' && chineseVariant(tag) !== chineseVariant(wanted)) return 0
  return (tag === wanted ? 8 : 4) + (voice.default ? 2 : 0) + (voice.localService ? 1 : 0)
}

// The voices that speak `lang`, best first; ties keep the browser's order.
function rankVoices<V extends VoiceLike>(voices: V[], lang: string): V[] {
  return voices
    .filter((voice) => voiceScore(voice, lang) > 0)
    .sort((a, b) => voiceScore(b, lang) - voiceScore(a, lang))
}

// Best voice for `lang`, or null if none speaks it.
export const pickVoice = <V extends VoiceLike>(voices: V[], lang: string): V | null => rankVoices(voices, lang)[0] ?? null

const voices = (): SpeechSynthesisVoice[] => (canSpeak() ? speechSynthesis.getVoices() : [])

// Chrome loads voices asynchronously; resolves once they are there, or after a second.
export function voicesReady(): Promise<void> {
  if (!canSpeak() || voices().length) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 1000)
    speechSynthesis.addEventListener('voiceschanged', done)
  })
}

// For the voice picker in settings.
export const voicesFor = (lang: string) => rankVoices(voices(), lang)

// The voice picked in settings for `lang`, else one picked for another tag of the same
// language (e.g. "en" for announcements in "en-US"), else the best match. Picked voices
// the device no longer has are ignored.
function chooseVoice(list: SpeechSynthesisVoice[], lang: string) {
  const picked = loadVoiceSettings().voices
  const uris = new Set(Object.values(picked))
  return (
    (picked[lang] && list.find((voice) => voice.voiceURI === picked[lang])) ||
    pickVoice(
      list.filter((voice) => uris.has(voice.voiceURI)),
      lang,
    ) ||
    pickVoice(list, lang)
  )
}

// True while voices aren't known yet: speak() then lets the browser pick by `lang`.
export function hasVoice(lang: string): boolean {
  const list = voices()
  return canSpeak() && (!list.length || pickVoice(list, lang) !== null)
}

// --- One speech operation at a time ---

let active: AbortController | null = null

// Aborts the running operation (it rejects with an AbortError) and starts a new one
// that also aborts with `signal`.
function begin(signal: AbortSignal) {
  active?.abort()
  const controller = new AbortController()
  active = controller
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) controller.abort()
  return {
    signal: controller.signal,
    end() {
      signal.removeEventListener('abort', onAbort)
      if (active === controller) active = null
    },
  }
}

// --- Speaking ---

const SPEAK_START_MS = 3000
const SECONDS_PER_CHAR = 0.15 // generous; CJK is slower per character than Latin script

// Utterances are kept referenced while they play: Chrome can drop their events otherwise.
const playing = new Set<SpeechSynthesisUtterance>()

// Resolves once the utterance has been spoken; only its `end` event counts. Throws
// SpeechError, or an AbortError when `signal` aborts or another operation starts.
export function speak(text: string, lang: string, options: { rate?: number; signal: AbortSignal }): Promise<void> {
  const rate = options.rate ?? 1
  return new Promise((resolve, reject) => {
    if (!canSpeak()) return reject(new SpeechError('unsupported', "This browser can't read aloud."))
    const list = voices()
    const voice = chooseVoice(list, lang)
    if (list.length && !voice) {
      return reject(new SpeechError('no-voice', `There's no ${languageName(lang)} voice on this device.`))
    }
    const op = begin(options.signal)
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = voice?.lang ?? lang
    if (voice) utterance.voice = voice as SpeechSynthesisVoice
    utterance.rate = rate

    let settled = false
    // Settle once. The handlers go first: cancel() makes the browser fire an error on
    // this utterance later, which must not touch whatever is spoken next.
    const finish = (error?: unknown, cancel = false) => {
      if (settled) return
      settled = true
      utterance.onstart = utterance.onend = utterance.onerror = null
      clearTimeout(startTimer)
      clearTimeout(endTimer)
      op.signal.removeEventListener('abort', onAbort)
      playing.delete(utterance)
      op.end()
      if (cancel) speechSynthesis.cancel()
      if (error) reject(error)
      else resolve()
    }
    const fail = (message: string) => finish(new SpeechError('failed', message), true)
    const onAbort = () => finish(abortError(), true)

    utterance.onstart = () => clearTimeout(startTimer)
    utterance.onend = () => finish()
    utterance.onerror = () => fail("Couldn't finish reading aloud.")
    const startTimer = setTimeout(() => fail("Couldn't start reading aloud. Try again."), SPEAK_START_MS)
    const endTimer = setTimeout(
      () => fail("Couldn't finish reading aloud."),
      ((text.length * SECONDS_PER_CHAR * 1000) / rate) * 2 + 3000,
    )
    op.signal.addEventListener('abort', onAbort, { once: true })
    if (op.signal.aborted) return onAbort()
    playing.add(utterance)
    speechSynthesis.speak(utterance)
  })
}

// --- Listening ---

const FIRST_START_MS = 20_000 // time to read permission dialogs on first use
const START_MS = 3000
const FINISH_MS = 2000 // after finish(), how long to wait for the final result
const MAX_LISTEN_MS = 30_000

// Set once recognition has started in this page session: later starts need no dialog.
let recognitionStarted = false

// No spaces between parts in languages written without them.
export function joinTranscript(parts: string[], lang: string): string {
  const separator = /^(zh|ja|yue)\b/i.test(lang) ? '' : ' '
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(separator)
}

function recognitionError(code: string, lang: string): SpeechError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return new SpeechError(
        'not-allowed',
        'Speech recognition is blocked. Allow the microphone for this site in the browser settings (on iOS, also turn on Siri & Dictation).',
      )
    case 'audio-capture':
      return new SpeechError('no-microphone', 'No microphone found.')
    case 'network':
      return new SpeechError('network', 'Speech recognition needs a connection.')
    case 'language-not-supported':
      return new SpeechError('language', `This browser can't recognize ${languageName(lang)}.`)
    default:
      return new SpeechError('failed', `Speech recognition failed (${code}). Try again.`)
  }
}

export interface Heard {
  text: string // empty if nothing was heard
  alternatives: string[] // for a single phrase, the recognizer's guesses, best first
}

export interface Listening {
  result: Promise<Heard>
  finish(): void // stop listening, keeping what was heard
}

function newRecognition(lang: string): Recognition {
  const Recognition = recognitionClass()!
  const recognition = new Recognition()
  recognition.lang = lang
  recognition.continuous = false
  recognition.interimResults = true
  recognition.maxAlternatives = 3
  return recognition
}

// One utterance in `lang`. Aborting `signal` stops listening and rejects with an
// AbortError, discarding what was heard.
export function listen(options: {
  lang: string
  signal: AbortSignal
  onInterim?: (text: string) => void
  onStart?: () => void // listening has begun: permissions are granted
}): Listening {
  const { lang, onInterim, onStart } = options
  let finish = () => {}
  const result = new Promise<Heard>((resolve, reject) => {
    if (!canListen()) return reject(new SpeechError('unsupported', "This browser can't recognize speech."))
    const op = begin(options.signal)
    const recognition = newRecognition(lang)
    let finals: string[] = []
    let alternatives: string[] = []
    let heard = '' // finals plus the latest interim text
    let error: SpeechError | null = null
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const settle = (outcome: Heard | Error) => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      op.signal.removeEventListener('abort', onAbort)
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null
      op.end()
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const onAbort = () => {
      recognition.abort()
      settle(abortError())
    }
    const final = () => {
      const text = joinTranscript(finals, lang)
      return { text, alternatives: alternatives.length ? alternatives : text ? [text] : [] }
    }

    recognition.onstart = () => {
      recognitionStarted = true
      clearTimeout(startTimer)
      onStart?.()
    }
    recognition.onresult = (event) => {
      const done: RecognitionResult[] = []
      const interim: string[] = []
      for (let i = 0; i < event.results.length; i++) {
        const item = event.results[i]
        if (item.isFinal) done.push(item)
        else interim.push(item[0].transcript)
      }
      finals = done.map((item) => item[0].transcript)
      alternatives =
        done.length === 1 ? Array.from({ length: done[0].length }, (_, i) => done[0][i].transcript.trim()) : []
      heard = joinTranscript([...finals, ...interim], lang)
      onInterim?.(heard)
    }
    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') error = recognitionError(event.error, lang)
    }
    recognition.onend = () => settle(error ?? final())

    finish = () => {
      if (settled) return
      recognition.stop()
      // If the final result never comes, keep what was shown.
      timers.push(
        setTimeout(() => {
          recognition.abort()
          settle({ text: heard, alternatives: heard ? [heard] : [] })
        }, FINISH_MS),
      )
    }
    const startTimer = setTimeout(
      () => {
        recognition.abort()
        settle(new SpeechError('failed', "Couldn't start listening. Try again."))
      },
      recognitionStarted ? START_MS : FIRST_START_MS,
    )
    timers.push(startTimer)
    timers.push(
      setTimeout(() => {
        recognition.abort()
        settle(final())
      }, MAX_LISTEN_MS),
    )
    op.signal.addEventListener('abort', onAbort, { once: true })
    if (op.signal.aborted) return onAbort()
    try {
      recognition.start()
    } catch {
      settle(new SpeechError('failed', "Couldn't start listening. Try again."))
    }
  })
  return { result, finish: () => finish() }
}

// Chrome 139+ can tell up front whether it recognizes a language; null where it can't.
export async function recognitionAvailable(lang: string): Promise<boolean | null> {
  const Recognition = recognitionClass()
  if (!canListen() || typeof Recognition?.available !== 'function') return null
  try {
    return (await Recognition.available({ langs: [lang], processLocally: false })) !== 'unavailable'
  } catch {
    return null
  }
}

// Call from a tap, before hands-free starts: iOS only allows speech after a user
// gesture, and permission dialogs should appear while the user is looking. Speaks a
// silent utterance synchronously, then starts a recognizer and stops it once it runs.
export async function primeFromGesture(lang: string): Promise<void> {
  active?.abort() // stop any read-aloud first: its cancel() would drop the unlock utterance
  if (canSpeak()) {
    const unlock = new SpeechSynthesisUtterance(' ')
    unlock.volume = 0
    speechSynthesis.speak(unlock)
  }
  const controller = new AbortController()
  let started = false
  const onStart = () => {
    started = true
    controller.abort()
  }
  try {
    await listen({ lang, signal: controller.signal, onStart }).result
  } catch (error) {
    // Only our own stop after the start is success, not being cut off by another operation.
    if (!(isAbort(error) && started)) throw error
  }
  // Ended without ever starting, e.g. where start() silently does nothing.
  if (!started) throw new SpeechError('failed', "Couldn't start listening. Try again.")
}

// --- Settings ---

export const RATES = [
  { rate: 0.7, label: 'Slower' },
  { rate: 0.85, label: 'Slow' },
  { rate: 1, label: 'Normal' },
  { rate: 1.2, label: 'Fast' },
  { rate: 1.4, label: 'Faster' },
]

// What hands-free says once the answer is checked; the rest stays on screen.
export const SPOKEN_FEEDBACK = [
  { value: 'minimal', label: 'Minimal: the grade only' },
  { value: 'short', label: 'Short: the grade, and the reference below Good' },
  { value: 'full', label: 'Full: the grade, the reference, the correction and the summary' },
] as const
export type SpokenFeedback = (typeof SPOKEN_FEEDBACK)[number]['value']

export interface VoiceSettings {
  rate: number // the language being learned
  otherRate: number // prompts, feedback and announcements
  voices: Record<string, string> // language tag → voiceURI picked in settings
  readReference: boolean // read the reference aloud on reveal
  spokenFeedback: SpokenFeedback // hands-free
  confirmGrade: boolean // hands-free asks to confirm the LLM's grade instead of taking it
  hideText: boolean // hands-free hides the prompt and the reference
  privacyNoteSeen: boolean
}

const VOICE_KEY = 'fluency:voice'

export function loadVoiceSettings(): VoiceSettings {
  const stored = readStored(VOICE_KEY) ?? {}
  const rate = (value: unknown) => RATES.find(({ rate }) => rate === value)?.rate ?? 1
  const voices: Record<string, string> = {}
  if (typeof stored.voices === 'object' && stored.voices) {
    for (const [lang, uri] of Object.entries(stored.voices)) if (typeof uri === 'string') voices[lang] = uri
  }
  return {
    rate: rate(stored.rate),
    otherRate: rate(stored.otherRate),
    voices,
    readReference: stored.readReference === true,
    spokenFeedback: SPOKEN_FEEDBACK.find(({ value }) => value === stored.spokenFeedback)?.value ?? 'short',
    confirmGrade: stored.confirmGrade === true,
    hideText: stored.hideText === true,
    privacyNoteSeen: stored.privacyNoteSeen === true,
  }
}

export const saveVoiceSettings = (settings: VoiceSettings) => writeStored(VOICE_KEY, settings)

export const PRIVACY_NOTE =
  "Speaking an answer uses your browser's speech recognition, which may send the audio to its provider " +
  "(Google in Chrome on Android and desktop, Apple on iOS). Fluency doesn't store or send audio itself."
