// Drive sync engine: when to sync, one sync at a time, and what one sync does. Drive,
// the database, the clock and saved state are injected, so it is tested without a
// network or IndexedDB (sync.test.ts). Design: doc/drive-sync.md.
import type { Snapshot } from './db'
import { DriveError, type RemoteFile, type Token } from './gdrive'
import { merge } from './merge'
import { normalizeSampleDecks } from './sampleIdentity'
import { decodeSyncFile, encodeSyncFile, SYNC_CONTENT_TYPE, SYNC_FILE_NAME, SyncFileError } from './syncFile'

export type SyncStatus =
  | { state: 'off' } // not configured, or not connected
  | { state: 'idle'; lastSyncAt?: number }
  | { state: 'syncing'; lastSyncAt?: number }
  | { state: 'paused'; reason: 'token' | 'offline'; lastSyncAt?: number } // token: needs a tap
  | { state: 'error'; message: string; lastSyncAt?: number }

// What this device remembers between syncs (localStorage).
export interface SyncRecord {
  connected: boolean
  fileId?: string
  version?: string // of the Drive file when this device last uploaded or merged it
  changeCount?: number // local change count at that time
  lastSyncAt?: number
  firstSyncDone?: boolean
  // This device's data went through normalizeSampleDecks (added later). Until then, the
  // shortcuts below that skip the merge are off, so duplicates from before get fixed.
  sampleIds?: boolean
}

export interface SyncDeps {
  configured(): boolean
  token(): Token | null
  requestToken(prompt: 'consent' | ''): Promise<Token>
  forgetToken(): void
  findFiles(token: Token, name: string, signal: AbortSignal): Promise<RemoteFile[]>
  downloadFile(token: Token, id: string, signal: AbortSignal): Promise<Uint8Array>
  uploadFile(token: Token, file: { id: string | null; name: string; data: Uint8Array; contentType: string }, signal: AbortSignal): Promise<RemoteFile>
  deleteFile(token: Token, id: string, signal: AbortSignal): Promise<void>
  snapshot(): Promise<Snapshot>
  applyMerge(before: Snapshot, result: Snapshot): Promise<boolean>
  changeCount(): number
  online(): boolean
  now(): number
  loadRecord(): SyncRecord | null
  saveRecord(record: SyncRecord | null): void
}

