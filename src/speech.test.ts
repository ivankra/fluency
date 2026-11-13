import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { joinTranscript, pickVoice, type VoiceLike } from './speech'

const voice = (lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({ lang, default: false, localService: false, ...extra })

describe('pickVoice', () => {
  it('prefers an exact tag, then the same language', () => {
    const voices = [voice('en-US'), voice('es-MX'), voice('es-ES')]
    expect(pickVoice(voices, 'es-ES')).toBe(voices[2])
    expect(pickVoice(voices, 'es')?.lang).toMatch(/^es-/)
    expect(pickVoice(voices, 'fr')).toBeNull()
  })

  it('accepts Android-style underscores and any case', () => {
    const voices = [voice('es_ES')]
    expect(pickVoice(voices, 'es-es')).toBe(voices[0])
  })

  it('never mixes Chinese scripts, or Mandarin with Cantonese', () => {
    const voices = [voice('zh-TW'), voice('zh-HK'), voice('zh-CN')]
    expect(pickVoice(voices, 'zh-CN')).toBe(voices[2])
    expect(pickVoice(voices, 'zh')).toBe(voices[2])
    expect(pickVoice(voices, 'zh-TW')).toBe(voices[0])
    expect(pickVoice([voice('zh-HK')], 'zh-TW')).toBeNull()
    expect(pickVoice([voice('zh-TW')], 'zh-CN')).toBeNull()
  })

  it('among equal matches, prefers the default, then local voices', () => {
    const local = voice('es-ES', { localService: true })
    const preferred = voice('es-ES', { default: true })
    expect(pickVoice([voice('es-ES'), local], 'es-ES')).toBe(local)
    expect(pickVoice([local, preferred], 'es-ES')).toBe(preferred)
  })
})

describe('joinTranscript', () => {
  it('joins with spaces, except in Chinese and Japanese', () => {
    expect(joinTranscript([' hola ', '', 'amigo'], 'es')).toBe('hola amigo')
    expect(joinTranscript(['我在', '学习'], 'zh-CN')).toBe('我在学习')
    expect(joinTranscript(['私は', '学生です'], 'ja')).toBe('私は学生です')
  })
})

// --- speak and listen against fake browser APIs. Each test loads a fresh module, since
// speech.ts remembers whether recognition has started in this page session.

class FakeUtterance {
  lang = ''
  voice: unknown = null
  rate = 1
  volume = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly text: string) {}
}

class FakeRecognition {
  static instances: FakeRecognition[] = []
  lang = ''
  continuous = true
  interimResults = false
  maxAlternatives = 1
  onstart: (() => void) | null = null
  onresult: ((event: unknown) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()
  constructor() {
    FakeRecognition.instances.push(this)
  }
  // Results so far: each is [isFinal, ...alternatives].
  results(...items: [boolean, ...string[]][]) {
    const results = items.map(([isFinal, ...alternatives]) =>
      Object.assign(
        alternatives.map((transcript) => ({ transcript })),
        { isFinal },
      ),
    )
    this.onresult?.({ results })
  }
}

let synth: { utterances: FakeUtterance[]; voices: VoiceLike[]; speak: (u: FakeUtterance) => void; cancel: ReturnType<typeof vi.fn>; getVoices: () => VoiceLike[]; addEventListener(): void; removeEventListener(): void }
let navigatorStub: { standalone?: boolean }

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  FakeRecognition.instances = []
  synth = {
    utterances: [],
    voices: [voice('es-ES')],
    speak: (utterance) => synth.utterances.push(utterance),
    cancel: vi.fn(),
    getVoices: () => synth.voices,
    addEventListener() {},
    removeEventListener() {},
  }
  navigatorStub = {}
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
  vi.stubGlobal('navigator', navigatorStub)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const load = () => import('./speech')
const signal = () => new AbortController().signal
// Attach a handler at once, so a rejection before the test awaits isn't reported.
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }))

