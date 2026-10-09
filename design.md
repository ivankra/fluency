# Design

Sentence drill PWA: show a sentence in the native language, the user translates it
into the target language, grades themselves, and the card is rescheduled.
Everything is stored on-device; there is no backend.

## Data

IndexedDB via Dexie (`src/db.ts`). Every entity has a UUID `id` and an `updatedAt`
timestamp (ms) for future sync.

- **Deck**: `name`.
- **Card**: `deckId`, `front` (native, the prompt), `back` (target, the expected
  answer), `sched`.
- **Review**: one graded attempt: `cardId`, `at`, `grade`, optional typed `answer`.
  Skips are not recorded.

`sched` is a nested object owned by the scheduler (`due`, `interval`, `ease`, `reps`,
`lapses`), so another algorithm can replace its fields without touching `Card`.
Only `due` is indexed (`[deckId+sched.due]`).

## Screens

Hash routes (`src/route.ts`), so browser back/forward work.

| Route | Screen |
|---|---|
| `#/` | Deck list with due counts. Tap a deck to study; Edit opens the deck. |
| `#/study/<deckId>` | Study session. |
| `#/edit/<deckId>` | Add, edit and delete cards; per-card stats; CSV export. |

## Study loop

`src/Study.tsx`. On entry it takes a snapshot of up to 20 due cards, soonest first.
For each card:

1. Show `front`; the user optionally types a translation.
2. Reveal `back` next to the typed answer.
3. The user self-rates **Bad / Fair / Good**. The attempt is logged and `sched` is
   replaced by the result of `schedule()`, in one transaction.

Keyboard: **Enter** reveals the answer. After that nothing is being typed, so
**1 / 2 / 3** grade Bad / Fair / Good, **Space** grades Good, **-** skips (Anki's bury
key) and **Ctrl/Cmd+Z** undoes. Shortcuts are ignored while a text field is focused.

**Skip** hides the card for 3 days and does not log a review or touch the schedule's
ease, interval or counters. A card can be edited mid-session.

**Undo** steps back to the previous card for the current session: it deletes that review
(or skip), restores the card's old schedule, removes any retry copy it queued, and
shows the card as it was, with the typed text and revealed answer. Text typed on the
card you left is kept and restored when you return to it.

## Scheduling

`src/scheduler.ts`: `schedule(sched, grade, now) → Sched`, a pure function (tested in
`scheduler.test.ts`). A simplified SM-2 with whole-day intervals and no learning-step
ladder.

A card with `interval = 0` is **new or relearning**. Otherwise it is a **review** card.

| State | Bad | Fair | Good |
|---|---|---|---|
| New / relearning | due in 10 min | interval 1 d | interval 1 d |
| Review | lapse: `interval = 0`, due in 10 min, ease −0.2 | interval × 1.2, ease −0.15 | interval × ease |

- New interval is at least the old one plus 1 day.
- Ease starts at 2.5 and never drops below 1.3.
- `lapses` counts only failures of review cards, not of new ones.
- Ease changes only for review cards, so repeated failures while relearning do not
  compound.

**In-session retry.** When a grade leaves a card at `interval = 0`, `Study` appends it
to the end of the queue, at most 2 times per card per session. The 10-minute delay only
sets `due` for later sessions; within a session the card returns as soon as the user
reaches it.

Tunable constants are at the top of `scheduler.ts`. No fuzz, no daily new-card limit.
