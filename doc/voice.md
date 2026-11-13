# Voice

Design for text-to-speech and speech recognition, so the study loop can be done fully
by voice instead of text.

## Goal

The app targets speaking fluency, but today the user types. Voice lets them:

1. **hear** sentences: the prompt, the reference translation, the corrected answer
   and the feedback summary;
2. **speak** the translation instead of typing it;
3. go through a whole session **hands-free** (while walking, cooking, driving as a
   passenger): the app reads the prompt, listens to the answer, says the LLM's grade
   and moves on (or takes the grade as a spoken command when there is no check).

There is still no backend: speech uses the browser's Web Speech API, as the proposal
planned. [llm-grading.md](llm-grading.md) laid the groundwork: BCP 47 language tags on
decks (the `lang` that speech APIs take), a feedback summary written to be read aloud,
and `Session` actions that keyboard, buttons and voice can all call.

The work lands in one PR, built in order: read-aloud, then dictation with grading of
spoken answers, then hands-free mode (see [Rollout](#rollout)).

**Non-goals:** pronunciation or tone feedback (that needs audio-level scoring, a
separate optional item in the proposal); recording or storing audio; cloud ASR/TTS;
voice commands outside the study screen; translating the UI or the command words;
speech recognition where the browser doesn't offer it (Firefox, iOS home-screen apps).

## Decisions

| Question | Decision | Why |
|---|---|---|
| Engines | `speechSynthesis` and `SpeechRecognition` (`webkitSpeechRecognition`), behind a thin wrapper (`speech.ts`) | Free, no extra key, the proposal's choice. The wrapper keeps the option of another engine later. |
| Features | Three parts: read-aloud buttons, dictation (a mic button), hands-free mode | Each is useful on its own; hands-free is built from the first two. |
| Hands-free control | An async loop (`handsFree.ts`) that drives `Session` through its public actions, like the keyboard does | `Session` changes little; the loop is tested with mocked speech, like `check.test.ts`. |
| Turn-taking | Never speak and listen at the same time | Otherwise the recognizer hears the app's own voice. iOS also handles playback and recording badly when they overlap. |
| Commands | A fixed set of English words, recognized as a separate utterance in English | The UI is English. The answer recognizer runs in the target language and can't reliably catch English words. |
| Transcript | Goes into the answer field. Dictation leaves it editable until Enter; hands-free submits when the recognizer ends the utterance | Dictation lets the user fix recognition errors; hands-free has no screen to fix them on. |
| Grading spoken answers | `GradingInput.answerMode: 'spoken'` adds a fixed transcript rule to the prompt; `PROMPT_VERSION` 2 | Recognition errors (punctuation, homophones, character choice) shouldn't cost a grade. This was planned in llm-grading.md. |
| Final say | By default hands-free takes the LLM's grade without asking: it says the grade and a short feedback (see Settings), and moves on. With **Confirm grade** set, it says "Suggested: Fair" and waits for "yes" or a grade, as a voice grade. Unchecked cards are always graded by voice. Outside hands-free nothing changes | Reading the full feedback out and waiting for a command took too long. All the feedback stays on screen while the grade is said. |
| Mistakes | With Confirm grade, after each voice grade the app says the grade and briefly listens for "undo". Otherwise there's no undo window: the user taps Undo (or Ctrl/Cmd+Z), or says "undo" at "Done" or when the app asks for a grade | The window costs 2–3 s per card; it's only worth it where a grade can be misheard. |
| Starting | Hands-free starts with a tap in each session and is not remembered. The tap unlocks speech and asks for the mic before the loop runs | iOS needs a user gesture; permission dialogs must appear while the user is looking at the screen; the mic shouldn't open on its own. |
| Silence | No answer: listen again, then read the prompt again, then pause. Commands: hint once, then pause | The mic never stays open forever, and waiting doubles as "repeat the prompt". |
| iOS home-screen app | Read-aloud only. No mic button and no hands-free, with a note that the keyboard's dictation key still works | WebKit doesn't support recognition in home-screen apps (see below). Sending users to Safari doesn't help: Safari has separate storage, so their decks aren't there. |
| Audio | We never store audio or send it anywhere ourselves | The browser's recognizer may send it to its vendor; the privacy note says so. |

## Browser support

What we know before the spike:

| | Chrome desktop | Android Chrome | iOS Safari (browser) | iOS home-screen app | Firefox |
|---|---|---|---|---|---|
| `speechSynthesis` | yes; local voices plus Google network voices | yes; system TTS voices | yes; system voices, more can be downloaded in iOS Settings | yes | yes |
| `SpeechRecognition` | yes, prefixed; audio goes to Google, needs a connection | yes, prefixed; Google | yes, prefixed (Safari 14.1 / iOS 14.5); needs Siri & Dictation turned on | **no** | no |

- **iOS home-screen apps:** WebKit doesn't support recognition there ([WebKit bug
  225298](https://bugs.webkit.org/show_bug.cgi?id=225298)). The constructor exists but
  `start()` does nothing, so feature detection is fooled. `canListen()` therefore
  returns false when `navigator.standalone` is true (only iOS sets it). If recognition
  still doesn't start (see the start watchdog under `speech.ts`), the user gets a
  "try again" error rather than a hang. Chrome and Edge on iOS
  use WebKit too, so they behave like Safari. iOS 26 opens home-screen sites as apps by
  default, and the app already asks iOS users to install it, so many iOS users will get
  read-aloud only. The keyboard's dictation key still works in the answer field; such
  answers count as typed.
- Recognition needs a secure context (HTTPS or localhost) and microphone permission.
  On iOS Safari the user is asked twice (microphone, then speech recognition), and
  Safari may ask again on later visits.
- **Languages:** Chrome 139+ has `SpeechRecognition.available({ langs, processLocally:
  false })`. Where it exists, voice input is disabled up front for a deck language
  reported as `unavailable`. Other browsers only report an unsupported language as an
  error once listening starts.
- **Ending an utterance:** with `continuous: false` (the default we plan on) the
  recognizer ends the utterance at a pause and ends the session with `no-speech` after
  several seconds of silence. Continuous mode is unreliable: results repeat on Android,
  and `isFinal` is flaky on iOS.
- Voices differ by device. A language with no voice can't be read aloud; the UI says
  so instead of failing silently. Chrome desktop's Google network voices have long cut
  off after about 15 s of speech; our texts are one or two sentences.
- TypeScript's DOM types don't include `SpeechRecognition`, so `speech.ts` declares the
  small part it uses.

### Spike

The work starts with a spike on the three platforms. The results are written into
this section and may change the decisions above.

**Status: not run yet.** It needs real Android and iOS devices. The implementation
follows the defaults in this doc (`continuous: false`, the timeouts in `speech.ts`), so
the spike is a manual test of the app itself.

Questions:

1. iOS: confirm recognition still doesn't work in the home-screen app on current iOS.
   In Safari, does each `start()` or `speak()` need a user gesture, or only the first?
2. Pauses: learners pause in the middle of a sentence. How long a pause does
   `continuous: false` tolerate on each platform before ending the utterance? If it's
   too short, decide between continuous mode with our own silence timer (where it
   works) and a spoken or tapped "done".
3. Recognition languages and tags: `es`, `zh-CN`, `zh-TW`, `ja`, `en`. How well does it
   handle a learner's accent? Which command words does it confuse?
4. Voices: what's available per language and platform, when `voiceschanged` fires, and
   which voice to prefer (local or network).
5. Switching from speaking to listening: the delay, the Android start beep, and
   whether iOS turns the volume down after recording.
6. Screen Wake Lock in the installed app on Android (iOS home-screen apps have it since
   iOS 18.4).
7. Priming: does the recognizer's `start` event come only after the permission dialogs
   are answered on every platform? If not, prime on `audiostart` instead.

## Architecture

```
Study ──▶ SpeakButton, mic button ──────────▶ speech.ts ──▶ speechSynthesis / SpeechRecognition
  │                                              ▲
  ├──▶ HandsFree (handsFree.ts) ── speak/listen ─┘
  │       │  reads Session state, calls its actions
  ▼       ▼
Session (check.ts) ──▶ grader.ts (answerMode → prompt)
```

Same split as before: pure logic in tested modules, browser I/O in a thin layer,
components only wire them together.

### `src/speech.ts`: Web Speech wrapper and voice settings

```ts
export type SpeechErrorKind =
  | 'unsupported'   // from feature detection only: no API, or an iOS home-screen app
  | 'no-voice'      // no TTS voice for the language
  | 'not-allowed'   // microphone or speech service blocked (incl. Siri & Dictation off)
  | 'no-microphone'
  | 'network'
  | 'language'      // recognizer doesn't support the language
  | 'failed'        // retryable: includes speech or listening that never started, or an unconfirmed end
export class SpeechError extends Error { kind: SpeechErrorKind }

export const canSpeak: () => boolean
export const canListen: () => boolean                       // false in iOS home-screen apps
export function voicesReady(): Promise<void>                // voiceschanged, or give up after ~1 s
export function hasVoice(lang: string): boolean
export function recognitionAvailable(lang: string): Promise<boolean | null>  // null: can't tell

// Resolves when the utterance has been spoken. Aborting cancels it and rejects.
export function speak(text: string, lang: string, options: { rate?: number; signal: AbortSignal }): Promise<void>

// One utterance in `lang`. `result` has empty text if nothing was heard (no-speech).
// finish() stops listening but keeps what was heard (SpeechRecognition.stop());
// aborting the signal discards it (abort()) and rejects.
export interface Listening {
  result: Promise<{ text: string; alternatives: string[] }>
  finish(): void
}
export function listen(options: {
  lang: string
  signal: AbortSignal
  onInterim?: (text: string) => void
  onStart?: () => void              // listening has begun: permissions are granted
}): Listening

// Unlock speech and ask for the mic from inside a tap handler (see Hands-free).
export function primeFromGesture(lang: string): Promise<void>

// Pure, tested:
export function pickVoice(voices: VoiceLike[], lang: string): VoiceLike | null
export function joinTranscript(parts: string[], lang: string): string

export function voicesFor(lang: string): SpeechSynthesisVoice[]   // best first, for the picker

export interface VoiceSettings {   // localStorage `fluency:voice`, see Settings
  rate: number; otherRate: number; voices: Record<string, string>; readReference: boolean
  spokenFeedback: 'minimal' | 'short' | 'full'; confirmGrade: boolean; hideText: boolean
  privacyNoteSeen: boolean
}
export function loadVoiceSettings(): VoiceSettings
export function saveVoiceSettings(settings: VoiceSettings): void
```

- **One operation at a time.** Starting `speak` or `listen` aborts whatever is running.
  While hands-free runs, Study hides the manual speaker and mic buttons, so they can't
  abort the loop's own speech.
- **Voice choice** (`pickVoice`): accept `_` as well as `-` (Android reports `es_ES`).
  Prefer an exact tag match, then the same language (a deck in `es` takes `es-ES` or
  `es-MX`). Chinese must not mix scripts: `zh-CN` never takes a `zh-TW` or `zh-HK` voice.
  Among equal matches, prefer the browser default, then local voices, which also work
  offline. A voice picked in settings (by `voiceURI`, per language tag) wins while the
  device still has it, and also serves other tags of its language (picked for `en`, it
  reads announcements in `en-US`); `speak` looks it up itself, so every caller gets it.
- **Two rates:** `rate` for the target language (the reference, the corrected sentence,
  a spoken answer read back) and `otherRate` for everything else (the prompt, the
  summary, announcements). Callers pass the right one.
- **`speak` never reports success it can't confirm.** The utterance object is kept
  referenced until it ends, since Chrome can drop it otherwise. A watchdog covers
  missing events:
  - no `start` within 3 s (for example, iOS without a gesture): cancel and throw
    `failed`;
  - no `end` by a deadline (estimated duration ÷ rate, × 2, + 3 s): cancel and throw
    `failed`, whatever `speechSynthesis.speaking` says. That flag can't tell a
    finished utterance from an interrupted one. Only `end` counts as success, so the
    loop pauses rather than going ahead without the user hearing the content. Keeping
    the utterance referenced should make a lost `end` rare. If the spike finds a
    platform where it is common, we revisit this.
  - `interrupted` and `canceled` errors caused by our own cancel count as an abort,
    not an error.
- **`listen` settings:** `continuous: false`, `interimResults: true`,
  `maxAlternatives: 3`, unless the spike says otherwise. `no-speech` resolves with
  empty text; callers decide whether to listen again. A hard upper limit (30 s) aborts
  a recognizer that never ends.
- **Start watchdog for `listen`.** If there is no `start` event in time, listening is
  aborted with a retryable `failed` ("Couldn't start listening. Try again.").
  - Until recognition has started once in this page session, the limit is 20 s, enough
    for the user to read permission dialogs. After that, starting needs no dialog,
    so the limit is 3 s.
  - Microphone permission alone doesn't shorten it. WebKit asks for speech recognition
    separately, so the mic can be allowed while a second dialog is still open.
  - A timeout is never taken as proof that recognition is unsupported, and nothing is
    remembered from it.
- **Transcript joining**: no spaces between segments for `zh` and `ja`.
- **Errors** map to `SpeechError` with a message for the user: "Microphone access is
  blocked: allow it in the browser's site settings", "Speech recognition needs a
  connection", "This browser can't recognize Japanese", "Turn on Siri & Dictation in
  iOS Settings to speak answers". `aborted` isn't an error.

### `src/check.ts` and `src/db.ts`: answer mode

```ts
export type AnswerMode = 'typed' | 'spoken'
interface Slot { ...; answerMode: AnswerMode }

setAnswer(answer: string, mode: AnswerMode = 'typed', key?: number)
submit(key?: number)
grade(grade: Grade): Promise<boolean>   // also skip() and undo(): true once written
```

- **Answer mode.** Once any part of an answer is spoken it stays `'spoken'`, even if
  the user edits the text to fix recognition errors. Clearing the field resets it to
  `'typed'`. New slots and new retry copies start `'typed'`. A parked retry copy keeps
  its answer text, so it keeps its mode too.
- **Stale results.** With `key`, `setAnswer` and `submit` do nothing unless that slot
  is still current and not revealed. Dictation and hands-free always pass the key of
  the slot they started on, so a late transcript can't land on, or submit, the next
  card.
- **Results of actions.** `grade`, `skip` and `undo` return whether the write happened,
  as `saveEdit` already does. That lets the hands-free loop tell a command refused
  because a write was in flight from a failed save (`saveError`) or a success.
- `check()` puts `answerMode: 'spoken'` into `GradingInput`; typed answers leave it
  out, so their request is the same as before.
- `grade()` passes `answerMode: 'spoken'` to `recordReview`, whose `extra` gains the
  field. In storage and in `GradingInput`, a missing value means typed, matching
  older records.

### `src/handsFree.ts`: the hands-free loop

```ts
export interface HandsFreeDeps {
  session: Session
  languages(): { source: string; target: string; feedback: string } | null
  speak: typeof speak
  listen: typeof listen
  settings(): Pick<VoiceSettings, 'rate' | 'otherRate' | 'spokenFeedback' | 'confirmGrade'>
  keepAwake(): () => void   // Screen Wake Lock; returns release
}

export type HandsFreePhase =
  'off' | 'starting' | 'speaking' | 'listening-answer' | 'waiting' | 'listening-command'
  | 'listening-undo' | 'paused'
export interface HandsFreeState { phase: HandsFreePhase; interim: string; message: string | null }

export class HandsFree {
  subscribe, getState      // like Session, for useSyncExternalStore
  start(prime?: () => Promise<void>)   // call from a tap; prime = primeFromGesture
  stop()
  dispose()
}

export type Command = { grade: Grade } | 'skip' | 'repeat' | 'undo' | 'stop'
export function parseCommand(alternatives: string[]): Command | null   // pure, tested
```

**Start and Resume** run inside the tap handler. The voices are already loaded (Study
calls `voicesReady()` when it mounts). `primeFromGesture` synchronously speaks a silent
utterance, which unlocks speech on iOS. It then starts a recognizer and aborts it on
its `start` event, so any permission dialogs appear now, while the user is looking.
`HandsFree.start(prime)` calls it synchronously and shows the `starting` phase meanwhile.
Only then does the loop start, and only if nothing stopped it in between (Stop, leaving
the screen, opening the editor). A second tap while starting is ignored. A permission
error pauses with its message; being cut off by another speech operation is not success.

The loop works on `session.current`, one pass at a time:

```
pass:
  no slot          → say "Done. Say undo to go back"; listen for "undo" (one try); stop
  not revealed     → speak front (source)
                     listen (target); nothing heard → listen again;
                       still nothing → read the prompt again, listen;
                       still nothing → pause
                     session.setAnswer(text, 'spoken', key); session.submit(key)
  revealed         → check pending → wait silently until it settles ("Checking…" on screen)
                     check done:  say the grade ("Fair"), unless confirmGrade;
                                  spoken feedback:
                                    minimal: nothing more
                                    short:   below Good, the reference (target rate)
                                    full:    the reference; with errors, "You said …"
                                             (spoken answers) and "Corrected …"; summary
                                  confirmGrade: "Suggested: Fair"; listen for a command
                                  else: session.grade(the LLM's grade); next pass
                     otherwise (idle, error, no grader): speak the reference;
                                  check error: "Couldn't check.";
                                  "Say good, fair or bad."; listen for a command (English)
```

Whatever isn't read out stays on screen until the grade is written. If the LLM's grade
is refused because another write is in flight, the loop asks for a grade instead.

| Command result | Then |
|---|---|
| grade, accept or skip written | say "Fair" / "Skipped"; with confirmGrade, listen briefly for "undo"; next pass |
| "accept" without a suggestion | say the hint, listen again |
| refused, a write in flight | listen again (don't reread the card) |
| failed save | pause with "Couldn't save" |
| repeat | the same pass again |
| undo | `session.undo()`; the next pass reads the previous card out again |
| stop | stop |
| nothing heard or not a command | hint once ("Say yes, or good, fair or bad." when there's a suggestion), then pause |

- **What restarts a pass.** A pass is bound to the current slot's `(key, revealed)`.
  The loop keeps the pair it expects.
  - Notifications that keep the pair (answer edits, check results, the writing flag)
    change nothing. A pass that is waiting for a check simply watches its status.
  - **The loop's own actions.** `Session` notifies synchronously, from inside
    `submit()` and before `grade()`'s promise resolves. So the loop marks an action as
    its own *before* calling it, and ignores pair changes until the action settles.
    `submit` settles at once; `grade`, `skip` and `undo` settle when their promise
    resolves. The loop then takes the current pair as expected and carries on.
  - Any other change of the pair comes from outside (a tapped grade, a key, a typed
    submit, undo by button). It aborts the running speak or listen and starts a new
    pass on the current slot. So keyboard and buttons keep working, and an undo lands
    on the previous, revealed slot, which is read out again.
  - While the loop's own write is in flight, outside writes are refused by `Session`
    anyway, so there's nothing to miss.
- **Never pays for a check.** On an `idle` check the loop doesn't call `check()`: it
  treats the card as unchecked and asks for a grade. This keeps the rule that nothing calls the
  LLM after an undo or a reconnect. An idle revealed slot happens after submitting
  offline, after undoing to a card graded while its check was pending, or with an
  empty answer.
- **Pause, not stop**, on silence, unknown commands, speech errors or a failed save.
  The reason is spoken if possible and shown with a **Resume** button. Resume primes
  again, like Start.
- **Stops** on Stop (button or command), when the session ends, when the screen is
  left, when the card editor opens, and when the page is hidden (recognition stops in
  the background anyway).
- **Wake lock** while running, so the screen doesn't turn off and suspend the page.
  It is released on pause and stop. Without the Wake Lock API, the loop still works
  while the screen is on.
- The check itself is unchanged: submit starts it as before, so reading the reference
  covers part of the LLM's latency.
- **A cut-off answer** (the recognizer ended the utterance at a pause) is submitted
  as is. Undo only reverses graded attempts, so there is no redo. The spike's pause
  tuning (item 2) decides whether that needs more.

### Commands

Recognized with `lang: 'en-US'`. Each alternative from the recognizer is lowercased and
stripped of punctuation, and must match a whole phrase. Digits and common mishearings
are included:

| Say | Also matched | Does | Keyboard |
|---|---|---|---|
| "yes", "okay", "accept", "next" | "yeah", "ok" | accept the suggested grade (Confirm grade); without one, the hint is said instead | Space / Enter |
| "good" | "three", "3" | grade Good | 3 |
| "fair" | "two", "2", "fare", "to", "too" | grade Fair | 2 |
| "bad" | "one", "1", "won" | grade Bad | 1 |
| "skip" | | skip | `-` |
| "repeat" | "again" | read the revealed card again | — |
| "undo" | "go back" | undo the last attempt | Ctrl/Cmd+Z |
| "stop" | "pause" | stop hands-free | — |

Commands are only listened for on a revealed card the loop didn't grade itself, right
after a voice grade with Confirm grade, and at "Done". While the user
answers, the recognizer runs in the target language. To give up on a card, the user
says so in that language ("no sé", "不知道"): the LLM grades it Bad and the reference is
read. The spike adds any other mishearings it finds.

## Grading spoken answers

`GradingInput` gains `answerMode?: 'typed' | 'spoken'`, set only for spoken answers.
When it is spoken, the system prompt gets one more fixed paragraph after the grading
rules:

```
The answer is a speech-recognition transcript of what the learner said, not typed
text. Ignore punctuation, capitalization, spelling and accents, and the choice between
words or characters that sound the same, or between kana and kanji: those come from
the recognizer, not the learner. This overrides the learner's rules on these points.
Judge words, grammar and meaning as heard. In corrected, write the answer with normal
spelling and punctuation, plus the smallest edits that fix any errors.
```

- `PROMPT_VERSION` becomes 2. The prompt for typed answers doesn't change.
- **Showing the corrected sentence.** A transcript has no punctuation, so its
  corrected version almost always differs from it, even when nothing is wrong. For
  spoken answers, the feedback panel shows the corrected
  sentence only when `errors` isn't empty. Typed answers keep the current rule: shown
  when it differs from the answer.
- Pronunciation is judged only indirectly: a badly pronounced word may be heard as a
  different word and graded as one. The panel labels the answer "You said" so it is
  clear the text is a transcript, so the user can tell a misrecognition from a real
  mistake.
- **Evaluation:** `eval/grading-cases.json` gains an optional `answerMode`. The script
  already passes each case's fields to the grader; it reports spoken cases in their own
  row, so a few of them can't hide among the typed ones. New spoken cases:
  - transcripts without punctuation or capitals (3);
  - Spanish homophones (*hay*/*ahí*), Chinese homophones (在/再), Japanese written all in
    kana (3);
  - a grammar error the ear can hear, such as *la casa es blanco* (2);
  - critical meaning errors that must still fail: negation, reversed meaning (1).

  The existing quality bar applies to the spoken row too.

## Study screen

- **Read aloud:** a small speaker button next to the prompt (source language), the
  reference and the corrected sentence (target language), and the summary (feedback
  language). It is hidden without `speechSynthesis` and disabled, with a reason, when
  the device has no voice for the language. Tapping it again stops playback. Playback
  also stops when the card changes or the user leaves the screen, since
  `speechSynthesis` belongs to the whole page.
- **Dictation:** a mic button next to "Show answer". While it listens, the button shows
  Stop and the text being recognized appears under the field.
  - Stop finishes listening and keeps what was heard, appending it to the answer, which
    stays editable.
  - Enter or "Show answer" while listening acts like Stop: it finishes dictation and
    does not submit. The user checks the text and presses Enter again. This avoids
    submitting before the final text has arrived: a revealed answer can't be changed,
    so a late result couldn't fix it.
  - Skip, opening the editor or leaving the screen discard it.
  - It is hidden where `canListen()` is false. Settings explains why; for iOS
    home-screen apps it says the keyboard's dictation key still works.
- **Hands-free:** a header button that starts the loop. While it runs, a status line
  shows the phase ("Listening for your answer…", "Say yes, good, fair, bad, skip
  or repeat"), the text being recognized, and Stop or Resume. The manual speaker and mic
  buttons are hidden. The answer field isn't focused automatically, so the phone
  keyboard stays closed. With **Hide the text**, the prompt shows "Listen…" and the
  reference "Hidden" while the loop runs (not while paused); the corrected sentence,
  which is close to the reference, is hidden too. When "undo" is all it listens for
  (after a voice grade with Confirm grade, and at "Done"), the status says "Say undo to
  go back".
- **Read the reference on reveal** (a setting, outside hands-free): the reference is read
  at the target rate when the card is revealed, and stops when the card changes. Not
  when hands-free stops on a revealed card.
- **Requirements:** voice needs the deck's languages: the target for listening and
  reading the reference, the source for reading the prompt. Without them the voice
  controls simply don't appear; the sample decks have languages, and the deck editor
  sets them. LLM grading is not required: without it, the user grades themselves
  after hearing the reference.
- **Privacy note on first use:** the first time the user taps the mic or Hands-free, a
  line under the controls says the browser's speech service may receive the audio. It
  stays until dismissed (`privacyNoteSeen`).

## Settings

A **Voice** section on `#/settings`:

Stored in `localStorage` (`fluency:voice`), not in the backup; saved on change.

- **Speech rate** for the language you're learning, and for everything else: Slower
  (0.7), Slow (0.85), Normal (1), Fast (1.2), Faster (1.4).
- **Voice per language:** one picker for each language the decks use and the feedback
  language, plus English (announcements) if none of them is English: "Automatic (<the best match's name>)" or any voice that
  speaks it, with a speaker button that says the language's name in it.
- **Read the reference aloud when the answer is shown.** Off by default.
- **Hands-free** (where recognition works):
  - **Spoken feedback:** Minimal (the grade), Short (default: also the reference below
    Good) or Full (the reference, the correction and the summary).
  - **Confirm the LLM's grade:** off by default (see Final say).
  - **Hide the prompt and the reference**, for listening practice.
- **Availability**, so the user doesn't have to guess: "Speech recognition isn't
  supported in this browser" (Firefox), "Speech recognition isn't available in the
  installed app on iOS; the keyboard's dictation key still works", or "Turn on Siri &
  Dictation" when known.
- **Privacy note:** "Speaking an answer uses your browser's speech recognition, which
  may send the audio to its provider (Google in Chrome on Android and desktop, Apple
  on iOS). Fluency doesn't store or send audio itself." The README's privacy sentence
  changes to match.

## Data model

| Entity | New field | Notes |
|---|---|---|
| `Review` | `answerMode?: 'typed' \| 'spoken'` | Set only when spoken; missing means typed. Lets stats compare spoken and typed accuracy later. |
| `ReviewAssessment.input` | `answerMode?` | Through `GradingInput`. |

Both are optional and not indexed: no Dexie version bump, and the JSON backup includes
them automatically. llm-grading.md's groundwork section already describes the field
this way.

## Security and privacy

- Audio goes from the browser to its own speech service, never through our code. We
  keep only the transcript, as the review's `answer`, the same as a typed answer.
- Transcripts reach the LLM like typed answers, with the same data/instruction split.
- The mic is open only while listening. Hands-free never starts without a tap, and
  every listen has a time limit.

## Testing

**Unit tests** (`make test`, no browser speech):

- `pickVoice`: exact, region and underscore matches; Chinese scripts never mixed;
  default and local preference; no voice.
- `joinTranscript`: spaced languages, `zh`, `ja`.
- `parseCommand`: every word and its listed mishearings, digits, punctuation and case,
  a match only in a later alternative, phrases with extra words (no match), empty input.
- `speak`, against a fake `speechSynthesis`: normal end; no `start` (fails); no `end`
  by the deadline, whether or not still speaking (cancels and fails); a late `end`
  after the failure is ignored; abort; our own cancel's `interrupted` error treated as
  an abort.
- `listen`, against a fake `SpeechRecognition` class: final result with alternatives;
  interim updates; `no-speech` gives empty text; `finish()` keeps the result and abort
  discards it; error mapping; no `start` event (retryable `failed`); the first start
  in a page session gets 20 s, later ones 3 s; the microphone allowed while the
  recognition dialog is still open, with no early timeout; the hard time limit.
- `buildGradingRequest`: the spoken paragraph present only for `'spoken'`; the typed
  prompt unchanged.
- `check.ts`:
  - `answerMode` is set by `setAnswer`, kept through edits and reset by clearing, and
    sent to the grader and stored on the review only when spoken;
  - new retry copies start typed, parked copies keep their mode;
  - `setAnswer` and `submit` with a stale key do nothing;
  - `grade`, `skip` and `undo` return false when refused or failed.
- `handsFree.ts`, with a real `Session` (mocked I/O, as in `check.test.ts`) and mocked
  `speak`/`listen`:
  - happy path: the prompt is read, the answer is submitted as spoken, the LLM's grade
    is said and written without asking, the next card follows; below Good the reference
    is read first, before the grade is written;
  - the loop's own `setAnswer`, `submit` and `grade` don't restart its pass, including
    `Session`'s synchronous notifications from inside them; a grade tapped while the
    grade is said moves on without grading twice;
  - outside changes: a tapped grade while listening aborts and moves on; a typed submit
    on the same card while listening moves to the revealed pass;
  - "undo" when asked for a grade, and at "Done", returns to the previous card and
    reads it out again;
  - no LLM grade (no grader, check error, idle after undo): the reference, the hint,
    and `check()` never called;
  - a command refused while a write is in flight: listen again;
  - silence: listen again, read the prompt again, then pause; unknown commands: the
    hint, then pause;
  - a failed save or a speech error pauses with a message;
  - stop and dispose abort the running speak or listen and release the wake lock;
  - end of queue: "Done", then stop.

**Manual**, on Chrome desktop, Android Chrome (installed app) and iOS Safari (browser
and home-screen app):

- read-aloud in Spanish, Chinese and Japanese;
- dictation, including Stop and Enter while listening (finishes, no submit), and a
  slow answer to the permission dialog;
- a full hands-free session, with and without LLM grading;
- permission prompts on Start, and permission denied;
- offline;
- a language with no voice;
- screen lock during hands-free;
- the home-screen app on iOS shows read-aloud only.

## Rollout

One PR. The work goes in this order, so the risky parts are proven before the rest
depends on them, and `make test` passes after each step:

1. **Spike.** The questions in [Spike](#spike), answered on the three platforms, with
   the results written into this doc. They may change the steps below.
2. **Read-aloud.** `speech.ts` (`speak` with its watchdog, voice picking, settings), the
   speaker buttons and the Voice settings section (rate, availability).
3. **Dictation and spoken grading.** `listen()`, the mic button, the privacy note,
   `answerMode` and the `setAnswer` key in `check.ts`, `GradingInput` and `Review`,
   prompt v2 with the corrected-sentence rule, the new eval cases and the spoken row.
4. **Hands-free.** `primeFromGesture`, `handsFree.ts` with tests, the boolean results
   of `grade`/`skip`/`undo`, the commands, wake lock, the status line.
5. **Docs.** The privacy wording in settings and the README; design.md's status and a
   link here; the README feature list and file map.

Done when:

- read-aloud works on all three platforms;
- dictation works where recognition exists;
- the grading quality bar holds for the spoken row (results in the PR description);
- on Chrome desktop, Android and iOS Safari, a full session (undo, skip and retry
  included) can be done without touching the screen after the first tap.

## Risks and open questions

- **iOS home-screen users get read-aloud only.** Many iOS users will be in that group.
  The one way around it would be to record audio ourselves (`getUserMedia` and
  `MediaRecorder` work in home-screen apps) and send it to the LLM provider, if it
  accepts audio input. That is a cloud ASR path with its own cost, privacy and design.
  It is also the path to the proposal's optional pronunciation feedback, so it belongs
  in that design, not in v1.
- **Recognition quality for learners:** accented speech may be heard as other words
  and graded down. The spoken-mode rule helps with spelling, not with this. The eval
  can't measure it, so it is judged by hand during the spike.
- **Pauses mid-sentence:** if `continuous: false` cuts learners off too often, we need
  a "done" signal, at the cost of being less hands-free (spike item 2).
- **Commands in other languages,** once the UI is translated.
- **A keyboard shortcut for dictation** on desktop.
