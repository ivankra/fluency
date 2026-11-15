// Google sign-in (Google Identity Services token model, no backend) and the Drive REST
// calls sync needs, on files in the hidden app data folder. Design: doc/drive-sync.md.
import { readStored, writeStored } from './storage'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client'
const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const TOKEN_KEY = 'fluency:drive-token'
const TIMEOUT_MS = 30_000
const RETRY_DELAY_MS = 1_000
// A token this close to expiring is treated as expired, so a sync can't start with one
// that runs out halfway.
const EXPIRY_MARGIN_MS = 2 * 60_000

// 'auth' means a tap is needed (sign in again); 'quota' means the user's Drive is full.
export type DriveErrorKind = 'auth' | 'network' | 'quota' | 'http' | 'bad-file'

export class DriveError extends Error {
  constructor(
    readonly kind: DriveErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface Token {
  accessToken: string
  expiresAt: number // ms
}

export interface RemoteFile {
  id: string
  name: string
  version: string // increases on every change; Drive returns it as a string
  size: number
}

// An OAuth client ID is public, not a secret. Without one, the app has no sync UI.
const clientId = () => (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
export const isDriveConfigured = () => clientId() !== ''

// --- Google Identity Services ---

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
  error_description?: string
}

interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback?: (error: { type?: string; message?: string }) => void
      }): { requestAccessToken(overrides?: { prompt?: string }): void }
      revoke(token: string, done?: () => void): void
    }
  }
}

const gis = () => (globalThis as { google?: Gis }).google

let gisLoading: Promise<void> | null = null

// Loads Google's sign-in script. Call it before the user taps Connect: requestToken
// must run straight from the tap, or browsers block its popup.
export function loadGoogleAuth(): Promise<void> {
  if (gis()?.accounts?.oauth2) return Promise.resolve()
  gisLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SCRIPT
    script.async = true
    script.onload = () => (gis()?.accounts?.oauth2 ? resolve() : reject(new Error('no oauth2')))
    script.onerror = () => reject(new Error('load failed'))
    document.head.append(script)
  }).catch(() => {
    gisLoading = null // so a later call can try again
    throw new DriveError('network', "Couldn't load Google sign-in. Check your connection.")
  })
  return gisLoading
}

export const isGoogleAuthLoaded = () => !!gis()?.accounts?.oauth2

// Opens Google's sign-in popup. Call it directly from a tap, after loadGoogleAuth.
// 'consent' asks for permission (first connect); '' reuses it, so the popup usually
// closes by itself.
export function requestToken(prompt: 'consent' | ''): Promise<Token> {
  const oauth2 = gis()?.accounts?.oauth2
  if (!oauth2) return Promise.reject(new DriveError('network', 'Google sign-in is still loading. Try again.'))
  if (!isDriveConfigured()) return Promise.reject(new DriveError('auth', 'Google Drive sync is not set up in this build.'))
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId(),
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new DriveError('auth', response.error === 'access_denied' ? 'Access to Google Drive was denied.' : "Couldn't sign in to Google."))
          return
        }
        // With granular consent the user can untick the Drive permission.
        if (!response.scope?.split(' ').includes(DRIVE_SCOPE)) {
          reject(new DriveError('auth', 'Fluency needs permission to store its data in your Google Drive.'))
          return
        }
        const seconds = Number(response.expires_in)
        const token = { accessToken: response.access_token, expiresAt: Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 }
        writeStored(TOKEN_KEY, token)
        resolve(token)
      },
      error_callback: (error) =>
        reject(
          new DriveError(
            'auth',
            error.type === 'popup_closed'
              ? 'The Google sign-in window was closed.'
              : error.type === 'popup_failed_to_open'
                ? "Google sign-in couldn't open its window. Allow pop-ups for this site and try again."
                : "Couldn't sign in to Google.",
          ),
        ),
    })
    client.requestAccessToken({ prompt })
  })
}

// The saved token, or null if there is none or it is about to expire.
export function currentToken(now = Date.now()): Token | null {
  const stored = readStored(TOKEN_KEY)
  if (typeof stored?.accessToken !== 'string' || typeof stored.expiresAt !== 'number') return null
  return stored.expiresAt - EXPIRY_MARGIN_MS > now ? { accessToken: stored.accessToken, expiresAt: stored.expiresAt } : null
}

const dropToken = () => writeStored(TOKEN_KEY, null)

