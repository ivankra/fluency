// Which scheduling algorithm to use, and the FSRS options. Design: doc/fsrs.md.
import { readStored, writeStored } from './storage'

export type Algorithm = 'sm2' | 'fsrs'

export type Step = `${number}${'m' | 'h' | 'd'}`

export interface FsrsOptions {
  desiredRetention: number // target probability of recall at the next review
  maximumInterval: number // days
  learningSteps: Step[]
  relearningSteps: Step[]
  enableFuzz: boolean // spread out reviews of cards learned together
  weights: number[] | null // FSRS-6 parameters; null means the defaults
}

export interface SchedulerSettings {
  algorithm: Algorithm
  fsrs: FsrsOptions
}

export const RETENTION_RANGE = { min: 0.7, max: 0.97 }
export const MAX_INTERVAL_LIMIT = 36_500
export const FSRS6_WEIGHT_COUNT = 21

export const DEFAULT_FSRS: FsrsOptions = {
  desiredRetention: 0.9,
  maximumInterval: MAX_INTERVAL_LIMIT,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  enableFuzz: true,
  weights: null,
}

const KEY = 'fluency:scheduler'

// "1m 10m" → ['1m', '10m']; null if any step is invalid. Empty is valid (no steps).
export function parseSteps(text: string): Step[] | null {
  const steps = text.trim().split(/[\s,]+/).filter(Boolean)
  return steps.every((step) => /^\d+(\.\d+)?[mhd]$/.test(step) && parseFloat(step) > 0) ? (steps as Step[]) : null
}

export const formatSteps = (steps: Step[]) => steps.join(' ')

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function stepsOr(value: unknown, fallback: Step[]): Step[] {
  return Array.isArray(value) && value.every((step) => typeof step === 'string')
    ? (parseSteps(value.join(' ')) ?? fallback)
    : fallback
}

const isWeights = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === FSRS6_WEIGHT_COUNT && value.every((w) => typeof w === 'number' && Number.isFinite(w))

// Invalid or missing fields fall back to their defaults one by one.
export function loadSchedulerSettings(): SchedulerSettings {
  const stored = readStored(KEY)
  const fsrs = stored?.fsrs && typeof stored.fsrs === 'object' ? (stored.fsrs as Record<string, unknown>) : {}
  return {
    algorithm: stored?.algorithm === 'fsrs' ? 'fsrs' : 'sm2',
    fsrs: {
      desiredRetention: inRange(fsrs.desiredRetention, RETENTION_RANGE.min, RETENTION_RANGE.max)
        ? fsrs.desiredRetention
        : DEFAULT_FSRS.desiredRetention,
      maximumInterval: inRange(fsrs.maximumInterval, 1, MAX_INTERVAL_LIMIT)
        ? Math.round(fsrs.maximumInterval)
        : DEFAULT_FSRS.maximumInterval,
      learningSteps: stepsOr(fsrs.learningSteps, DEFAULT_FSRS.learningSteps),
      relearningSteps: stepsOr(fsrs.relearningSteps, DEFAULT_FSRS.relearningSteps),
      enableFuzz: typeof fsrs.enableFuzz === 'boolean' ? fsrs.enableFuzz : DEFAULT_FSRS.enableFuzz,
      weights: isWeights(fsrs.weights) ? fsrs.weights : null,
    },
  }
}

export const saveSchedulerSettings = (settings: SchedulerSettings) => writeStored(KEY, settings)
