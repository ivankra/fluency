// Google Drive: sign in and read/write a test file. Temporary, for checking the sign-in
// flow on each platform before sync is built (doc/drive-sync.md, Rollout step 1).
import { useEffect, useRef, useState } from 'react'
import {
  currentToken,
  deleteFile,
  downloadFile,
  findFiles,
  forgetToken,
  isDriveConfigured,
  isGoogleAuthLoaded,
  loadGoogleAuth,
  requestToken,
  uploadFile,
  type Token,
} from './gdrive'
import { isIosHomeScreenApp } from './speech'

const TEST_FILE = 'fluency-test.json'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Where this runs, so test results can be told apart across platforms.
const environment = () =>
  `${isIosHomeScreenApp() || matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser tab'}, ${navigator.userAgent}`

export default function DriveSettings() {
  if (!isDriveConfigured()) return null
  return <DriveTest />
}

function DriveTest() {
  const [loaded, setLoaded] = useState(isGoogleAuthLoaded)
  const [token, setToken] = useState<Token | null>(() => currentToken())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const running = useRef<AbortController | null>(null)

  // Load Google's script now, so Connect can open its popup straight from the tap.
  useEffect(() => {
    loadGoogleAuth().then(
      () => setLoaded(true),
      (error) => setStatus(errorText(error)),
    )
    return () => running.current?.abort()
  }, [])

  // Not async before requestToken: the popup must open within the tap.
  const connect = (prompt: 'consent' | '') => {
    setStatus('Waiting for Google…')
    requestToken(prompt).then(
      (granted) => {
        setToken(granted)
        setStatus('Connected.')
      },
      (error) => setStatus(errorText(error)),
    )
  }

  const disconnect = () => {
    forgetToken()
    setToken(null)
    setStatus('Disconnected. Files in Drive are kept.')
  }

  // Runs a Drive action with the current token, or asks to reconnect.
  const run = async (label: string, action: (token: Token, signal: AbortSignal) => Promise<string>) => {
    const valid = currentToken()
    if (!valid) {
      setToken(null)
      setStatus('Sign-in expired. Tap Reconnect.')
      return
    }
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    setStatus(`${label}…`)
    const started = performance.now()
    try {
      const result = await action(valid, controller.signal)
      setStatus(`${result} (${Math.round(performance.now() - started)} ms)`)
    } catch (error) {
      if (!controller.signal.aborted) setStatus(errorText(error))
      if (!currentToken()) setToken(null)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const write = () =>
    run('Writing', async (token, signal) => {
      const [existing] = await findFiles(token, TEST_FILE, signal)
      const data = JSON.stringify({ writtenAt: new Date().toISOString(), environment: environment() })
      const file = await uploadFile(token, { id: existing?.id ?? null, name: TEST_FILE, data, contentType: 'application/json' }, signal)
      return `Wrote ${TEST_FILE} (version ${file.version}).`
    })

  const read = () =>
    run('Reading', async (token, signal) => {
      const [existing] = await findFiles(token, TEST_FILE, signal)
      if (!existing) return 'No test file yet.'
      const text = new TextDecoder().decode(await downloadFile(token, existing.id, signal))
      return `Read version ${existing.version}: ${text.slice(0, 300)}`
    })

  const remove = () =>
    run('Deleting', async (token, signal) => {
      const files = await findFiles(token, TEST_FILE, signal)
      for (const file of files) await deleteFile(token, file.id, signal)
      return files.length ? `Deleted ${files.length} test ${files.length === 1 ? 'file' : 'files'}.` : 'No test file to delete.'
    })

  const expiresIn = token ? Math.max(0, Math.round((token.expiresAt - Date.now()) / 60_000)) : 0

  return (
    <section className="panel card-form">
      <h2>Google Drive (testing)</h2>
      <p className="muted">
        Checks signing in to Google and storing a small test file in Fluency's hidden folder in your Drive. Your decks
        aren't synced yet.
      </p>
      <p className="muted">
        {token ? `Connected; sign-in valid for about ${expiresIn} min.` : 'Not connected.'} Running in a {environment().split(',')[0]}.
      </p>
      <div className="card-form__actions drive-actions">
        {token ? (
          <>
            <button type="button" className="btn btn--small" disabled={busy} onClick={write}>
              Write test file
            </button>
            <button type="button" className="btn btn--small" disabled={busy} onClick={read}>
              Read test file
            </button>
            <button type="button" className="btn btn--small" disabled={busy} onClick={remove}>
              Delete test file
            </button>
            <button type="button" className="btn btn--small btn--danger" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--small" disabled={!loaded} onClick={() => connect('')}>
              Reconnect
            </button>
            <button type="button" className="btn btn--small btn--primary" disabled={!loaded} onClick={() => connect('consent')}>
              Connect Google Drive
            </button>
          </>
        )}
      </div>
      {status && <p role="status">{status}</p>}
    </section>
  )
}
