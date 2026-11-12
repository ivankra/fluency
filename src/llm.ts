// LLM provider settings, the API key, and one OpenAI-compatible chat request.

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_MODEL = 'google/gemini-2.5-flash' // placeholder until grading picks one

export interface LlmSettings {
  baseUrl: string
  model: string
}

export class LlmError extends Error {}

const SETTINGS_KEY = 'fluency:llm'
const API_KEY_KEY = 'fluency:llm-key'
const TIMEOUT_MS = 30_000

// localStorage can be unavailable or throw (private mode); treat that as "nothing stored".
function read(key: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function write(key: string, value: object | null) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  } catch {
    // Not persisted; in-memory state still applies.
  }
}

// `https://Example.com/v1/` → `https://example.com/v1`; null if not an http(s) URL.
export function normalizeBaseUrl(url: string): string | null {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? (u.origin + u.pathname).replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

export function loadLlmSettings(): LlmSettings {
  const s = read(SETTINGS_KEY)
  return {
    baseUrl: (typeof s?.baseUrl === 'string' && normalizeBaseUrl(s.baseUrl)) || OPENROUTER_URL,
    model: (typeof s?.model === 'string' && s.model.trim()) || DEFAULT_MODEL,
  }
}

export const saveLlmSettings = (s: LlmSettings) => write(SETTINGS_KEY, s)

// The key is stored with the base URL it was entered for and only returned for that
// URL, so changing providers can't send it to a server it wasn't meant for.
let memoryKey: { baseUrl: string; key: string } | null = null

const storedKey = () => {
  const v = read(API_KEY_KEY)
  return typeof v?.baseUrl === 'string' && typeof v.key === 'string' ? { baseUrl: v.baseUrl, key: v.key } : null
}

export function getLlmApiKey(baseUrl: string): string | null {
  const entry = memoryKey ?? storedKey()
  return entry && entry.baseUrl === normalizeBaseUrl(baseUrl) ? entry.key : null
}

// Without `remember`, the key lasts until the app is closed.
export function setLlmApiKey(baseUrl: string, key: string, remember: boolean) {
  const url = normalizeBaseUrl(baseUrl)
  memoryKey = url && key.trim() ? { baseUrl: url, key: key.trim() } : null
  write(API_KEY_KEY, remember ? memoryKey : null)
}

export const clearLlmApiKey = () => setLlmApiKey('', '', false)

// True if the key is kept on this device, or if there is no key yet (the default).
export const isLlmApiKeyRemembered = () => !memoryKey || storedKey() !== null

function httpError(status: number): LlmError {
  if (status === 401 || status === 403) return new LlmError('The provider rejected the API key.')
  if (status === 402) return new LlmError('The provider account is out of credits.')
  if (status === 404) return new LlmError('Not found: check the URL and the model name.')
  if (status === 429) return new LlmError('Too many requests. Try again in a moment.')
  return new LlmError(`The provider returned error ${status}.`)
}

// One chat completion; returns the reply text. Throws LlmError, or the abort reason
// if `signal` aborts.
export async function fetchChatCompletion(
  s: LlmSettings,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const url = normalizeBaseUrl(s.baseUrl)
  if (!url) throw new LlmError('The provider URL is not valid.')

  // Our timeout plus the caller's signal (AbortSignal.any needs Safari 17.4+).
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setTimeout(() => ctrl.abort(new LlmError("The provider didn't answer in time.")), TIMEOUT_MS)

  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: s.model, ...body }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw httpError(res.status)
    const json = await res.json().catch(() => null)
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) throw new LlmError('The provider sent an empty response.')
    return text
  } catch (e) {
    if (ctrl.signal.aborted) throw ctrl.signal.reason
    if (e instanceof LlmError) throw e
    throw new LlmError(
      "Couldn't reach the provider. Check your connection and the URL; the provider may also block browser requests.",
    )
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