describe('speak', () => {
  it('resolves when the utterance ends', async () => {
    const { speak } = await load()
    const spoken = outcome(speak('hola', 'es', { rate: 0.7, signal: signal() }))
    const [utterance] = synth.utterances
    expect(utterance).toMatchObject({ text: 'hola', lang: 'es-ES', rate: 0.7 })
    utterance.onstart!()
    utterance.onend!()
    expect(await spoken).toEqual({ value: undefined })
  })

  it('fails without a voice for the language', async () => {
    const { speak } = await load()
    expect(await outcome(speak('hi', 'ja', { signal: signal() }))).toMatchObject({ error: { kind: 'no-voice' } })
  })

  it('fails and cancels if speech never starts', async () => {
    const { speak } = await load()
    const spoken = outcome(speak('hola', 'es', { signal: signal() }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(await spoken).toMatchObject({ error: { kind: 'failed' } })
    expect(synth.cancel).toHaveBeenCalled()
  })

  it('fails if the end is not confirmed by the deadline; a late end changes nothing', async () => {
    const { speak } = await load()
    const spoken = outcome(speak('hola', 'es', { signal: signal() }))
    const [utterance] = synth.utterances
    utterance.onstart!()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await spoken).toMatchObject({ error: { kind: 'failed' } })
    expect(utterance.onend).toBeNull() // a late end can't reach the settled promise
  })

  it('aborts, also when another operation starts', async () => {
    const { speak, isAbort } = await load()
    const controller = new AbortController()
    const first = outcome(speak('uno', 'es', { signal: controller.signal }))
    controller.abort()
    const second = outcome(speak('dos', 'es', { signal: signal() }))
    const third = outcome(speak('tres', 'es', { signal: signal() }))
    for (const result of [await first, await second]) expect(isAbort((result as { error: unknown }).error)).toBe(true)
    expect(synth.cancel).toHaveBeenCalled()
    synth.utterances[2].onstart!()
    synth.utterances[2].onend!()
    expect(await third).toEqual({ value: undefined })
  })

  it("a cancelled utterance's late error doesn't touch the next one", async () => {
    const { speak } = await load()
    const controller = new AbortController()
    void outcome(speak('uno', 'es', { signal: controller.signal }))
    controller.abort()
    const next = outcome(speak('dos', 'es', { signal: signal() }))
    synth.utterances[0].onerror?.() // what the browser fires after cancel()
    synth.utterances[1].onstart!()
    synth.utterances[1].onend!()
    expect(await next).toEqual({ value: undefined })
    expect(synth.cancel).toHaveBeenCalledTimes(1)
  })

  it('an error not caused by our own cancel fails', async () => {
    const { speak } = await load()
    const spoken = outcome(speak('hola', 'es', { signal: signal() }))
    synth.utterances[0].onerror!()
    expect(await spoken).toMatchObject({ error: { kind: 'failed' } })
  })
})

describe('listen', () => {
  it('resolves with the final result and its alternatives, reporting interim text', async () => {
    const { listen } = await load()
    const interim: string[] = []
    const listening = listen({ lang: 'es', signal: signal(), onInterim: (text) => interim.push(text) })
    const heard = outcome(listening.result)
    const [recognition] = FakeRecognition.instances
    expect(recognition).toMatchObject({ lang: 'es', continuous: false, interimResults: true })
    recognition.onstart!()
    recognition.results([false, 'hola'])
    recognition.results([true, 'hola amigo', 'ola amigo'])
    recognition.onend!()
    expect(await heard).toEqual({ value: { text: 'hola amigo', alternatives: ['hola amigo', 'ola amigo'] } })
    expect(interim).toEqual(['hola', 'hola amigo'])
  })

  it('gives empty text when nothing was said', async () => {
    const { listen } = await load()
    const heard = outcome(listen({ lang: 'es', signal: signal() }).result)
    const [recognition] = FakeRecognition.instances
    recognition.onstart!()
    recognition.onerror!({ error: 'no-speech' })
    recognition.onend!()
    expect(await heard).toEqual({ value: { text: '', alternatives: [] } })
  })

  it('finish() keeps what was heard; aborting discards it', async () => {
    const { listen, isAbort } = await load()
    const listening = listen({ lang: 'es', signal: signal() })
    const heard = outcome(listening.result)
    let [recognition] = FakeRecognition.instances
    recognition.onstart!()
    recognition.results([false, 'hola'])
    listening.finish()
    expect(recognition.stop).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000) // the final result never came
    expect(await heard).toEqual({ value: { text: 'hola', alternatives: ['hola'] } })
    expect(recognition.abort).toHaveBeenCalled()

    const controller = new AbortController()
    const aborted = outcome(listen({ lang: 'es', signal: controller.signal }).result)
    recognition = FakeRecognition.instances[1]
    recognition.onstart!()
    recognition.results([true, 'hola'])
    controller.abort()
    expect(recognition.abort).toHaveBeenCalled()
    expect(isAbort(((await aborted) as { error: unknown }).error)).toBe(true)
  })

  it('maps errors', async () => {
    const { listen } = await load()
    const heard = outcome(listen({ lang: 'es', signal: signal() }).result)
    const [recognition] = FakeRecognition.instances
    recognition.onerror!({ error: 'not-allowed' })
    recognition.onend!()
    expect(await heard).toMatchObject({ error: { kind: 'not-allowed' } })
  })

  it('gives the first start time for permission dialogs, later starts 3 s', async () => {
    const { listen } = await load()
    // Microphone allowed, the recognition dialog still open: no early timeout.
    const first = outcome(listen({ lang: 'es', signal: signal() }).result)
    await vi.advanceTimersByTimeAsync(10_000)
    FakeRecognition.instances[0].onstart!()
    FakeRecognition.instances[0].onend!()
    expect(await first).toEqual({ value: { text: '', alternatives: [] } })

    const second = outcome(listen({ lang: 'es', signal: signal() }).result)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await second).toMatchObject({ error: { kind: 'failed' } })
    expect(FakeRecognition.instances[1].abort).toHaveBeenCalled()
  })

  it('fails if recognition never starts, and stops at the hard time limit', async () => {
    const { listen } = await load()
    const never = outcome(listen({ lang: 'es', signal: signal() }).result)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await never).toMatchObject({ error: { kind: 'failed' } })

    const endless = outcome(listen({ lang: 'es', signal: signal() }).result)
    const recognition = FakeRecognition.instances[1]
    recognition.onstart!()
    recognition.results([true, 'hola'])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await endless).toEqual({ value: { text: 'hola', alternatives: ['hola'] } })
  })

  it('is unsupported in iOS home-screen apps', async () => {
    navigatorStub.standalone = true
    const { canListen, listen } = await load()
    expect(canListen()).toBe(false)
    expect(await outcome(listen({ lang: 'es', signal: signal() }).result)).toMatchObject({ error: { kind: 'unsupported' } })
  })
})