const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000]
// applyMerge refuses if the database changed while merging; merge again this often.
const MAX_MERGE_ATTEMPTS = 3

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class SyncEngine {
  private record: SyncRecord | null
  private status: SyncStatus
  private listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private again = false // a trigger arrived during a sync: run once more after it
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null

  constructor(private deps: SyncDeps) {
    this.record = deps.configured() ? deps.loadRecord() : null
    this.status = this.record?.connected ? { state: 'idle', lastSyncAt: this.record.lastSyncAt } : { state: 'off' }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getStatus = () => this.status

  get connected() {
    return !!this.record?.connected
  }

  private setStatus(status: SyncStatus) {
    this.status = status
    for (const listener of this.listeners) listener()
  }

  private saveRecord(record: SyncRecord | null) {
    this.record = record
    this.deps.saveRecord(record)
  }

  // --- Actions from taps. Each asks Google for a token before any await, so the
  // sign-in popup opens within the tap. ---

  // First connect: asks for permission, then syncs (merging with Drive if it has data).
  async connect(): Promise<void> {
    const token = this.deps.requestToken('consent')
    try {
      await token
    } catch (error) {
      this.setStatus(this.connected ? { state: 'paused', reason: 'token' } : { state: 'error', message: message(error) })
      return
    }
    this.saveRecord({ ...this.record, connected: true })
    this.failures = 0
    await this.run()
  }

  // Sync now, signing in again first if the token has expired.
  async syncNow(): Promise<void> {
    if (!this.connected) return
    if (!this.deps.token()) {
      try {
        await this.deps.requestToken('')
      } catch {
        this.setStatus({ state: 'paused', reason: 'token', lastSyncAt: this.record?.lastSyncAt })
        return
      }
    }
    this.failures = 0
    await this.run()
  }

  // Stops syncing and signs out. Data stays on this device and in Drive.
  disconnect() {
    this.controller?.abort()
    this.clearRetry()
    this.deps.forgetToken()
    this.saveRecord(null)
    this.setStatus({ state: 'off' })
  }

  // Deletes the sync file from Drive, then disconnects. Local data is kept.
  async deleteFromDrive(): Promise<void> {
    const token = this.deps.token() ?? (await this.deps.requestToken(''))
    const signal = new AbortController().signal
    for (const file of await this.deps.findFiles(token, SYNC_FILE_NAME, signal)) await this.deps.deleteFile(token, file.id, signal)
    this.disconnect()
  }

  // --- Automatic triggers (start, after a change, back to the app, timer, online) ---

  // Runs a sync unless one is running, in which case one more follows it. Never opens
  // a popup: without a valid token it pauses until the user taps.
  trigger(): Promise<void> {
    if (!this.connected) return Promise.resolve()
    if (this.retryTimer) return Promise.resolve() // backing off after an error
    return this.run()
  }

  dispose() {
    this.controller?.abort()
    this.clearRetry()
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.syncOnce()
      } while (this.again && this.connected && this.status.state === 'idle')
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async syncOnce() {
    const lastSyncAt = this.record?.lastSyncAt
    if (!this.deps.online()) return this.setStatus({ state: 'paused', reason: 'offline', lastSyncAt })
    const token = this.deps.token()
    if (!token) return this.setStatus({ state: 'paused', reason: 'token', lastSyncAt })

    this.clearRetry()
    this.controller = new AbortController()
    const { signal } = this.controller
    this.setStatus({ state: 'syncing', lastSyncAt })
    try {
      await this.exchange(token, signal)
      this.failures = 0
      this.setStatus({ state: 'idle', lastSyncAt: this.record?.lastSyncAt })
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof DriveError && error.kind === 'auth') {
        return this.setStatus({ state: 'paused', reason: 'token', lastSyncAt })
      }
      if (error instanceof DriveError && error.kind === 'network' && !this.deps.online()) {
        return this.setStatus({ state: 'paused', reason: 'offline', lastSyncAt })
      }
      this.setStatus({ state: 'error', message: message(error), lastSyncAt })
      // Retry later, unless the file needs a newer app.
      if (!(error instanceof SyncFileError && error.reason === 'newer-format')) {
        const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]
        this.failures++
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.trigger()
        }, delay)
      }
    }
  }

  // One sync: download, merge, write locally, upload, as needed.
  private async exchange(token: Token, signal: AbortSignal) {
    const record = this.record!
    const files = [...(await this.deps.findFiles(token, SYNC_FILE_NAME, signal))].sort((a, b) => (a.id < b.id ? -1 : 1))
    const [primary, ...extras] = files
    const remoteUnchanged =
      !!primary && !extras.length && primary.id === record.fileId && primary.version === record.version && !!record.sampleIds
    const changes = this.deps.changeCount()

    // Nothing changed on either side since the last sync: one list request, done.
    if (remoteUnchanged && changes === record.changeCount && record.firstSyncDone) {
      return this.finish({ fileId: primary.id, version: primary.version, changeCount: changes })
    }

    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
      const count = this.deps.changeCount()
      const local = await this.deps.snapshot()

      // Drive still holds what this device last synced, and this device has only made
      // changes of its own since: its database is the merged state, so just upload it.
      if (remoteUnchanged && record.firstSyncDone) {
        const uploaded = await this.deps.uploadFile(token, this.file(primary.id, await encodeSyncFile(local)), signal)
        return this.finish({ fileId: uploaded.id, version: uploaded.version, changeCount: count })
      }

      // Combine every copy in Drive (normally one; two if devices created it at once).
      let downloaded: Snapshot = { decks: [], cards: [], reviews: [], deletions: [] }
      for (const file of files) downloaded = merge(downloaded, await decodeSyncFile(await this.deps.downloadFile(token, file.id, signal))).result

      // Sample decks from before they had fixed ids get them on both sides, so each
      // device's copy becomes the same deck instead of a duplicate.
      const remote = normalizeSampleDecks(downloaded)
      const mine = normalizeSampleDecks(local)

      const { result, remoteChanged } = merge(mine, remote)
      if (!(await this.deps.applyMerge(local, result))) continue // changed meanwhile: merge again
      if (signal.aborted) throw signal.reason

      let target = primary
      if (!primary || extras.length || remoteChanged || remote !== downloaded) {
        target = await this.deps.uploadFile(token, this.file(primary?.id ?? null, await encodeSyncFile(result)), signal)
      }
      for (const extra of extras) await this.deps.deleteFile(token, extra.id, signal)
      return this.finish({ fileId: target.id, version: target.version, changeCount: count })
    }
    throw new Error('The data kept changing during sync; it will try again.')
  }

  private file(id: string | null, data: Uint8Array) {
    return { id, name: SYNC_FILE_NAME, data, contentType: SYNC_CONTENT_TYPE }
  }

  private finish(update: Pick<SyncRecord, 'fileId' | 'version' | 'changeCount'>) {
    this.saveRecord({ ...this.record!, ...update, lastSyncAt: this.deps.now(), firstSyncDone: true, sampleIds: true })
  }
}

// Wires the automatic triggers to the browser: start, a few seconds after a local
// change, back to the app, back online, and every 5 minutes while visible.
export function startSyncTriggers(engine: SyncEngine, onLocalChange: (listener: () => void) => () => void): () => void {
  const AFTER_CHANGE_MS = 5_000
  const EVERY_MS = 5 * 60_000
  let debounce: ReturnType<typeof setTimeout> | null = null
  const run = () => void engine.trigger()
  const onVisible = () => document.visibilityState === 'visible' && run()
  const stopChanges = onLocalChange(() => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(run, AFTER_CHANGE_MS)
  })
  const timer = setInterval(() => document.visibilityState === 'visible' && run(), EVERY_MS)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', run)
  run()
  return () => {
    stopChanges()
    if (debounce) clearTimeout(debounce)
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', run)
  }
}
