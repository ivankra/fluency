# Google Drive sync

Design for syncing the database between devices through the user's Google Drive.

## Goal

Study on the phone, edit decks on the laptop, and have both see the same decks, cards,
schedules and history, without anyone running a server. Drive also serves as an
off-device backup: today a cleared browser or a lost phone loses everything.

Sync is **per item**: decks, cards and reviews from every device are combined, and
when the same item changed on two devices the newer change wins. Deletes are
recorded so they reach the other devices. Sync runs **automatically** while the app
is open, with a **Sync now** button in settings.

There is still no backend. The app talks to Google from the browser with an OAuth
access token; the data lives in the app's hidden folder in the user's own Drive.

**Non-goals:** sharing decks with other people; real-time collaboration; syncing
settings, the LLM API key or anything else in `localStorage`; other storage providers
(Dropbox, iCloud, WebDAV); a backend for refresh tokens (see
[Open questions](#open-questions)); a restore-from-backup UI.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where data lives | One file in the Drive **app data folder** (`drive.appdata` scope) | The only Drive scope that needs no access to the user's files. It is classified non-sensitive, so the app needs only basic OAuth verification, not a security review. Users can't see or break the file by accident. |
| Auth | Google Identity Services **token model** (`google.accounts.oauth2.initTokenClient`), no backend | Google's supported browser-only flow. It gives a ~1 h access token and no refresh token. |
| Token renewal | Silent while a valid token is held; afterwards **one tap** ("Sync paused, tap to resume") | Google only grants a new token from a user gesture, and without a backend there are no refresh tokens. The token is kept in `localStorage` until it expires, so reopening the app within the hour still syncs. |
| Sync unit | The whole database in one gzipped JSON file | Simple, and one request each way. At about 1 KB per graded review, 10,000 reviews are ~10 MB raw and ~1 MB gzipped. Splitting the file is left for later (see [Open questions](#open-questions)). |
| Merge | Pure function, per entity: union by id, last writer wins by timestamp, deletes win | Deterministic and order-independent, so devices converge whichever syncs first. Tested without network or IndexedDB. |
| Deletes | A `deletions` table of tombstones `{ id, table, at }`, kept forever | Hard deletes would come back from the other device. A tombstone is ~60 bytes. |
| Card edits vs reviews | Two timestamps on a card: `updatedAt` for its content (front, back, deck) and `sched.updatedAt` for its schedule | Editing a card on the laptop while studying it on the phone is common; with one timestamp, one of the two changes would be lost. |
| Concurrent writers | No locking. Every sync downloads, merges and uploads; merging is idempotent, so a write lost to a race is repaired by the next sync of the device that made it | Drive v3 has no conditional (If-Match) updates. Local data is never dropped by a lost upload. |
| Sample decks | Fixed ids for new installs; on a device's first sync, untouched sample decks are dropped if Drive already has data | Otherwise every device adds its own copy of the three sample decks. |
| Triggers | On open, a few seconds after a local change, when the app returns to the foreground, every 5 minutes while visible, and Sync now | Covers "edit here, study there" without a manual step. All cheap when nothing changed (see [Sync engine](#sync-engine)). |
| Client ID | Build-time `VITE_GOOGLE_CLIENT_ID`; no sync UI without it | An OAuth client ID is public, not a secret. Forks and local builds without one work as today. |

## Prerequisites (Google Cloud, done by the project owner)

These can't be done from the code and are needed before any sync code can be tested.

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen: External, app name, support email, scope
   `https://www.googleapis.com/auth/drive.appdata` only. In **Testing** mode up to 100
   listed test users can sign in without verification. Publishing for everyone needs
   basic verification: a homepage and a privacy policy on the app's domain.
3. Create an OAuth client of type **Web application** with authorized JavaScript
   origins `https://<owner>.github.io` and `http://localhost:5173`. No redirect URI is
   needed for the token model; the redirect fallback (see [Auth](#auth)) needs one.
4. Put the client ID in a repository variable `GOOGLE_CLIENT_ID`; the deploy workflow
   passes it to the build as `VITE_GOOGLE_CLIENT_ID`. For local development, put it in
   `.env.local` (git-ignored).

## Architecture

Same split as grading and voice: pure logic in tested modules, I/O in thin layers.

```
DeckList (status pill), Settings (connect, sync now, disconnect)
   └──▶ sync.ts       engine: triggers, one sync at a time, status (useSyncExternalStore)
          ├──▶ merge.ts     pure: merge(local, remote) → result + what changed
          ├──▶ gdrive.ts    GIS token client, Drive REST (find, download, upload), typed errors
          └──▶ db.ts        snapshot(), applyMerge(), tombstones, change counter
```

### `src/gdrive.ts`: auth and Drive

```ts
export type DriveErrorKind = 'auth' | 'network' | 'quota' | 'http' | 'bad-file'
export class DriveError extends Error { kind: DriveErrorKind }

export const isDriveConfigured = () => !!import.meta.env.VITE_GOOGLE_CLIENT_ID

// Must be called from a user gesture. Resolves with a token or throws DriveError('auth').
export function requestToken(options: { prompt: '' | 'consent' }): Promise<Token>
export function currentToken(): Token | null  // null if missing or expiring within 2 minutes
export function forgetToken(): void           // and revoke it with Google

export interface RemoteFile { id: string; version: string; size: number }
export function findSyncFiles(token: Token, signal: AbortSignal): Promise<RemoteFile[]>
export function downloadSyncFile(token: Token, id: string, signal: AbortSignal): Promise<SyncFile>
export function uploadSyncFile(token: Token, id: string | null, data: SyncFile, signal: AbortSignal): Promise<RemoteFile>
export function deleteSyncFile(token: Token, id: string, signal: AbortSignal): Promise<void>
```

- **GIS script** (`https://accounts.google.com/gsi/client`) loads on demand the first
  time the user taps Connect or a paused sync, not on every start. It is not
  precached by the service worker.
- **Requests** are plain `fetch` to `https://www.googleapis.com/drive/v3/files` (list
  with `spaces=appDataFolder&fields=files(id,version,size)`; get with `alt=media`) and
  `https://www.googleapis.com/upload/drive/v3/files` (multipart create with
  `parents: ['appDataFolder']`, or PATCH by id). Timeout 30 s, like `llm.ts`.
- **Errors:** 401 → drop the token, `auth` (the engine pauses until a tap); 403 with
  `storageQuotaExceeded` → `quota`; 403/429 rate limits → retry once after a short
  delay, then `http`; `TypeError` → `network`; a file that fails to parse or validate
  → `bad-file`. Messages never include the token.
- **The token** is stored in `localStorage` (`fluency:drive-token`) with its expiry
  and dropped when it expires. That is the same exposure as the LLM key, but this
  token expires within an hour and only reaches the app's own folder.

### File format

One file, `fluency-sync.json.gz`, in `appDataFolder`:

```ts
interface SyncFile {
  format: 1             // bumped on incompatible changes; a newer format pauses sync with "Update the app"
  decks: Deck[]
  cards: Card[]
  reviews: Review[]
  deletions: Deletion[]
}
```

Gzipped with `CompressionStream` (Safari 16.4+, Chrome 80+, Firefox 113+), uploaded as
`application/gzip`. Downloads are validated like LLM responses: required fields and
types are checked and the file is rejected as a whole if invalid, never partly
applied. Unknown extra fields are kept, so an older app version doesn't strip fields
added by a newer one.

### `src/merge.ts`: the merge

```ts
export interface Snapshot { decks: Deck[]; cards: Card[]; reviews: Review[]; deletions: Deletion[] }
export function merge(local: Snapshot, remote: Snapshot): {
  result: Snapshot
  localChanged: boolean   // result differs from local: apply it to IndexedDB
  remoteChanged: boolean  // result differs from remote: upload it
}
```

Rules, applied in this order:

1. **Deletions:** the union of both sides; for the same id, the earlier `at` is kept.
2. **Deletes win.** Any deck, card or review with a tombstone is dropped, even if it
   was edited after the delete on another device. Restoring a deleted card through an
   edit made elsewhere would surprise users more than losing that edit.
3. **Cascade:** cards whose deck is gone and reviews whose card is gone are dropped,
   and get tombstones, so a card added on one device to a deck deleted on another
   doesn't linger as an orphan.
4. **Decks:** for the same id, the higher `updatedAt` wins; ties go to the larger
   JSON string, so both devices pick the same one.
5. **Cards:** content (`front`, `back`, `deckId`, `updatedAt`) and schedule (`sched`)
   are merged separately, each by its own timestamp (`updatedAt` vs.
   `sched.updatedAt`). A missing `sched.updatedAt` (cards written before this change)
   counts as `updatedAt`.
6. **Reviews** are immutable: union by id.

`merge(a, merge(a, b))` equals `merge(a, b)`, and `merge(a, b)` equals `merge(b, a)`;
the tests check both. Timestamps come from each device's clock: a clock that is far
off can win conflicts it shouldn't. That is accepted, since this is one person's
devices, and conflicts only arise when the same item changes on two devices between
syncs.

### `src/db.ts` changes

- **Version 2** schema adds `deletions: 'id'`. `deleteDeck`, `deleteCard` and
  `undoAttempt` (which deletes a review) write tombstones for everything they remove,
  in the same transaction.
- **`sched.updatedAt`**: `recordReview`, `skipCard` and `undoAttempt` set it instead of
  the card's `updatedAt`. `editCard` keeps setting `updatedAt`. `Sched` gains an
  optional `updatedAt`. The scheduler spreads the old `sched` into the new one, so the
  stale value carries through; the `db.ts` write functions overwrite it, and
  `newSched()` sets it for new cards.
- **Change counter:** every write function bumps a counter in `localStorage`, and the
  engine compares it with the value at the last successful sync to know whether there
  is anything to upload. Dexie's `db.on('changes')` would also work, but it needs the
  observable add-on; the counter is enough.
- `snapshot()` reads all four tables in one transaction. `applyMerge(before, result)`
  writes only what differs from `before`, in one transaction, and **aborts if any
  table changed since `before` was read**, in which case the engine runs the merge
  again. Without that check, a review recorded during a sync could be overwritten by
  the merged copy of its card.
- `importAll` (restore) is out of scope. When a restore UI is added, it has to decide
  whether the backup replaces Drive too; until then it is only used by tests.

### Sample decks

- `seedSampleDecks` uses fixed ids (`sample-es`, `sample-es-1`, …) from now on, so new
  installs merge their sample decks instead of duplicating them.
- Existing installs have random ids. On a device's **first** sync, if Drive already
  has a file, local decks that are untouched samples are deleted before merging. A
  deck counts as an untouched sample if its name and card fronts and backs match a
  sample deck exactly and none of its cards has a review. This is done locally
  without tombstones, so it never deletes anything on other devices.

## Sync engine

`src/sync.ts` holds the state and the only entry points (`connect`, `syncNow`,
`disconnect`), like `Session` in `check.ts`. Drive calls, the database, the clock
and visibility are injected, so it is tested without network or IndexedDB. Settings
and the deck list subscribe with `useSyncExternalStore`.

```ts
type SyncStatus =
  | { state: 'off' }                          // not configured or not connected
  | { state: 'idle'; lastSyncAt: number }
  | { state: 'syncing' }
  | { state: 'paused'; reason: 'token' | 'offline' }  // needs a tap, or waits for the network
  | { state: 'error'; error: DriveError; lastSyncAt?: number }
```

**One sync:**

1. If there's no valid token, go to `paused: token` and stop. Automatic triggers never
   open a popup.
2. `findSyncFiles`. If there are several (two devices created the file at the same
   time), download all of them, merge them all, upload to the oldest and delete the
   rest.
3. If the file's `version` equals the last one this device uploaded or downloaded,
   and the change counter hasn't moved, stop: nothing to do. This is the common case
   and costs one small list request.
4. Otherwise download (if the version changed), `merge(snapshot(), remote)`, then
   `applyMerge` if `localChanged`, and `upload` if `remoteChanged` or there is no file
   yet.
5. Record the file's new `version`, the change counter and `lastSyncAt` in
   `localStorage` (`fluency:sync`).

**Guards:** one sync at a time; a trigger during a sync sets "run again" instead of
starting another. Failures back off (30 s, 2 min, 10 min) and keep the last good
`lastSyncAt`. Offline (`navigator.onLine` false) skips straight to `paused: offline`
and retries on the `online` event. Leaving the app aborts a running sync; nothing is
half-applied, since `applyMerge` is one transaction and an upload replaces the file
whole.

**Triggers:** app start (if connected and a token is valid); 5 s after the change
counter moves; `visibilitychange` to visible; a 5-minute timer while visible; Sync
now. While a study session is running, syncs still run. `Study` works from its own
snapshot and writes with the usual functions, and step 4's abort-and-retry keeps a
sync from overwriting a review recorded meanwhile.

**Study screen:** if a sync brings changes to the deck being studied, the current
session keeps its queue (like the rest of the study screen, it is a snapshot); the
next session sees them.

## UI

**Settings → Google Drive sync** (only if `VITE_GOOGLE_CLIENT_ID` is set):

- Not connected: a short explanation and **Connect Google Drive**. This opens
  Google's consent popup (`prompt: 'consent'`), then runs the first sync, including
  the sample-deck cleanup.
- Connected: "Last synced 3 min ago", **Sync now**, **Disconnect**. Disconnect
  revokes the token and stops syncing. It keeps the data both locally and on Drive,
  and offers a separate **Delete data from Drive** with a confirmation.
- Errors show inline with Retry, like the grading errors. `quota` explains that the
  user's Drive is full.
- Privacy note: "Your decks, cards and review history, including your answers and
  feedback, are stored in a hidden app folder in your Google Drive. The app can't see
  your other files." The README's privacy section changes to match.

**Deck list header:** a small status next to the settings button:
`Synced`, `Syncing…`, `Sync paused` (a button: tapping it requests a token with
`prompt: ''`, which usually closes by itself without asking again, then syncs), or
`Sync error` (links to settings). Nothing shows when sync is off.

## Auth on each platform

The token model opens Google's sign-in in a popup. Popups are reported to work
unreliably in iOS home-screen apps (standalone mode), where the popup can open in a
separate Safari window and never return the token. The first implementation step is
a spike that proves the flow in:

- Chrome desktop, Android Chrome (browser and installed app),
- iOS Safari, and the iOS home-screen app.

If the iOS home-screen app fails, the fallback is a full-page redirect there only
(`response_type=token` to Google's authorization endpoint, with the token returned in
the URL fragment and read before the hash router starts). Google lists that flow as
legacy and discourages it, so it is only used where the popup can't work. If that
fails too, Drive sync is unavailable in the iOS home-screen app, and Settings says
to connect from Safari instead.

## Data model

| Change | Notes |
|---|---|
| `deletions` table: `{ id, table: 'decks' \| 'cards' \| 'reviews', at }` | Dexie version 2; the only schema change. |
| `Sched.updatedAt?` | Optional; missing means "same as the card's `updatedAt`". |
| Sample deck ids | Fixed for new installs only. |
| `localStorage`: `fluency:sync` (file id, version, change counter at last sync, `lastSyncAt`, connected) and `fluency:drive-token` | Not part of backups or of the synced file. |

JSON export (`exportAll`) adds `deletions`; older backups without it still import.

## Security and privacy

- The synced file holds everything in IndexedDB, including answers and LLM feedback.
  It never contains the LLM API key, the Drive token or any settings.
- The `drive.appdata` scope gives the app no access to the user's other files, and no
  other app can read the app folder.
- The access token is only sent to `www.googleapis.com` and Google's OAuth endpoints,
  and is never logged or put in error messages.
- A downloaded file is data: it's validated and rendered like any other card text
  (React text only), so a tampered file can at worst change the user's own decks.

## Testing

**Unit tests** (`make test`, no network):

- `merge.ts`: union of new items; last writer wins for decks and card content;
  content and schedule merged separately; deletes beat later edits; cascades (card
  added to a deck deleted elsewhere, review of a card deleted elsewhere); tombstones
  merged by earliest `at`; ties resolved the same way on both sides; idempotence and
  symmetry over a set of random snapshots; `localChanged`/`remoteChanged` correct.
- File validation: missing fields, wrong types, newer `format`, extra fields kept.
- Sample-deck cleanup: untouched samples dropped on first sync only; an edited deck
  or one with reviews kept.
- `sync.ts` with mocked Drive and database: nothing uploaded or downloaded when both
  are unchanged; an expired token pauses without a popup; a 401 mid-sync pauses; two
  remote files merged into one; a local write during a sync makes `applyMerge` abort
  and the sync retry; one sync at a time with a queued rerun; backoff after errors;
  offline then online.
- `db.ts` writes: each delete leaves tombstones, `recordReview` sets
  `sched.updatedAt` and not `updatedAt`. These need IndexedDB, so they run against
  `fake-indexeddb` as a dev dependency. This is the first test that touches Dexie, and
  the only new test dependency.

**By hand,** on the four platforms above with two devices: connect, edit on one and
study on the other, delete on one, go offline and back, let the token expire and
resume with a tap, disconnect and reconnect.

## Rollout

Three PRs, each ending with `make test` passing.

1. **Auth spike and Drive transport.** `gdrive.ts`, a temporary Settings section that
   connects and uploads/downloads a test file, the deploy variable. Done when the
   flow works on all four platforms, or the iOS home-screen fallback is decided.
2. **Data model and merge.** Tombstones, `sched.updatedAt`, fixed sample ids,
   `merge.ts`, file validation, `snapshot`/`applyMerge`, with tests. No UI; nothing
   syncs yet. *Status:* tombstones done (recorded by every delete, in backups, tested
   on fake-indexeddb); the rest follows.
3. **Sync engine and UI.** `sync.ts`, Settings section, deck-list status, README and
   design.md updates.

## Open questions

- **A backend for refresh tokens** (e.g. a small Cloudflare Worker holding the client
  secret) would allow sync without a tap after an hour. Not planned: it is the
  project's first server, with a secret to protect and costs to pay.
- **File size:** if graded reviews make the file large, split it into a small
  "current state" file (decks, cards, tombstones) and append-only review files per
  month, which rarely change once the month is over.
- **Syncing settings** (model, feedback language, grading rules, voice), but never
  the API key. Easy to add later as a second file.
- **Tombstone pruning:** they're kept forever. Pruning needs to know that every device
  has synced since the delete, which a per-device "last seen" list in the file could
  provide.
