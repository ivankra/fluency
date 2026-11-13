import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLlmApiKey, getLlmApiKey, isLlmApiKeyRemembered, normalizeBaseUrl, setLlmApiKey } from './llm'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
})

beforeEach(() => {
  clearLlmApiKey()
  store.clear()
})

describe('API key', () => {
  it('is only returned for the URL it was entered for', () => {
    setLlmApiKey('https://openrouter.ai/api/v1', 'sk-1', true)
    expect(getLlmApiKey('https://OpenRouter.ai/api/v1/')).toBe('sk-1')
    expect(getLlmApiKey('https://evil.example/v1')).toBeNull()
  })

  it('is kept in localStorage only when remembered', () => {
    setLlmApiKey('https://a.example/v1', 'sk-1', false)
    expect(store.size).toBe(0)
    expect(isLlmApiKeyRemembered()).toBe(false)
    setLlmApiKey('https://a.example/v1', 'sk-1', true)
    expect(store.size).toBe(1)
    clearLlmApiKey()
    expect(store.size).toBe(0)
    expect(getLlmApiKey('https://a.example/v1')).toBeNull()
  })
})

describe('normalizeBaseUrl', () => {
  it('accepts only http(s) URLs', () => {
    expect(normalizeBaseUrl(' https://Example.com/v1// ')).toBe('https://example.com/v1')
    expect(normalizeBaseUrl('ftp://example.com')).toBeNull()
    expect(normalizeBaseUrl('not a url')).toBeNull()
  })
})
