# Design

Sentence-drill PWA for intermediate and advanced learners: the app shows a sentence in
the user's language, they translate it into the target language, grade themselves, and a
spaced-repetition scheduler decides when the card returns. It targets language
*production*, as a complement to Anki. There is no backend: everything lives in the
browser. Setup, commands and the file map are in [README.md](README.md).

Status: the basic loop, scheduling, storage, card editing/export and sample decks are
done. LLM grading, voice, Drive sync and FSRS are not.

## Architecture

React 19 + TypeScript + Vite, Dexie for IndexedDB, `vite-plugin-pwa` for the service
worker. No router, state, or UI libraries.

```
components (DeckList, DeckView, Study)
   │  reads: useLiveQuery(() => db function)     writes: await db function
   │
   ├──▶ src/scheduler.ts   pure: (Sched, Grade, now) → Sched
   │       (Study calls it, then hands the result to db.ts)
   ▼
src/db.ts  ── the only module that touches Dexie ──▶ IndexedDB
```

- **Lists are reactive; study is a snapshot.** `DeckList` and `DeckView` call
  `useLiveQuery` (dexie-react-hooks) with a `db.ts` function, so they re-render when a
  table they read changes. Mutations are plain async functions; there is no store to keep
  in sync. Reactivity follows database changes only, with no timer: a card that becomes
  due as time passes isn't counted until something else triggers a re-query. `Study` reads
  once on entry (see below). `useLiveQuery` returns `undefined` while loading, so a query
  that can find nothing returns `null` to tell the two apart (see `getDeck`).
- **The scheduler never touches storage.** It maps a schedule to a new schedule.
  `db.ts` functions like `recordReview(card, grade, sched)` just persist what the caller
  computed, which keeps the algorithm testable. It isn't fully swappable by replacing
  `scheduler.ts` alone, though; see the coupling notes under Data.
- **Only `scheduler.ts` has tests** (`make test`, vitest, pure functions). The db layer and
  components are untested.
- Styling is one global `src/index.css` using CSS variables, with a dark theme through
  `prefers-color-scheme`. Layout is a single 640px column, phone first.

## Data

IndexedDB database `fluency` (`src/db.ts`), schema version 1:

| Table | Indexes | Notes |
|---|---|---|
| `decks` | `id` | `name`, `updatedAt` |
| `cards` | `id`, `deckId`, `[deckId+sched.due]` | `front` (native, the prompt), `back` (target, the expected answer), `sched`, `updatedAt` |
| `reviews` | `id`, `cardId`, `at` | one graded attempt: `grade` (1 bad, 2 fair, 3 good), optional typed `answer` |

- Ids are UUIDs. Cards and decks carry `updatedAt`, set by every write, for the planned
  Drive sync. Reviews are immutable once written and have no `updatedAt`, but they can
  be deleted: by undo, by the cascade when a card or deck is deleted, or by `importAll`.
- `sched` is a nested object owned by the scheduler (`due`, `interval`, `ease`, `reps`,
  `lapses`), which keeps scheduler fields out of `Card`. Dexie indexes the nested path
  directly; this is what makes "due cards in a deck" a single range query.
- Replacing the algorithm (e.g. FSRS) touches more than `scheduler.ts`: `newSched()` in
  `db.ts` builds the SM-2 defaults for new cards, queries and the UI depend on
  `sched.due`, and `Study` reads `interval === 0` to decide whether a failed card is
  requeued. Existing stored `sched` objects also need converting.
- Schema changes need a new `db.version(n)` block listing only the indexed fields.
  Adding or changing non-indexed fields needs no version bump, but existing records keep
  their old shape, so such changes need backward-compatible reads or an `.upgrade()`
  migration. TypeScript types don't change stored data.
- No foreign keys: `deleteDeck` and `deleteCard` cascade by hand inside a transaction.
  Deletes are hard deletes, so sync will need tombstones or a similar mechanism.
- Skips are not reviews. `getDueCards` returns up to 20 cards with `sched.due <= now`,
  soonest first; `countDueCards` backs the counts on the home screen.
- Backup contract: the JSON export (`exportAll`) holds decks, cards (with `sched`) and
  reviews, and nothing from `localStorage` (such as the sample-deck flag). `importAll`
  replaces the whole database in one transaction, but does no format validation and the
  file has no version field. Restore has no UI yet. CSV export carries only
  `front,back`, so it loses schedules and history.
- `main.tsx` also asks the browser for persistent storage (`navigator.storage.persist`),
  which matters on iOS Safari where data can otherwise be evicted.

## Screens

Hash routes via `src/route.ts` (`useSyncExternalStore` on `hashchange`), so browser
back/forward work and no server configuration is needed. Navigation is plain
`<a href={href.study(id)}>` links; `App.tsx` picks the screen and keys it by deck id.

| Route | Screen |
|---|---|
| `#/` | `DeckList`: decks with live due counts. Tapping a deck starts studying; Edit opens it. Create deck, export everything. |
| `#/study/<deckId>` | `Study`: the session. |
| `#/edit/<deckId>` | `DeckView`: add/edit/delete cards, per-card stats (bad/fair/good counts, time until due), rename, CSV export, delete deck. |