describe('primeFromGesture', () => {
  it('unlocks speech silently and stops the recognizer once it starts', async () => {
    const { primeFromGesture } = await load()
    const primed = outcome(primeFromGesture('es'))
    expect(synth.utterances[0]).toMatchObject({ text: ' ', volume: 0 })
    const [recognition] = FakeRecognition.instances
    recognition.onstart!()
    expect(await primed).toEqual({ value: undefined })
    expect(recognition.abort).toHaveBeenCalled()
  })

  it('fails on a permission error, or when cut off by another operation', async () => {
    const { primeFromGesture, speak, isAbort } = await load()
    const denied = outcome(primeFromGesture('es'))
    FakeRecognition.instances[0].onerror!({ error: 'not-allowed' })
    FakeRecognition.instances[0].onend!()
    expect(await denied).toMatchObject({ error: { kind: 'not-allowed' } })

    const ended = outcome(primeFromGesture('es'))
    FakeRecognition.instances[1].onend!() // ended without ever starting
    expect(await ended).toMatchObject({ error: { kind: 'failed' } })

    const cutOff = outcome(primeFromGesture('es'))
    void outcome(speak('hola', 'es', { signal: signal() }))
    expect(isAbort(((await cutOff) as { error: unknown }).error)).toBe(true)
  })
})
