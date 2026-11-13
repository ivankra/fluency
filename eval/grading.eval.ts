// Grading evaluation: runs every case through assessAnswer (the production path) for
// each model and prints agreement, Good↔Bad swaps, failures, latency and cost per
// model and language. Paid; run by hand with `make eval`, never from `make test`.
//
//   LLM_API_KEY=... LLM_MODELS=a/model,b/model [LLM_BASE_URL=...] make eval
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { assessAnswer, PROMPT_VERSION, type Assessment } from '../src/grader'
import { OPENROUTER_URL } from '../src/llm'
import cases from './grading-cases.json'

// Declared here rather than globally, so app code can't use it by accident.
declare const process: { env: Record<string, string | undefined> }

type TestCase = (typeof cases)[number]

interface Result {
  model: string
  testCase: TestCase
  assessment?: Assessment
  error?: string
  latencyMs: number
  cost?: number
}

const env = process.env

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0
}

const agrees = (result: Result) =>
  result.assessment !== undefined && result.testCase.expected.includes(result.assessment.grade)

// Off by two from every acceptable grade: Good for a Bad answer, or the reverse.
const isSwap = (result: Result) =>
  result.assessment !== undefined &&
  result.testCase.expected.every((acceptable) => Math.abs(acceptable - result.assessment!.grade) === 2)

function summarize(results: Result[]) {
  const latencies = results.map((result) => result.latencyMs)
  return {
    agree: `${results.filter(agrees).length}/${results.length}`,
    swaps: results.filter(isSwap).length,
    criticalFails: results.filter((result) => result.testCase.critical && !agrees(result)).length,
    invalid: results.filter((result) => !result.assessment).length,
    p50ms: percentile(latencies, 0.5),
    p90ms: percentile(latencies, 0.9),
    cost: results.reduce((sum, result) => sum + (result.cost ?? 0), 0).toFixed(4),
  }
}

test('grading evaluation', { timeout: 0 }, async () => {
  const apiKey = env.LLM_API_KEY
  const models = (env.LLM_MODELS ?? '').split(',').map((model) => model.trim()).filter(Boolean)
  expect(apiKey, 'set LLM_API_KEY').toBeTruthy()
  expect(models.length, 'set LLM_MODELS').toBeGreaterThan(0)

  const results: Result[] = []
  for (const model of models) {
    for (const testCase of cases) {
      const input = {
        ...testCase,
        feedbackLanguage: 'en',
        gradingRules: testCase.gradingRules ?? '',
        answerMode: testCase.answerMode === 'spoken' ? ('spoken' as const) : undefined,
      }
      const settings = { baseUrl: env.LLM_BASE_URL || OPENROUTER_URL, model }
      const start = performance.now()
      try {
        const graded = await assessAnswer(input, settings, apiKey!, new AbortController().signal)
        const latencyMs = Math.round(performance.now() - start)
        results.push({ model, testCase, assessment: graded.assessment, latencyMs, cost: graded.usage?.cost })
      } catch (error) {
        results.push({ model, testCase, error: String(error), latencyMs: Math.round(performance.now() - start) })
      }
    }
  }

  const rows: Record<string, ReturnType<typeof summarize>> = {}
  for (const model of models) {
    const modelResults = results.filter((result) => result.model === model)
    rows[model] = summarize(modelResults)
    for (const language of new Set(cases.map((testCase) => testCase.targetLanguage))) {
      rows[`${model} ${language}`] = summarize(modelResults.filter((result) => result.testCase.targetLanguage === language))
    }
    // Spoken cases in their own row, so a few of them can't hide among the typed ones.
    rows[`${model} spoken`] = summarize(modelResults.filter((result) => result.testCase.answerMode === 'spoken'))
  }
  console.table(rows)
  for (const miss of results.filter((result) => !agrees(result))) {
    const got = miss.assessment?.grade ?? miss.error
    console.log(`${miss.model} | ${miss.testCase.answer} | expected ${miss.testCase.expected} | got ${got}`)
  }

  mkdirSync('eval/results', { recursive: true })
  const file = `eval/results/v${PROMPT_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`All assessments: ${file}`)
})
