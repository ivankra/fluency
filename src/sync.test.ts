import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card, Deck, Snapshot } from './db'
import { DriveError, type RemoteFile, type Token } from './gdrive'
import { canonical, sortSnapshot } from './merge'
import { SAMPLE_DECKS } from './sampleDecks'
import { SyncEngine, type SyncRecord } from './sync'
import { encodeSyncFile, SYNC_FILE_NAME } from './syncFile'

const empty = (): Snapshot => ({ decks: [], cards: [], reviews: [], deletions: [] })
const deck = (id: string, updatedAt = 1, name = id): Deck => ({ id, name, updatedAt })
const card = (id: string, deckId: string, front = id, back = 'b', updatedAt = 1): Card => ({
  id,
  deckId,
  front,
  back,
  updatedAt,
  sched: { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, updatedAt },
})

// An in-memory Google Drive app folder shared by the fake devices.
function fakeDrive() {
  const files = new Map<string, { data: Uint8Array; version: number }>()
  let nextId = 1
  const calls: string[] = []
  const info = (id: string): RemoteFile => ({ id, name: SYNC_FILE_NAME, version: String(files.get(id)!.version), size: files.get(id)!.data.length })
  return {
    files,
    calls,
    async put(snapshot: Snapshot, id = `file-${nextId++}`) {
      files.set(id, { data: await encodeSyncFile(snapshot), version: (files.get(id)?.version ?? 0) + 1 })
      return id
    },
    findFiles: async () => (calls.push('list'), [...files.keys()].map(info)),
    downloadFile: async (_token: Token, id: string) => (calls.push(`download ${id}`), files.get(id)!.data),
    uploadFile: async (_token: Token, file: { id: string | null; data: Uint8Array }) => {
      const id = file.id ?? `file-${nextId++}`
      calls.push(file.id ? `update ${id}` : `create ${id}`)
      files.set(id, { data: file.data, version: (files.get(id)?.version ?? 0) + 1 })
      return info(id)
    },
    deleteFile: async (_token: Token, id: string) => void (calls.push(`delete ${id}`), files.delete(id)),
  }
}

type Drive = ReturnType<typeof fakeDrive>

// A device: its own database, saved sync record and sign-in state, on a shared Drive.
function device(drive: Drive, data: Snapshot = empty()) {
  let db = structuredClone(data)
  let record: SyncRecord | null = null
  let changes = 0
  const state = { signedIn: true, online: true, conflictsLeft: 0 }
  const token: Token = { accessToken: 't', expiresAt: Infinity }
  const deps = {
    configured: () => true,
    token: () => (state.signedIn ? token : null),
    requestToken: vi.fn(async () => {
      state.signedIn = true
      return token
    }),
    forgetToken: vi.fn(() => void (state.signedIn = false)),
    findFiles: (t: Token, name: string, s: AbortSignal) => drive.findFiles(),
    downloadFile: (t: Token, id: string) => drive.downloadFile(t, id),
    uploadFile: (t: Token, file: { id: string | null; data: Uint8Array }) => drive.uploadFile(t, file),
    deleteFile: (t: Token, id: string) => drive.deleteFile(t, id),
    snapshot: async () => structuredClone(db),
    applyMerge: vi.fn(async (before: Snapshot, result: Snapshot) => {
      if (state.conflictsLeft > 0) {
        state.conflictsLeft--
        edit((s) => s.decks.push(deck(`meanwhile-${state.conflictsLeft}`)))
        return false
      }
      if (canonical(sortSnapshot(db)) !== canonical(sortSnapshot(before))) return false
      db = structuredClone(result)
      return true
    }),
    changeCount: () => changes,
    online: () => state.online,
    now: () => 1000,
    loadRecord: () => record,
    saveRecord: (next: SyncRecord | null) => void (record = next),
  }
  // A local edit, as db.ts would make it: change the data and count the change.
  const edit = (change: (s: Snapshot) => void) => {
    change(db)
    changes++
  }
  const engine = new SyncEngine(deps)
  return { engine, deps, state, edit, db: () => db, record: () => record }
}

const ids = (items: { id: string }[]) => items.map((item) => item.id).sort()

afterEach(() => vi.useRealTimers())

