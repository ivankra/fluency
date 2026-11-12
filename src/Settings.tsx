import { useEffect, useRef, useState, type FormEvent } from 'react'
import LanguagePicker from './LanguagePicker'
import { assessAnswer, DEFAULT_GRADING_RULES } from './grader'
import {
  OPENROUTER_URL,
  clearLlmApiKey,
  getLlmApiKey,
  isLlmApiKeyRemembered,
  loadLlmSettings,
  normalizeBaseUrl,
  saveLlmSettings,
  setLlmApiKey,
} from './llm'
import { href } from './route'

const MAX_RULES_LENGTH = 1000

// Test connection grades this fixed example through the real grading path, which also
// checks that the model supports structured output.
const TEST_EXAMPLE = {
  sourceLanguage: 'en',
  targetLanguage: 'es',
  source: 'I would like a coffee, please.',
  reference: 'Quisiera un café, por favor.',
  answer: 'Quiero un cafe por favor.',
}

export default function Settings() {
  const [initial] = useState(loadLlmSettings)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [model, setModel] = useState(initial.model)
  const [apiKey, setApiKey] = useState(() => getLlmApiKey(initial.baseUrl) ?? '')
  const [remember, setRemember] = useState(isLlmApiKeyRemembered)
  const [feedbackLanguage, setFeedbackLanguage] = useState(initial.feedbackLanguage)
  const [gradingRules, setGradingRules] = useState(initial.gradingRules || DEFAULT_GRADING_RULES)
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const runningTest = useRef<AbortController | null>(null)

  const custom = baseUrl !== OPENROUTER_URL
  const url = normalizeBaseUrl(baseUrl)
  // Stored empty while equal to the default, so later improvements to it apply.
  const storedRules = gradingRules.trim() === DEFAULT_GRADING_RULES ? '' : gradingRules.trim()

  // A key belongs to one provider: changing the URL means entering a key for the new one.
  const changeUrl = (next: string) => {
    setBaseUrl(next)
    setApiKey('')
  }

  // Any change makes an earlier or running test result stale.
  useEffect(() => {
    setStatus('')
    return () => {
      runningTest.current?.abort()
      setTesting(false)
    }
  }, [baseUrl, model, apiKey, feedbackLanguage, gradingRules])

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!url || !valid) return
    saveLlmSettings({ enabled, baseUrl: url, model: model.trim(), feedbackLanguage, gradingRules: storedRules })
    setLlmApiKey(url, apiKey, remember)
    setStatus('Saved.')
  }

  const testConnection = async () => {
    if (!url || !ready) return
    const controller = new AbortController()
    runningTest.current = controller
    setTesting(true)
    setStatus('Testing…')
    try {
      const input = { ...TEST_EXAMPLE, feedbackLanguage, gradingRules: storedRules }
      const { assessment } = await assessAnswer(input, { baseUrl: url, model: model.trim() }, apiKey.trim(), controller.signal)
      if (!controller.signal.aborted) setStatus(`Works. Test answer graded ${assessment.grade}/3: ${assessment.summary}`)
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted) setTesting(false)
    }
  }

  const clearKey = () => {
    clearLlmApiKey()
    setApiKey('')
  }

  const valid = url !== null && model.trim() !== '' && feedbackLanguage !== ''
  const ready = valid && apiKey.trim() !== ''

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
          sentence, the reference translation, your answer and the deck's languages to that provider.
        </p>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>Check my answers with the LLM</span>
        </label>
        <label>
          <span>Provider</span>
          <select
            value={custom ? 'custom' : 'openrouter'}
            onChange={(event) => changeUrl(event.target.value === 'custom' ? '' : OPENROUTER_URL)}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom URL</option>
          </select>
        </label>
        {custom && (
          <label>
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => changeUrl(event.target.value)}
              placeholder="https://…/v1"
              inputMode="url"
            />
          </label>
        )}
        <label>
          <span>Model</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
        <label>
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>Remember the key on this device</span>
        </label>
        <label>
          <span>Feedback language</span>
          <LanguagePicker value={feedbackLanguage} onChange={setFeedbackLanguage} label="Feedback language" />
        </label>
        <label>
          <span>Grading rules</span>
          <textarea
            value={gradingRules}
            onChange={(event) => setGradingRules(event.target.value)}
            maxLength={MAX_RULES_LENGTH}
            rows={4}
          />
        </label>
        <p className="muted">
          How strict to be, e.g. “Missing accents are fine; mention them as a suggestion.” or “Treat a
          wrong kanji with the right reading as a typo.”{' '}
          {storedRules && (
            <button type="button" className="btn btn--small" onClick={() => setGradingRules(DEFAULT_GRADING_RULES)}>
              Reset to default
            </button>
          )}
        </p>
        {status && <p role="status">{status}</p>}
        <div className="card-form__actions">
          <button type="button" className="btn btn--danger" onClick={clearKey} disabled={!apiKey}>
            Clear key
          </button>
          <button type="button" className="btn" onClick={testConnection} disabled={!ready || testing}>
            Test connection
          </button>
          <button className="btn btn--primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </>
  )
}
