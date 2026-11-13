import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  OPENROUTER_URL,
  clearLlmApiKey,
  fetchChatCompletion,
  getLlmApiKey,
  isLlmApiKeyRemembered,
  loadLlmSettings,
  normalizeBaseUrl,
  saveLlmSettings,
  setLlmApiKey,
} from './llm'
import { href } from './route'

export default function Settings() {
  const [initial] = useState(loadLlmSettings)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [model, setModel] = useState(initial.model)
  const [apiKey, setApiKey] = useState(() => getLlmApiKey(initial.baseUrl) ?? '')
  const [remember, setRemember] = useState(isLlmApiKeyRemembered)
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const test = useRef<AbortController | null>(null)

  const custom = baseUrl !== OPENROUTER_URL
  const url = normalizeBaseUrl(baseUrl)

  // A key belongs to one provider: changing the URL means entering a key for the new one.
  const changeUrl = (next: string) => {
    setBaseUrl(next)
    setApiKey('')
  }

  // Any change makes an earlier or running test result stale.
  useEffect(() => {
    setStatus('')
    return () => {
      test.current?.abort()
      setTesting(false)
    }
  }, [baseUrl, model, apiKey])

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!url) return
    saveLlmSettings({ baseUrl: url, model: model.trim() })
    setLlmApiKey(url, apiKey, remember)
    setStatus('Saved.')
  }

  const testConnection = async () => {
    if (!url) return
    const ctrl = new AbortController()
    test.current = ctrl
    setTesting(true)
    setStatus('Testing…')
    try {
      const body = { messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 }
      await fetchChatCompletion({ baseUrl: url, model: model.trim() }, apiKey.trim(), body, ctrl.signal)
      if (!ctrl.signal.aborted) setStatus('Connection works.')
    } catch (err) {
      if (!ctrl.signal.aborted) setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      if (!ctrl.signal.aborted) setTesting(false)
    }
  }

  const clearKey = () => {
    clearLlmApiKey()
    setApiKey('')
  }

  const ready = url !== null && model.trim() !== '' && apiKey.trim() !== ''

  return (
    <>
      <header className="bar">
        <a className="btn" href={href.list} aria-label="Back to decks">
          ‹ Decks
        </a>
        <h1 className="bar__title">Settings</h1>
      </header>

      <form className="panel card-form" onSubmit={save}>
        <h2>LLM grading</h2>
        <p className="muted">
          Bring your own API key from an OpenAI-compatible provider. Checking an answer sends the
          sentence, the reference translation and your answer to that provider.
        </p>
        <label>
          <span>Provider</span>
          <select value={custom ? 'custom' : 'openrouter'} onChange={(e) => changeUrl(e.target.value === 'custom' ? '' : OPENROUTER_URL)}>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom URL</option>
          </select>
        </label>
        {custom && (
          <label>
            <span>Base URL</span>
            <input value={baseUrl} onChange={(e) => changeUrl(e.target.value)} placeholder="https://…/v1" inputMode="url" />
          </label>
        )}
        <label>
          <span>Model</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        <label>
          <span>API key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember the key on this device</span>
        </label>
        {status && <p role="status">{status}</p>}
        <div className="card-form__actions">
          <button type="button" className="btn btn--danger" onClick={clearKey} disabled={!apiKey}>
            Clear key
          </button>
          <button type="button" className="btn" onClick={testConnection} disabled={!ready || testing}>
            Test connection
          </button>
          <button className="btn btn--primary" disabled={!url || !model.trim()}>
            Save
          </button>
        </div>
      </form>
    </>
  )
}
