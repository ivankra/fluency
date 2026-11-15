# FSRS scheduling

Design for adding FSRS as a second scheduling algorithm next to the current simplified
SM-2, with user-settable options and parameters fitted to the user's own review
history.

## Goal

The SM-2 scheduler ([design.md](design.md#scheduling)) is simple and predictable, but its
intervals come from fixed constants. FSRS models each card's memory (stability,
difficulty) and schedules the next review for a target probability of recall, so the
user gets the retention they ask for with fewer reviews. Fitted to the user's own
history, it also adapts to how they learn.

The user can:

1. **choose** the algorithm in Settings: *Simple (SM-2)*, the default, or *FSRS*;
2. **set FSRS options**: desired retention, maximum interval, learning and relearning
   steps, fuzz, and the model's parameters;
3. **retune the parameters** on their review history with one button, on the device,
   without a server.

**Non-goals:** a fourth grade ("Easy"; the 3-point scale stays, see
[Grades](#grades)); per-deck presets; FSRS-7 (see [Open questions](#open-questions));
importing Anki review logs; load balancing or "easy days"; simulating workload for a
given retention.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Scheduler library | [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs) 6.x (MIT), the reference TypeScript implementation | Maintained by the FSRS authors; includes `Reschedule` to rebuild a card from its history. Pure JS, works in every browser; verified in the spike. |
| Optimizer | `@open-spaced-repetition/binding-wasm32-wasip1` (MIT): fsrs-rs compiled to single-threaded WASI, run in a dedicated Worker, loaded only when the user retunes | Same code as Anki's optimizer. The single-threaded build doesn't need cross-origin isolation (COOP/COEP), which GitHub Pages can't set and which would break the Google sign-in popup planned for Drive sync. Verified in the spike. |
| FSRS version | **FSRS-6** (21 parameters), set explicitly | It is what Anki uses, so parameters can be pasted from Anki. ts-fsrs 6 and the optimizer default to the newer FSRS-7; switching later means retraining (see [Open questions](#open-questions)). |
| Default algorithm | SM-2; FSRS is opt-in | No surprise for existing users. Untuned FSRS with default parameters is still a good scheduler, so opting in doesn't require history. |
| Grades | Bad → Again, Fair → Hard, Good → Good; Easy is never produced | Keeps the study screen, keyboard, voice commands and LLM grading unchanged. FSRS handles a missing rating; the optimizer fits whatever ratings it sees. |
| Switching algorithm | Every card's schedule is **rebuilt from its review history** with the new algorithm | The full history is in IndexedDB, so the switch is exact rather than an approximate conversion, and switching back and forth loses nothing. |
| Retuning | Fits parameters, shows them with the number of reviews used, and applies them only when the user confirms. Applying rebuilds every card's schedule, like switching | Parameters change memory states, not just future intervals; Anki asks the same question. |
| Option changes | Retention, maximum interval, steps and fuzz apply from each card's next review; no rebuild | Cheap and predictable; matches Anki's default. |
| Settings storage | `localStorage` (`fluency:scheduler`), like the LLM and voice settings | Device-local; see [Drive sync](#drive-sync) for what that means once sync lands. |

## Spike results

Done before writing this doc, on a production build served by `vite preview` (no
COOP/COEP headers, `crossOriginIsolated === false`), Chrome desktop:

- **ts-fsrs 6.0.0** works in the browser: `DefaultScheduler({ version: 'FSRS-6', … })`,
  `review({ card, grade, now })` and `new Reschedule(scheduler).reschedule({ history })`
  all behave as documented. The scheduler code is a few KB per model version, split
  into chunks by Vite.
- **Optimizer (wasip1 build)** loads and trains in a module Worker without
  cross-origin isolation: 21 FSRS-6 parameters from synthetic histories, 82 ms of
  training for 14,000 items from 2,000 cards (plus 0.4 s building items). Its assets
  are a 1.4 MB WASM file (490 KB gzipped) and a 250 KB worker, fetched only when
  retuning.
- **Two traps found:**
  1. `@napi-rs/wasm-runtime` resolves its own `@emnapi/*` 1.x while the binding needs
     2.0.0-beta, which fails with `this.bridge.setLastError is not a function`. Fixed
     with an npm `overrides` entry pinning `@emnapi/core` and `@emnapi/runtime` to the
     binding's version.
  2. The worker module has a top-level `await` (it fetches the WASM), and a message
     posted to it before that finishes was lost: the job never started. The worker
     must post "ready" first, and the page sends the job only then.
- Vite needs `worker: { format: 'es' }` (top-level await isn't allowed in the default
  IIFE worker format) and `optimizeDeps.exclude` for the binding, so the WASM URL
  survives in dev.

Still to verify in the implementation PR: Android Chrome, iOS Safari and the iOS
home-screen app, timing on a phone, and how the optimizer behaves with little data.

## Architecture

The scheduler stays a pure function behind one module, so `check.ts` and `db.ts` don't
know which algorithm runs.

```
check.ts ──▶ scheduler.ts   schedule(sched, grade, now), skip(), isLearning()
               ├──▶ sm2.ts        today's scheduler.ts, unchanged logic
               └──▶ fsrs.ts       ts-fsrs wrapper: Sched ⇄ ts-fsrs Card, grade → Rating
Settings ──▶ schedulerSettings.ts  load/save, validation, defaults
         ──▶ optimizer.ts          history → items, runs optimizer.worker.ts
         ──▶ db.ts                 rescheduleAll(rebuild)
```

### `src/scheduler.ts`

```ts
export type Algorithm = 'sm2' | 'fsrs'

export function schedule(sched: Sched, grade: Grade, now: number): Sched
export function skip(sched: Sched, now: number): Sched
// Whether the card should come back in this session (replaces `interval === 0` in check.ts).
export function isLearning(sched: Sched, now: number): boolean
// Rebuilds a card's schedule from its reviews, oldest first; a card with no reviews gets
// a new schedule that keeps its current `due`.
export function rebuild(reviews: { at: number; grade: Grade }[], current: Sched): Sched
```

`schedule` and `rebuild` use the algorithm and options from `schedulerSettings.ts`. If a
card's `sched` belongs to the other algorithm (a card that hasn't been rebuilt yet, or
one synced from a device using the other algorithm), `schedule` rebuilds it from history
first. That needs the card's reviews, so `check.ts` passes them in (they are already read
for the stats) or `schedule` takes a `history` argument; this is settled in the
implementation.

`isLearning` is true for SM-2 when `interval === 0` and for FSRS when the card is in the
learning or relearning state. The retry rule in the session (at most two per card) is
unchanged.

### `src/fsrs.ts`

- Creates the ts-fsrs scheduler with `version: 'FSRS-6'`, the user's weights (or the
  FSRS-6 defaults) and options. `DefaultScheduler` is async, so it is created once when
  the session starts and again when settings change; `schedule` stays synchronous.
- Converts between our `Sched` (timestamps in ms, stored in IndexedDB) and ts-fsrs'
  `Card` (`Date` objects), and maps grades to ratings.
- `rebuild` uses `Reschedule.reschedule({ history })`.

### `src/optimizer.ts` and `src/optimizer.worker.ts`

- `optimizer.ts` reads all reviews (`id, cardId, at, grade`), builds the training input
  and starts the worker; it can be cancelled.
- **Training input:** the reviews are written as the CSV format the library already
  converts (`card_id, review_time, review_rating`), and the worker calls
  `convertCsvToFsrsItems(csv, 4, timeZone, 'FSRS-6')` with the device's IANA time zone.
  That reuses the library's own rules for day boundaries (study day starts at 4 am,
  as in Anki), so there's no hand-written item builder to get wrong.
- The worker posts `ready` after its WASM is loaded, then `progress` while training,
  then `done` with the parameters or `error`. Progress shows as a percentage; Cancel
  terminates the worker.
- **Too little data:** with fewer than a minimum number of reviews (the threshold comes
  from testing the optimizer on small histories in step 1 of the rollout; Anki uses
  a few hundred), the button explains that more reviews are needed instead of
  running.
- Results are validated (21 finite numbers within the library's bounds,
  `clipFSRS6Parameters`) before they are offered.

## Data model

`Sched` becomes a union. `due` stays at the top level, since the `[deckId+sched.due]`
index and every due query depend on it.

```ts
interface Sm2Sched {           // today's shape; `algo` missing means SM-2
  algo?: 'sm2'
  due: number; interval: number; ease: number; reps: number; lapses: number
}

interface FsrsSched {
  algo: 'fsrs'
  due: number
  stability: number
  difficulty: number
  state: 0 | 1 | 2 | 3          // ts-fsrs State: new, learning, review, relearning
  learningStep: number
  scheduledDays: number
  lastReview: number | null     // ms
  reps: number
  lapses: number
}

type Sched = Sm2Sched | FsrsSched
```

No Dexie version bump: `sched` isn't indexed beyond `due`. Older records read as SM-2.
The JSON backup carries whatever shape a card has. `DeckView`'s "due in" text only uses
`due`, so it works for both.

**Rebuilding** (`db.rescheduleAll`) reads all cards and reviews, computes each card's new
`sched` with `rebuild`, and writes them in one transaction. It also sets `updatedAt` (and
`sched.updatedAt` once Drive sync lands). It runs on switching algorithm and on applying
retuned parameters. For a few thousand cards this is well under a second; it shows a
"Rescheduling…" state and blocks the Settings controls while it runs.

Skips aren't reviews, so a rebuild drops a pending skip. The card simply becomes due
by its history. That is accepted.

## Settings

A **Scheduling** section in Settings:

- **Algorithm:** *Simple (SM-2)* / *FSRS*. Switching asks for confirmation ("This
  reschedules all N cards from your review history"), then rebuilds.
- **FSRS options** (shown when FSRS is selected), with defaults:
  - Desired retention: 0.90 (0.70–0.97; a short hint that higher means more reviews).
  - Maximum interval: 36,500 days.
  - Learning steps: `1m 10m`; relearning steps: `10m`. Text inputs validated against
    the library's step syntax.
  - Fuzz: on. It spreads reviews of cards learned together over nearby days.
- **Parameters:** "Default" or "Tuned on N reviews, date". **Optimize** runs the
  optimizer (progress, Cancel), then shows "New parameters fitted on N reviews.
  Apply and reschedule?" **Reset to defaults** asks to confirm and reschedules. An
  **Advanced** disclosure shows the 21 numbers in a text field for pasting parameters
  from Anki (FSRS-6), validated before saving, then applied like Optimize.
- Changes to options save immediately, like the other settings; nothing else
  reschedules.

`schedulerSettings.ts` stores `{ algorithm, fsrs: { desiredRetention, maximumInterval,
learningSteps, relearningSteps, enableFuzz, weights: number[] | null, tunedAt?,
tunedReviews? } }`. Invalid or missing values fall back to defaults field by field,
like `loadLlmSettings`.

## Drive sync

[drive-sync.md](drive-sync.md) syncs cards (with `sched`) and reviews but not settings.
With FSRS:

- Cards can arrive with the other algorithm's `sched`. `schedule` handles that by
  rebuilding from history (see above), so mixed devices work, just less efficiently.
- Each device tunes its own parameters, but on the same synced history, so they agree
  if both retune.
- Syncing scheduler settings would make this cleaner. It is listed as an open question
  in drive-sync.md; FSRS strengthens the case for doing it.

## Testing

**Unit tests** (`make test`):

- `fsrs.ts`: grade → rating mapping; `Sched` ⇄ ts-fsrs `Card` round trip; a new card's
  first Bad/Fair/Good matches ts-fsrs directly; options (retention, maximum interval,
  steps, fuzz off) reach the scheduler.
- `scheduler.ts`: dispatch by algorithm; a mismatched `sched` is rebuilt; `isLearning`
  for both shapes; `skip` only moves `due` for both.
- `rebuild`: SM-2 replay matches applying `schedule` step by step; FSRS replay matches
  `Reschedule`; no reviews keeps `due`; out-of-order reviews are sorted.
- `check.ts`: the retry rule uses `isLearning` (existing tests updated, FSRS cases
  added).
- `schedulerSettings.ts`: defaults, per-field fallback, weight validation (length,
  finite, clipped).
- `optimizer.ts`: CSV built from reviews (escaping, ordering, time zone passed through);
  the worker protocol (ready → job, progress, done, error, cancel) with a fake worker.
- The WASM optimizer itself isn't run in `make test`. One test can run it under Node,
  where the binding has a native build, on a small fixed history, to check that it
  returns 21 valid numbers. This is cheap enough for CI, and it is skipped if the
  binding fails to load.

**By hand:** switch SM-2 → FSRS → SM-2 on a deck with history and compare due dates;
retune with real history on Chrome desktop, Android Chrome, iOS Safari and the iOS
home-screen app; a study session under FSRS (learning steps requeue, undo, skip).

## Rollout

Two PRs, each ending with `make test` passing.

1. **FSRS scheduling.** `ts-fsrs`, the `Sched` union, `fsrs.ts`, `scheduler.ts`
   dispatch and `rebuild`, `isLearning` in `check.ts`, `rescheduleAll`, the Settings
   section with algorithm and options (no optimizer yet), docs (design.md's
   Scheduling section).
2. **Optimizer.** The binding, Vite worker config, npm `overrides`,
   `optimizer.ts`/worker, the minimum-reviews threshold, Optimize/Apply/Reset/paste in
   Settings, the Node test. Done when retuning works on the four platforms above.

## Open questions

- **FSRS-7** (34 parameters, fractional days) is the libraries' new default. Moving to
  it later means a version switch, retraining and a rebuild, all of which this design
  already supports. Wait until Anki adopts it, so pasted parameters keep working.
- **Per-deck presets**, as in Anki: different languages may warrant different
  retention. Settings would move to a preset referenced by each deck.
- **"Easy"**: if FSRS users want to push easy cards further out, a fourth grade could
  be added to the study screen only. LLM grading would keep its 3-point scale.
- **The optimizer package is in public beta** and its API may change; it is pinned to
  an exact version and upgraded deliberately.
