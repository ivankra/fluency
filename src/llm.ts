// LLM provider settings, the API key, and one OpenAI-compatible chat request.
import { readStored, writeStored } from './storage'

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODEL = 'google/gemini-2.5-flash' // placeholder until the evaluation picks one

export interface LlmSettings {
  enabled: boolean // grade answers in study sessions
  baseUrl: string
  model: string
  feedbackLanguage: string // BCP 47
  gradingRules: string // editable part of the grading prompt; empty means the default
}

// What a request needs; the rest of LlmSettings is about grading.
export type ProviderSettings = Pick<LlmSettings, 'baseUrl' | 'model'>

// 'auth' means the fix is in settings; the UI links there.
export type LlmErrorKind = 'auth' | 'rate-limit' | 'network' | 'timeout' | 'http' | 'bad-response'

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

export interface ChatCompletion {
  text: string
  model?: string // as reported by the provider
  usage?: LlmUsage
}

const SETTINGS_KEY = 'fluency:llm'
const API_KEY_KEY = 'fluency:llm-key'
const TIMEOUT_MS = 30_000

// `https://Example.com/v1/` → `https://example.com/v1`; null if not an http(s) URL.
export function normalizeBaseUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return (parsed.origin + parsed.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
}

const trimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export function loadLlmSettings(): LlmSettings {
  const stored = readStored(SETTINGS_KEY)
  return {
    enabled: stored?.enabled !== false,
    baseUrl: normalizeBaseUrl(trimmedString(stored?.baseUrl)) || OPENROUTER_URL,
    model: trimmedString(stored?.model) || DEFAULT_MODEL,
    feedbackLanguage: trimmedString(stored?.feedbackLanguage) || 'en',
    gradingRules: trimmedString(stored?.gradingRules),
  }
}

export const saveLlmSettings = (settings: LlmSettings) => writeStored(SETTINGS_KEY, settings)

// The key is stored with the base URL it was entered for and only returned for that
// URL, so changing providers can't send it to a server it wasn't meant for.
let memoryKey: { baseUrl: string; key: string } | null = null

function storedKey() {
  const stored = readStored(API_KEY_KEY)
  return typeof stored?.baseUrl === 'string' && typeof stored.key === 'string'
    ? { baseUrl: stored.baseUrl, key: stored.key }
    : null
}

export function getLlmApiKey(baseUrl: string): string | null {
  const entry = memoryKey ?? storedKey()
  return entry && entry.baseUrl === normalizeBaseUrl(baseUrl) ? entry.key : null
}

// Without `remember`, the key lasts until the app is closed.
export function setLlmApiKey(baseUrl: string, key: string, remember: boolean) {
  const url = normalizeBaseUrl(baseUrl)
  memoryKey = url && key.trim() ? { baseUrl: url, key: key.trim() } : null
  writeStored(API_KEY_KEY, remember ? memoryKey : null)
}

export const clearLlmApiKey = () => setLlmApiKey('', '', false)

// True if the key is kept on this device, or if there is no key yet (the default).
export const isLlmApiKeyRemembered = () => !memoryKey || storedKey() !== null

// The provider's own error message, if any (e.g. "model not found"), shortened.
async function providerMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null)
  const message = body?.error?.message
  return typeof message === 'string' ? ` (${message.slice(0, 200)})` : ''
}

async function httpError(response: Response): Promise<LlmError> {
  const { status } = response
  const detail = await providerMessage(response)
  if (status === 401 || status === 403) return new LlmError('auth', `The provider rejected the API key${detail}.`)
  if (status === 402) return new LlmError('auth', `The provider account is out of credits${detail}.`)
  if (status === 404) return new LlmError('auth', `Not found: check the URL and the model name${detail}.`)
  if (status === 429) return new LlmError('rate-limit', 'Too many requests. Try again in a moment.')
  return new LlmError('http', `The provider returned error ${status}${detail}.`)
}

const numberOrUndefined = (value: unknown) => (typeof value === 'number' ? value : undefined)

// One chat completion. Throws LlmError, or the abort reason if `signal` aborts.
export async function fetchChatCompletion(
  settings: ProviderSettings,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ChatCompletion> {
  const url = normalizeBaseUrl(settings.baseUrl)
  if (!url) throw new LlmError('auth', 'The provider URL is not valid.')

  // Our timeout plus the caller's signal (AbortSignal.any needs Safari 17.4+).
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setTimeout(
    () => controller.abort(new LlmError('timeout', "The provider didn't answer in time.")),
    TIMEOUT_MS,
  )

  try {
    const response = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      // OpenRouter: route only to backends that support every parameter we send
      // (response_format in particular).
      body: JSON.stringify({
        model: settings.model,
        ...body,
        ...(new URL(url).hostname === 'openrouter.ai' && { provider: { require_parameters: true } }),
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw await httpError(response)
    const json = await response.json().catch(() => null)
    const choice = json?.choices?.[0]
    const text = choice?.message?.content
    if (choice?.message?.refusal) throw new LlmError('bad-response', 'The model refused to answer.')
    if (choice?.finish_reason && choice.finish_reason !== 'stop') {
      throw new LlmError('bad-response', `The response was cut off (${choice.finish_reason}).`)
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new LlmError('bad-response', 'The provider sent an empty response.')
    }
    const usage = json.usage
    return {
      text,
      model: typeof json.model === 'string' ? json.model : undefined,
      usage: usage && {
        inputTokens: numberOrUndefined(usage.prompt_tokens),
        outputTokens: numberOrUndefined(usage.completion_tokens),
        cost: numberOrUndefined(usage.cost),
      },
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof LlmError) throw error
    throw new LlmError(
      'network',
      "Couldn't reach the provider. Check your connection and the URL; the provider may also block browser requests.",
    )
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
