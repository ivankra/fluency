import { describe, expect, it } from 'vitest'
import type { Snapshot } from './db'
import { decodeSyncFile, encodeSyncFile, parseSyncFile, SYNC_FORMAT, SyncFileError } from './syncFile'

const snapshot: Snapshot = {
  decks: [{ id: 'd', name: 'Español', updatedAt: 1, sourceLanguage: 'en', targetLanguage: 'es' }],
  cards: [{ id: 'c', deckId: 'd', front: 'Hi', back: '¡Hola!', updatedAt: 2, sched: { due: 3, interval: 0, ease: 2.5, reps: 0, lapses: 0, updatedAt: 2 } }],
  reviews: [{ id: 'r', cardId: 'c', at: 4, grade: 2, answer: 'Hola' }],
  deletions: [{ id: 'x', table: 'cards', at: 5 }],
}
const file = (patch: object) => ({ format: SYNC_FORMAT, ...snapshot, ...patch })

describe('sync file', () => {
  it('round-trips through gzip, keeping non-ASCII text', async () => {
    const bytes = await encodeSyncFile(snapshot)
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]) // gzip magic number
    expect(await decodeSyncFile(bytes)).toEqual(snapshot)
  })

  it('keeps fields it does not know, from newer app versions', () => {
    const decks = [{ ...snapshot.decks[0], color: 'blue' }]
    expect(parseSyncFile(file({ decks })).decks[0]).toMatchObject({ color: 'blue' })
  })

  it('rejects a whole file with any bad entry', () => {
    const bad = [
      null,
      [],
      { ...snapshot }, // no format
      file({ decks: 'none' }),
      file({ decks: [{ id: 'd', name: 1, updatedAt: 1 }] }),
      file({ cards: [{ ...snapshot.cards[0], sched: { due: 'soon' } }] }),
      file({ cards: [{ ...snapshot.cards[0], sched: { ...snapshot.cards[0].sched, updatedAt: '2' } }] }),
      file({ reviews: [{ ...snapshot.reviews[0], grade: 4 }] }),
      file({ deletions: [{ id: 'x', table: 'settings', at: 1 }] }),
      file({ deletions: [{ id: 'x', table: 'cards', at: Infinity }] }),
    ]
    for (const data of bad) {
      expect(() => parseSyncFile(data), JSON.stringify(data)?.slice(0, 80)).toThrow(SyncFileError)
    }
  })

  it('asks for an update on a newer format', () => {
    try {
      parseSyncFile(file({ format: SYNC_FORMAT + 1 }))
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ reason: 'newer-format' })
    }
  })

  it('rejects bytes that are not a gzipped sync file', async () => {
    await expect(decodeSyncFile(new TextEncoder().encode('{"format":1}'))).rejects.toMatchObject({ reason: 'invalid' })
    await expect(decodeSyncFile(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).rejects.toMatchObject({ reason: 'invalid' })
  })
})
