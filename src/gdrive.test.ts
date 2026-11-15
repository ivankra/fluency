import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  currentToken,
  deleteFile,
  downloadFile,
  DRIVE_SCOPE,
  DriveError,
  findFiles,
  forgetToken,
  requestToken,
  uploadFile,
  type Token,
} from './gdrive'

// A minimal localStorage for the node test environment.
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
} as Storage

const NOW = Date.UTC(2026, 10, 1)
const token: Token = { accessToken: 'secret-token', expiresAt: NOW + 3600_000 }
const signal = new AbortController().signal

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const apiError = (status: number, reason: string) => reply(status, { error: { code: status, message: `msg ${reason}`, errors: [{ reason }] } })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client-123.apps.googleusercontent.com')
})
afterEach(() => {
  store.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const call = (index = 0) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
  return { url: new URL(url), init, headers: init.headers as Record<string, string> }
}

describe('Drive requests', () => {
  it('lists files by name in the app data folder, with the token', async () => {
    fetchMock.mockResolvedValue(reply(200, { files: [{ id: 'f1', name: "it's.json", version: '7', size: '12' }] }))
    expect(await findFiles(token, "it's.json", signal)).toEqual([{ id: 'f1', name: "it's.json", version: '7', size: 12 }])
    const { url, headers } = call()
    expect(url.searchParams.get('spaces')).toBe('appDataFolder')
    expect(url.searchParams.get('q')).toBe("name = 'it\\'s.json' and trashed = false")
    expect(headers.Authorization).toBe('Bearer secret-token')
  })

  it('creates a file in the app data folder with a multipart upload', async () => {
    fetchMock.mockResolvedValue(reply(200, { id: 'new', name: 'a.json', version: '1', size: '2' }))
    const file = await uploadFile(token, { id: null, name: 'a.json', data: '{}', contentType: 'application/json' }, signal)
    expect(file).toEqual({ id: 'new', name: 'a.json', version: '1', size: 2 })
    const { url, init, headers } = call()
    expect(init.method).toBe('POST')
    expect(url.searchParams.get('uploadType')).toBe('multipart')
    const boundary = headers['Content-Type'].match(/boundary=(.+)$/)![1]
    const body = await (init.body as Blob).text()
    expect(body).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.json","parents":["appDataFolder"]}`)
    expect(body).toContain('Content-Type: application/json\r\n\r\n{}\r\n')
    expect(body.endsWith(`--${boundary}--`)).toBe(true)
  })

  it('replaces the content of an existing file', async () => {
    fetchMock.mockResolvedValue(reply(200, { id: 'f1', name: 'a.json', version: '8', size: '3' }))
    await uploadFile(token, { id: 'f1', name: 'a.json', data: new Uint8Array([1, 2, 3]), contentType: 'application/gzip' }, signal)
    const { url, init, headers } = call()
    expect(init.method).toBe('PATCH')
    expect(url.pathname).toBe('/upload/drive/v3/files/f1')
    expect(url.searchParams.get('uploadType')).toBe('media')
    expect(headers['Content-Type']).toBe('application/gzip')
  })

  it('downloads and deletes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([4, 5]))).mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await downloadFile(token, 'f1', signal)).toEqual(new Uint8Array([4, 5]))
    expect(call(0).url.searchParams.get('alt')).toBe('media')
    await deleteFile(token, 'f1', signal)
    expect(call(1).init.method).toBe('DELETE')
  })
})

