import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FSRS, loadSchedulerSettings, parseSteps, saveSchedulerSettings } from './schedulerSettings'

// A minimal localStorage for the node test environment.
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
} as Storage

afterEach(() => store.clear())

describe('parseSteps', () => {
  it('accepts minutes, hours and days separated by spaces or commas', () => {
    expect(parseSteps(' 1m, 10m 1.5h 2d ')).toEqual(['1m', '10m', '1.5h', '2d'])
    expect(parseSteps('')).toEqual([])
  })

  it('rejects anything else', () => {
    for (const text of ['10', 'm', '0m', '1s', '1 m', '-1m']) expect(parseSteps(text), text).toBeNull()
  })
})

describe('loadSchedulerSettings', () => {
  it('defaults to SM-2 and the FSRS defaults', () => {
    expect(loadSchedulerSettings()).toEqual({ algorithm: 'sm2', fsrs: DEFAULT_FSRS })
  })

  it('round-trips valid settings', () => {
    const settings = {
      algorithm: 'fsrs' as const,
      fsrs: { ...DEFAULT_FSRS, desiredRetention: 0.85, learningSteps: ['5m' as const], weights: Array(21).fill(1) },
    }
    saveSchedulerSettings(settings)
    expect(loadSchedulerSettings()).toEqual(settings)
  })

  it('falls back field by field', () => {
    store.set(
      'fluency:scheduler',
      JSON.stringify({
        algorithm: 'fsrs',
        fsrs: { desiredRetention: 2, maximumInterval: 100, learningSteps: ['bad'], enableFuzz: 'yes', weights: [1, 2] },
      }),
    )
    expect(loadSchedulerSettings()).toEqual({ algorithm: 'fsrs', fsrs: { ...DEFAULT_FSRS, maximumInterval: 100 } })
    store.set('fluency:scheduler', 'not json')
    expect(loadSchedulerSettings().algorithm).toBe('sm2')
  })
})
