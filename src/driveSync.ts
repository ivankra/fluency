// The app's sync engine, wired to the real Drive, database and browser. Kept apart
// from sync.ts so the engine is tested without them.
import { changeCount, onChange } from './changes'
import { applyMerge, snapshot } from './db'
import * as gdrive from './gdrive'
import { readStored, writeStored } from './storage'
import { startSyncTriggers, SyncEngine, type SyncRecord } from './sync'

const RECORD_KEY = 'fluency:sync'

function loadRecord(): SyncRecord | null {
  const stored = readStored(RECORD_KEY)
  if (stored?.connected !== true) return null
  const string = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    connected: true,
    fileId: string(stored.fileId),
    version: string(stored.version),
    changeCount: number(stored.changeCount),
    lastSyncAt: number(stored.lastSyncAt),
    firstSyncDone: stored.firstSyncDone === true,
    sampleIds: stored.sampleIds === true,
  }
}

export const syncEngine = new SyncEngine({
  configured: gdrive.isDriveConfigured,
  token: () => gdrive.currentToken(),
  requestToken: gdrive.requestToken,
  forgetToken: gdrive.forgetToken,
  findFiles: gdrive.findFiles,
  downloadFile: gdrive.downloadFile,
  uploadFile: gdrive.uploadFile,
  deleteFile: gdrive.deleteFile,
  snapshot,
  applyMerge,
  changeCount,
  online: () => navigator.onLine,
  now: Date.now,
  loadRecord,
  saveRecord: (record) => writeStored(RECORD_KEY, record),
})

// Called once at startup. Does nothing in builds without a Google client ID.
export function startDriveSync() {
  if (!gdrive.isDriveConfigured()) return
  startSyncTriggers(syncEngine, onChange)
  // The status button needs Google's script ready before the user taps it.
  if (syncEngine.connected) void gdrive.loadGoogleAuth().catch(() => {})
}