describe('Drive errors', () => {
  it('drops the saved token on 401', async () => {
    store.set('fluency:drive-token', JSON.stringify(token))
    fetchMock.mockResolvedValue(apiError(401, 'authError'))
    await expect(findFiles(token, 'a', signal)).rejects.toMatchObject({ kind: 'auth' })
    expect(store.has('fluency:drive-token')).toBe(false)
  })

  it('reports a full Drive as quota', async () => {
    fetchMock.mockResolvedValue(apiError(403, 'storageQuotaExceeded'))
    await expect(uploadFile(token, { id: 'f1', name: 'a', data: 'x', contentType: 'text/plain' }, signal)).rejects.toMatchObject({ kind: 'quota' })
  })

  it('retries once on a rate limit, then gives up', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(apiError(403, 'userRateLimitExceeded')).mockResolvedValueOnce(reply(200, { files: [] }))
    const first = findFiles(token, 'a', signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toEqual([])

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(reply(429))
    const second = findFiles(token, 'a', signal).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await second).toMatchObject({ kind: 'http' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('maps network failures and bad replies, without leaking the token', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const network = await findFiles(token, 'a', signal).catch((error) => error)
    expect(network).toBeInstanceOf(DriveError)
    expect(network.kind).toBe('network')

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(reply(200, { nope: true }))
    await expect(findFiles(token, 'a', signal)).rejects.toMatchObject({ kind: 'bad-file' })

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(apiError(500, 'backendError'))
    const http = await findFiles(token, 'a', signal).catch((error) => error)
    expect(http).toMatchObject({ kind: 'http' })
    expect(http.message).not.toContain('secret-token')
  })

  it('passes an abort through as the abort reason', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_url, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const pending = findFiles(token, 'a', controller.signal).catch((error) => error)
    controller.abort('left the screen')
    expect(await pending).toBe('left the screen')
  })
})

describe('tokens', () => {
  // A fake Google Identity Services that answers the next requestAccessToken.
  function fakeGis(answer: (callbacks: { callback: (r: object) => void; error_callback?: (e: object) => void }) => void) {
    const revoke = vi.fn()
    const requested: unknown[] = []
    vi.stubGlobal('google', {
      accounts: {
        oauth2: {
          initTokenClient: (config: { client_id: string; scope: string; callback: (r: object) => void; error_callback?: (e: object) => void }) => ({
            requestAccessToken: (overrides: unknown) => {
              requested.push({ clientId: config.client_id, scope: config.scope, ...(overrides as object) })
              answer(config)
            },
          }),
          revoke,
        },
      },
    })
    return { revoke, requested }
  }

  it('saves a granted token and returns it until shortly before it expires', async () => {
    vi.useFakeTimers({ now: NOW })
    const { requested } = fakeGis(({ callback }) => callback({ access_token: 'abc', expires_in: 3599, scope: `openid ${DRIVE_SCOPE}` }))
    expect(await requestToken('consent')).toEqual({ accessToken: 'abc', expiresAt: NOW + 3599_000 })
    expect(requested).toEqual([{ clientId: 'client-123.apps.googleusercontent.com', scope: DRIVE_SCOPE, prompt: 'consent' }])
    expect(currentToken(NOW + 3000_000)?.accessToken).toBe('abc')
    expect(currentToken(NOW + 3500_000)).toBeNull() // within the 2-minute margin
  })

  it('rejects when the Drive permission was not granted, or the popup failed', async () => {
    fakeGis(({ callback }) => callback({ access_token: 'abc', expires_in: 3600, scope: 'openid' }))
    await expect(requestToken('')).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('permission') })
    fakeGis(({ callback }) => callback({ error: 'access_denied' }))
    await expect(requestToken('')).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('denied') })
    fakeGis(({ error_callback }) => error_callback?.({ type: 'popup_failed_to_open' }))
    await expect(requestToken('')).rejects.toMatchObject({ message: expect.stringContaining('pop-ups') })
    expect(currentToken()).toBeNull()
  })

  it('refuses without a client ID or before Google sign-in has loaded', async () => {
    await expect(requestToken('consent')).rejects.toMatchObject({ kind: 'network' }) // no google global
    fakeGis(() => {})
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '')
    await expect(requestToken('consent')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('forgetToken drops the token and revokes it', () => {
    const { revoke } = fakeGis(() => {})
    store.set('fluency:drive-token', JSON.stringify(token))
    forgetToken()
    expect(store.has('fluency:drive-token')).toBe(false)
    expect(revoke).toHaveBeenCalledWith('secret-token')
  })
})