describe('connecting', () => {
  it('starts off, asks for consent on connect, and uploads the first copy', async () => {
    const drive = fakeDrive()
    const phone = device(drive, { ...empty(), decks: [deck('d1')] })
    expect(phone.engine.getStatus()).toEqual({ state: 'off' })
    await phone.engine.connect()
    expect(phone.deps.requestToken).toHaveBeenCalledWith('consent')
    expect(drive.calls).toEqual(['list', 'create file-1'])
    expect(phone.engine.getStatus()).toEqual({ state: 'idle', lastSyncAt: 1000 })
    expect(phone.record()).toMatchObject({ connected: true, fileId: 'file-1', version: '1', firstSyncDone: true })
  })

  it('a failed consent leaves sync off with the reason', async () => {
    const phone = device(fakeDrive())
    phone.deps.requestToken.mockRejectedValueOnce(new DriveError('auth', 'Access to Google Drive was denied.'))
    await phone.engine.connect()
    expect(phone.engine.getStatus()).toMatchObject({ state: 'error', message: 'Access to Google Drive was denied.' })
    expect(phone.engine.connected).toBe(false)
  })
})

describe('syncing', () => {
  async function connected(drive = fakeDrive(), data?: Snapshot) {
    const d = device(drive, data)
    await d.engine.connect()
    drive.calls.length = 0
    return d
  }

  it('does one list request when nothing changed', async () => {
    const drive = fakeDrive()
    const phone = await connected(drive)
    await phone.engine.trigger()
    expect(drive.calls).toEqual(['list'])
  })

  it('uploads local changes without downloading when Drive is unchanged', async () => {
    const drive = fakeDrive()
    const phone = await connected(drive)
    phone.edit((s) => s.decks.push(deck('d1')))
    await phone.engine.trigger()
    expect(drive.calls).toEqual(['list', 'update file-1'])
  })

  it('two devices converge: additions, edits and deletes travel both ways', async () => {
    const drive = fakeDrive()
    const phone = await connected(drive, { ...empty(), decks: [deck('d1')], cards: [card('c1', 'd1')] })
    const laptop = await connected(drive)
    expect(ids(laptop.db().cards)).toEqual(['c1'])

    laptop.edit((s) => {
      s.cards = s.cards.map((c) => ({ ...c, front: 'edited', updatedAt: 5 }))
      s.decks.push(deck('d2'))
    })
    phone.edit((s) => {
      s.cards = []
      s.deletions.push({ id: 'c1', table: 'cards', at: 3 })
    })
    await laptop.engine.trigger()
    await phone.engine.trigger()
    await laptop.engine.trigger()

    for (const d of [phone, laptop]) {
      expect(ids(d.db().decks)).toEqual(['d1', 'd2'])
      expect(d.db().cards).toEqual([]) // the delete wins over the later edit
    }
    expect(canonical(sortSnapshot(phone.db()))).toBe(canonical(sortSnapshot(laptop.db())))
  })

  it('does not upload when Drive already has everything', async () => {
    const drive = fakeDrive()
    const phone = await connected(drive, { ...empty(), decks: [deck('d1')] })
    const laptop = await connected(drive)
    drive.calls.length = 0
    phone.edit((s) => s.decks.push(deck('d2')))
    await phone.engine.trigger()
    drive.calls.length = 0
    await laptop.engine.trigger()
    expect(drive.calls).toEqual(['list', 'download file-1'])
    expect(ids(laptop.db().decks)).toEqual(['d1', 'd2'])
  })

  it('merges again if the database changed during the merge', async () => {
    const drive = fakeDrive()
    await drive.put({ ...empty(), decks: [deck('remote')] })
    const phone = device(drive)
    phone.state.conflictsLeft = 1
    await phone.engine.connect()
    expect(phone.deps.applyMerge).toHaveBeenCalledTimes(2)
    expect(ids(phone.db().decks)).toEqual(['meanwhile-0', 'remote'])
    expect(phone.engine.getStatus().state).toBe('idle')
  })

  it('combines two copies in Drive into one', async () => {
    const drive = fakeDrive()
    await drive.put({ ...empty(), decks: [deck('a')] }, 'file-a')
    await drive.put({ ...empty(), decks: [deck('b')] }, 'file-b')
    const phone = device(drive)
    await phone.engine.connect()
    expect(ids(phone.db().decks)).toEqual(['a', 'b'])
    expect([...drive.files.keys()]).toEqual(['file-a'])
    expect(phone.record()?.fileId).toBe('file-a')
  })

  it('on the first sync, drops untouched sample decks if Drive has data, keeping studied ones', async () => {
    const [spanish, chinese] = SAMPLE_DECKS
    const sample = (name: string, cards: [string, string][], deckId: string) => ({
      decks: [deck(deckId, 1, name)],
      cards: cards.map(([front, back], i) => card(`${deckId}-${i}`, deckId, front, back)),
    })
    const es = sample(spanish.name, spanish.cards, 'random-es')
    const zh = sample(chinese.name, chinese.cards, 'random-zh')
    const local: Snapshot = { ...empty(), decks: [...es.decks, ...zh.decks], cards: [...es.cards, ...zh.cards], reviews: [{ id: 'r', cardId: 'random-zh-0', at: 1, grade: 3 }] }
    const drive = fakeDrive()
    await drive.put({ ...empty(), decks: [deck('mine')] })
    const phone = device(drive, local)
    await phone.engine.connect()
    expect(ids(phone.db().decks)).toEqual(['mine', 'random-zh'])
    expect(phone.db().deletions).toEqual([]) // nothing deleted on other devices

    // Only on the first sync.
    phone.edit((s) => s.decks.push(...es.decks) && s.cards.push(...es.cards))
    await phone.engine.trigger()
    expect(ids(phone.db().decks)).toContain('random-es')
  })
})