A route to a deleted deck renders "no longer exists" in the editor and "nothing due" in
study, so stale history entries don't crash.

## Study loop

`src/Study.tsx`. On entry it loads a snapshot of up to 20 due cards into a queue, so the
order doesn't shift while the user works. The queue is never topped up: "Done!" means
this queue is finished, and more cards may still be due. Leaving and re-entering builds
a fresh queue. Two open tabs or sessions are not reconciled with each other.

Each queue entry is a `Slot`: the card plus what the user has typed and whether the
answer is revealed. For each card:

1. Show `front`; the user types a translation (optional) and presses Enter.
2. Reveal `back` next to the typed answer.
3. The user self-rates Bad / Fair / Good. `recordReview` logs the review and replaces
   `sched` with `schedule(...)` in one transaction.

**Skip** hides the card for 3 days (`skip()` in the scheduler) without a review, and
leaves ease, interval and counters alone. Available before and after the reveal.

**Retry.** A grade that leaves `interval === 0` (the card failed) appends a copy to the
end of the queue, at most twice per card per session. The 10-minute delay is stored in
`due` for future sessions; within a session the copy appears as soon as the user
reaches it.

**Undo** steps back one attempt, repeatedly, for the current session. A history stack
holds each attempt's card (with its old schedule) and review id; undoing runs
`undoAttempt` (delete the review, restore the schedule), removes any retry copy it
queued, and moves back one slot. Typed text survives because it lives on the `Slot`;
a removed retry slot is parked so its text returns if the card fails again. History
is lost when the user leaves the screen; the database changes stay. Undo restores the
saved schedule as it was, without checking for changes made in between (e.g. from
another tab).

**Keyboard.** Enter reveals. After that no text field is focused, so 1/2/3 grade
(Bad/Fair/Good), Space grades Good, `-` skips (Anki's bury key) and Ctrl/Cmd+Z undoes.
Handlers ignore keys while a textarea/input is focused (so Ctrl+Z is still text undo
there), and ignore Enter that confirms an IME composition (CJK input). A `busy` flag
blocks double taps while a write is in flight.

Cards can be edited from the session; the change is applied to every queued copy. A
failed database write in the session is not reported to the user.

## Scheduling

`src/scheduler.ts`: `schedule(sched, grade, now) → Sched`, a pure function with table
tests. A simplified SM-2: whole-day intervals, no learning-step ladder, three grades.
For sentence production, where the user has just written the whole sentence, a short
retry after a failure (at most two per session, so up to three graded attempts) was
judged enough. Tunable constants are at the top of the file.

A card with `interval = 0` is **new or relearning**; otherwise it is a **review** card.

| State | Bad | Fair | Good |
|---|---|---|---|
| New / relearning | due in 10 min | interval 1 d | interval 1 d |
| Review | lapse: `interval = 0`, due in 10 min, ease −0.2 | interval × 1.2, ease −0.15 | interval × ease |

- Fair and Good on a review card give `round(interval × factor)` days (factor 1.2 for
  Fair, the card's ease for Good), but at least the old interval plus 1 day. Bad doesn't
  grow the interval: it resets it to 0.
- A day is 24 hours, and `due` is measured from the time of the attempt, not from the
  previous due date, so reviewing early or late shifts the whole schedule.
- Ease starts at 2.5 and never drops below 1.3.
- `lapses` counts failures of review cards only, and ease changes only for review cards,
  so repeated failures while relearning don't compound.
- No fuzz and no daily new-card limit yet. New cards are due immediately.

## Offline, install and deployment

- The service worker (Workbox via `vite-plugin-pwa`) precaches the app shell; it is off
  under `make dev`, so test with `make preview`.
- `registerType: 'prompt'`: a new version waits until the user taps Reload in
  `UpdateToast`, which also shows "ready to use offline" once. It re-checks for updates
  hourly because an installed PWA can stay open for days.
- `IosInstallPrompt` shows Add-to-Home-Screen instructions to iOS Safari users (there is
  no install event on iOS) until dismissed. Both banners stack in `.banners`.
- **Deployment.** `BASE_PATH` (build-time env, default `/`) sets Vite's `base`, so the app
  works at the site root (Vercel, etc.) or under a prefix. Don't hardcode `/` URLs in
  code; use `import.meta.env.BASE_URL`. Hash routing needs no server rewrites.
- GitHub Pages: `.github/workflows/deploy.yml` builds with `BASE_PATH=/<repo>/` and
  publishes `dist/` on pushes to `main`. Pages → Source must be "GitHub Actions";
  serving the branch directly publishes the unbuilt source.

## Sample decks and export

- `seedSampleDecks` (`sampleDecks.ts`) creates three 10-card decks (Spanish, Chinese,
  Japanese) on a fresh install. A `localStorage` flag stops it re-adding them after the
  user deletes them, and an empty-database check stops it touching existing data.
- Per-deck export is CSV (`front,back`, with a UTF-8 BOM so Excel reads CJK). "Export
  all" downloads the JSON backup. Both use a Blob and `<a download>` (`exportFile.ts`).
