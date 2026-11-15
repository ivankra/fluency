// The sync file in Drive: the whole database as gzipped JSON, and strict validation of
// what is downloaded. A file that fails validation is rejected whole, never partly
// applied. Design: doc/drive-sync.md.
import type { Card, Deck, Deletion, Review, Snapshot } from './db'

export const SYNC_FORMAT = 1
export const SYNC_FILE_NAME = 'fluency-sync.json.gz'
export const SYNC_CONTENT_TYPE = 'application/gzip'

export class SyncFileError extends Error {
  constructor(
    // 'newer-format': written by a newer version of the app; the user should update.
    readonly reason: 'invalid' | 'newer-format',
    message: string,
  ) {
    super(message)
  }
}

const invalid = (why: string) => new SyncFileError('invalid', `The sync file in Google Drive is damaged (${why}).`)

type Item = Record<string, unknown>
const isItem = (value: unknown): value is Item => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// Each check lists the fields every reader relies on; other fields are kept as they are,
// so an older app doesn't strip what a newer one added.
const CHECKS = {
  decks: (d: Item) => isString(d.id) && isString(d.name) && isTime(d.updatedAt),
  cards: (c: Item) =>
    isString(c.id) &&
    isString(c.deckId) &&
    isString(c.front) &&
    isString(c.back) &&
    isTime(c.updatedAt) &&
    isItem(c.sched) &&
    isTime(c.sched.due) &&
    (c.sched.updatedAt === undefined || isTime(c.sched.updatedAt)),
  reviews: (r: Item) => isString(r.id) && isString(r.cardId) && isTime(r.at) && (r.grade === 1 || r.grade === 2 || r.grade === 3),
  deletions: (d: Item) => isString(d.id) && (d.table === 'decks' || d.table === 'cards' || d.table === 'reviews') && isTime(d.at),
}

function list<T>(data: Item, field: keyof typeof CHECKS): T[] {
  const items = data[field]
  if (!Array.isArray(items)) throw invalid(`no ${field}`)
  for (const item of items) if (!isItem(item) || !CHECKS[field](item)) throw invalid(`a bad entry in ${field}`)
  return items as T[]
}

// Validates parsed JSON from the sync file.
export function parseSyncFile(data: unknown): Snapshot {
  if (!isItem(data)) throw invalid('not an object')
  if (typeof data.format !== 'number') throw invalid('no format')
  if (data.format > SYNC_FORMAT) {
    throw new SyncFileError('newer-format', 'The sync file was written by a newer version of Fluency. Update the app to keep syncing.')
  }
  return {
    decks: list<Deck>(data, 'decks'),
    cards: list<Card>(data, 'cards'),
    reviews: list<Review>(data, 'reviews'),
    deletions: list<Deletion>(data, 'deletions'),
  }
}

async function pipe(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as unknown as TransformStream<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export const encodeSyncFile = (snapshot: Snapshot): Promise<Uint8Array> =>
  pipe(new TextEncoder().encode(JSON.stringify({ format: SYNC_FORMAT, ...snapshot })), new CompressionStream('gzip'))

export async function decodeSyncFile(bytes: Uint8Array): Promise<Snapshot> {
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip'))))
  } catch {
    throw invalid('not readable')
  }
  return parseSyncFile(data)
}