describe('sign-in, errors and triggers', () => {
  it('pauses without a popup when the token has expired; Sync now signs in again', async () => {
    const drive = fakeDrive()
    const phone = device(drive)
    await phone.engine.connect()
    phone.state.signedIn = false
    phone.deps.requestToken.mockClear()
    await phone.engine.trigger()
    expect(phone.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'token' })
    expect(phone.deps.requestToken).not.toHaveBeenCalled()
    await phone.engine.syncNow()
    expect(phone.deps.requestToken).toHaveBeenCalledWith('')
    expect(phone.engine.getStatus().state).toBe('idle')
  })

  it('pauses on a 401 mid-sync, and while offline', async () => {
    const drive = fakeDrive()
    const phone = device(drive)
    await phone.engine.connect()
    vi.spyOn(drive, 'findFiles').mockRejectedValueOnce(new DriveError('auth', 'expired'))
    await phone.engine.trigger()
    expect(phone.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'token' })
    phone.state.online = false
    await phone.engine.syncNow()
    expect(phone.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'offline' })
  })

  it('backs off after an error, then retries', async () => {
    vi.useFakeTimers()
    const drive = fakeDrive()
    const phone = device(drive)
    await phone.engine.connect()
    const find = vi.spyOn(drive, 'findFiles').mockRejectedValueOnce(new DriveError('http', 'Google Drive returned error 500.'))
    await phone.engine.trigger()
    expect(phone.engine.getStatus()).toMatchObject({ state: 'error', message: 'Google Drive returned error 500.', lastSyncAt: 1000 })
    find.mockClear()
    await phone.engine.trigger() // ignored while backing off
    expect(find).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(find).toHaveBeenCalledTimes(1)
    expect(phone.engine.getStatus().state).toBe('idle')
  })

  it('stops retrying when Drive has a newer file format', async () => {
    vi.useFakeTimers()
    const drive = fakeDrive()
    const phone = device(drive)
    await phone.engine.connect()
    const newer = new Uint8Array(await new Response(new Blob([JSON.stringify({ format: 99 })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    drive.files.set('file-1', { data: newer, version: 9 })
    await phone.engine.trigger()
    expect(phone.engine.getStatus()).toMatchObject({ state: 'error', message: expect.stringContaining('newer version') })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs one sync at a time, with one more after it if triggered meanwhile', async () => {
    const drive = fakeDrive()
    const phone = device(drive)
    await phone.engine.connect()
    drive.calls.length = 0
    phone.edit((s) => s.decks.push(deck('d1')))
    const runs = [phone.engine.trigger(), phone.engine.trigger(), phone.engine.trigger()]
    await Promise.all(runs)
    expect(drive.calls).toEqual(['list', 'update file-1', 'list'])
  })

  it('disconnect signs out and forgets; deleting from Drive also removes the file', async () => {
    const drive = fakeDrive()
    const phone = device(drive, { ...empty(), decks: [deck('d1')] })
    await phone.engine.connect()
    await phone.engine.deleteFromDrive()
    expect(drive.files.size).toBe(0)
    expect(phone.deps.forgetToken).toHaveBeenCalled()
    expect(phone.record()).toBeNull()
    expect(phone.engine.getStatus()).toEqual({ state: 'off' })
    expect(ids(phone.db().decks)).toEqual(['d1']) // local data kept
    await phone.engine.trigger()
    expect(drive.files.size).toBe(0)
  })
})