// Signs out: forgets the token and asks Google to revoke it. Data in Drive is kept.
export function forgetToken() {
  const token = readStored(TOKEN_KEY)?.accessToken
  dropToken()
  if (typeof token === 'string') gis()?.accounts?.oauth2?.revoke(token)
}

// --- Drive REST ---

async function driveError(response: Response): Promise<DriveError> {
  const body = await response.json().catch(() => null)
  const reasons: unknown[] = Array.isArray(body?.error?.errors) ? body.error.errors.map((e: { reason?: unknown }) => e?.reason) : []
  const message = typeof body?.error?.message === 'string' ? ` (${body.error.message.slice(0, 200)})` : ''
  if (response.status === 401) {
    dropToken()
    return new DriveError('auth', 'Google sign-in expired. Tap to sign in again.')
  }
  if (reasons.includes('storageQuotaExceeded')) return new DriveError('quota', 'Your Google Drive is full.')
  return new DriveError('http', `Google Drive returned error ${response.status}${message}.`)
}

const isRateLimit = async (response: Response) => {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  const reasons = Array.isArray(body?.error?.errors) ? body.error.errors.map((e: { reason?: unknown }) => e?.reason) : []
  return reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })

// One authorized request with a timeout; retries once on a rate limit. Throws
// DriveError, or the abort reason if `signal` aborts.
async function request(token: Token, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new DriveError('network', "Google Drive didn't answer in time.")), TIMEOUT_MS)
  const send = () =>
    fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token.accessToken}` },
      signal: controller.signal,
    })
  try {
    let response = await send()
    if (await isRateLimit(response)) {
      await sleep(RETRY_DELAY_MS, controller.signal)
      response = await send()
    }
    if (!response.ok) throw await driveError(response)
    return response
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof DriveError) throw error
    throw new DriveError('network', "Couldn't reach Google Drive. Check your connection.")
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

const FILE_FIELDS = 'id,name,version,size'

function toRemoteFile(data: unknown): RemoteFile {
  const file = data as Record<string, unknown> | null
  if (typeof file?.id !== 'string' || typeof file.name !== 'string') throw new DriveError('bad-file', 'Google Drive sent an unexpected reply.')
  return { id: file.id, name: file.name, version: String(file.version ?? ''), size: Number(file.size ?? 0) }
}

const json = async (response: Response) => {
  try {
    return await response.json()
  } catch {
    throw new DriveError('bad-file', 'Google Drive sent an unexpected reply.')
  }
}

// Files with this name in the app data folder; normally zero or one.
export async function findFiles(token: Token, name: string, signal: AbortSignal): Promise<RemoteFile[]> {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`,
    fields: `files(${FILE_FIELDS})`,
    pageSize: '100',
  })
  const body = await json(await request(token, `${FILES_URL}?${params}`, {}, signal))
  if (!Array.isArray(body?.files)) throw new DriveError('bad-file', 'Google Drive sent an unexpected reply.')
  return body.files.map(toRemoteFile)
}

export async function downloadFile(token: Token, id: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await request(token, `${FILES_URL}/${encodeURIComponent(id)}?alt=media`, {}, signal)
  return new Uint8Array(await response.arrayBuffer())
}

// Creates the file in the app data folder when `id` is null, otherwise replaces its
// content.
export async function uploadFile(
  token: Token,
  file: { id: string | null; name: string; data: Uint8Array | string; contentType: string },
  signal: AbortSignal,
): Promise<RemoteFile> {
  const data = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data
  if (file.id) {
    const url = `${UPLOAD_URL}/${encodeURIComponent(file.id)}?uploadType=media&fields=${FILE_FIELDS}`
    const response = await request(token, url, { method: 'PATCH', headers: { 'Content-Type': file.contentType }, body: data as BodyInit }, signal)
    return toRemoteFile(await json(response))
  }
  const boundary = `fluency-${crypto.randomUUID()}`
  const metadata = JSON.stringify({ name: file.name, parents: ['appDataFolder'] })
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    data as BlobPart,
    `\r\n--${boundary}--`,
  ])
  const url = `${UPLOAD_URL}?uploadType=multipart&fields=${FILE_FIELDS}`
  const response = await request(token, url, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, signal)
  return toRemoteFile(await json(response))
}

export async function deleteFile(token: Token, id: string, signal: AbortSignal): Promise<void> {
  await request(token, `${FILES_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' }, signal)
}
