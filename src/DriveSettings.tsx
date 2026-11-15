// Settings → Google Drive sync: connect, status, sync now, disconnect. Design:
// doc/drive-sync.md.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { syncEngine } from './driveSync'
import { isDriveConfigured, isGoogleAuthLoaded, loadGoogleAuth } from './gdrive'
import type { SyncStatus } from './sync'
import { href } from './route'
import { formatAgo } from './time'

export const PRIVACY_NOTE =
  "Your decks, cards and review history, including your answers and feedback, are stored in a hidden app folder in your Google Drive. Fluency can't see your other files. Settings and your LLM API key are not synced."

// Google's script must be loaded before a tap that signs in (gdrive.ts).
export function useGoogleAuthReady() {
  const [ready, setReady] = useState(isGoogleAuthLoaded)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadGoogleAuth().then(
      () => live && setReady(true),
      (failure) => live && setError(failure instanceof Error ? failure.message : String(failure)),
    )
    return () => void (live = false)
  }, [])
  return { ready, error }
}

export function describeSync(status: SyncStatus, now = Date.now()): string {
  const last = 'lastSyncAt' in status && status.lastSyncAt ? ` Last synced ${formatAgo(now - status.lastSyncAt)}.` : ''
  switch (status.state) {
    case 'off':
      return 'Not connected.'
    case 'idle':
      return status.lastSyncAt ? `Synced ${formatAgo(now - status.lastSyncAt)}.` : 'Connected.'
    case 'syncing':
      return `Syncing…${last}`
    case 'paused':
      return status.reason === 'offline'
        ? `Offline; syncs when you're back online.${last}`
        : `Paused: Google sign-in expired. Tap Sync now to continue.${last}`
    case 'error':
      return `${status.message}${last}`
  }
}

export default function DriveSettings() {
  if (!isDriveConfigured()) return null
  return <DriveSync />
}

function DriveSync() {
  const status = useSyncExternalStore(syncEngine.subscribe, syncEngine.getStatus)
  const google = useGoogleAuthReady()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const connected = status.state !== 'off'

  // Each starts with the sign-in call (inside the engine) before any await.
  const act = (action: () => Promise<void>, done = '') => {
    setNote('')
    setBusy(true)
    action().then(
      () => setNote(done),
      (error) => setNote(error instanceof Error ? error.message : String(error)),
    ).finally(() => setBusy(false))
  }

  const disconnect = () => {
    if (!confirm('Stop syncing on this device? Your data stays on this device and in Google Drive.')) return
    syncEngine.disconnect()
    setNote('Disconnected. Your data is still on this device and in Google Drive.')
  }

  const deleteFromDrive = () => {
    if (!confirm("Delete Fluency's data from your Google Drive? Data on this device is kept, and this device stops syncing. Other devices will upload their copy again when they sync.")) return
    act(() => syncEngine.deleteFromDrive(), 'Deleted from Google Drive. This device no longer syncs.')
  }

  return (
    <section className="panel card-form">
      <h2>Google Drive sync</h2>
      <p className="muted">
        Keep your decks, cards and progress the same on all your devices. Syncs automatically while the app is open;
        after about an hour Google needs you to tap Sync now once to continue.
      </p>
      <p role="status">{describeSync(status)}</p>
      {google.error && <p className="feedback__error">{google.error}</p>}
      <div className="card-form__actions drive-actions">
        {connected ? (
          <>
            <button type="button" className="btn btn--small btn--danger" disabled={busy} onClick={deleteFromDrive}>
              Delete data from Drive
            </button>
            <button type="button" className="btn btn--small" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
            <button
              type="button"
              className="btn btn--small btn--primary"
              disabled={busy || !google.ready || status.state === 'syncing'}
              onClick={() => act(() => syncEngine.syncNow())}
            >
              Sync now
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--small btn--primary" disabled={busy || !google.ready} onClick={() => act(() => syncEngine.connect())}>
            Connect Google Drive
          </button>
        )}
      </div>
      {note && <p className="muted">{note}</p>}
      <p className="muted">{PRIVACY_NOTE}</p>
    </section>
  )
}

// One line under the deck list's header while sync is on: the status, plus a button
// when it needs a tap.
export function SyncStatusLine() {
  const status = useSyncExternalStore(syncEngine.subscribe, syncEngine.getStatus)
  if (!isDriveConfigured() || status.state === 'off') return null
  return <SyncStatusContent status={status} />
}

function SyncStatusContent({ status }: { status: SyncStatus }) {
  const google = useGoogleAuthReady()
  const paused = status.state === 'paused' && status.reason === 'token'
  return (
    <p className="sync-status muted" role="status">
      <span>{status.state === 'error' ? `Sync error: ${status.message}` : describeSync(status).replace(' Tap Sync now to continue.', '')}</span>
      {paused && (
        <button type="button" className="btn btn--small" disabled={!google.ready} onClick={() => void syncEngine.syncNow()}>
          Sync now
        </button>
      )}
      {status.state === 'error' && (
        <a className="btn btn--small" href={href.settings}>
          Details
        </a>
      )}
    </p>
  )
}
