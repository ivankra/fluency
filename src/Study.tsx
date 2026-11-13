import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import CardForm from './CardForm'
import Feedback from './Feedback'
import { Session, type Grader } from './check'
import { GRADES, editCard, getDeck, getDueCards, recordReview, skipCard, undoAttempt, type Deck, type Grade } from './db'
import { assessAnswer } from './grader'
import { HandsFree, keepScreenAwake, type HandsFreePhase } from './handsFree'
import { getLlmApiKey, loadLlmSettings, type LlmSettings } from './llm'
import { languageName } from './languages'
import { href } from './route'
import SpeakButton from './SpeakButton'
import {
  canListen,
  hasVoice,
  isAbort,
  listen,
  loadVoiceSettings,
  primeFromGesture,
  PRIVACY_NOTE,
  recognitionAvailable,
  saveVoiceSettings,
  speak,
  voicesReady,
} from './speech'
import { useDictation } from './useDictation'

const GRADE_CLASS: Record<Grade, string> = { 1: 'btn btn--danger', 2: 'btn', 3: 'btn btn--primary' }

const HANDS_FREE_STATUS: Record<Exclude<HandsFreePhase, 'off' | 'paused'>, string> = {
  starting: 'Starting…',
  speaking: 'Speaking…',
  'listening-answer': 'Listening for your answer…',
  waiting: 'Checking…',
  'listening-command': 'Say yes, good, fair, bad, skip or repeat.',
  'listening-undo': 'Say undo to go back.',
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Grading needs it enabled, an API key, and the deck's languages.
function makeGrader(settings: LlmSettings, deck: Deck | null | undefined): Grader | null {
  const apiKey = getLlmApiKey(settings.baseUrl)
  if (!settings.enabled || !apiKey || !deck?.sourceLanguage || !deck.targetLanguage) return null
  return {
    model: settings.model,
    context: {
      sourceLanguage: deck.sourceLanguage,
      targetLanguage: deck.targetLanguage,
      feedbackLanguage: settings.feedbackLanguage,
      gradingRules: settings.gradingRules,
    },
    assess: (input, signal) => assessAnswer(input, settings, apiKey, signal),
  }
}

export default function Study({ deckId }: { deckId: string }) {
  const deck = useLiveQuery(() => getDeck(deckId), [deckId])
  const deckRef = useRef(deck)
  deckRef.current = deck
  // Settings only change on the settings screen, so reading them once is enough.
  const [settings] = useState(loadLlmSettings)
  const [voiceSettings, setVoiceSettings] = useState(loadVoiceSettings)
  const [session] = useState(
    () =>
      new Session({
        grader: () => makeGrader(settings, deckRef.current),
        isOnline: () => navigator.onLine,
        now: Date.now,
        recordReview,
        skipCard,
        undoAttempt,
        editCard,
      }),
  )
  const [handsFree] = useState(
    () =>
      new HandsFree({
        session,
        languages: () => {
          const current = deckRef.current
          return current?.sourceLanguage && current.targetLanguage
            ? { source: current.sourceLanguage, target: current.targetLanguage, feedback: settings.feedbackLanguage }
            : null
        },
        speak,
        listen,
        settings: loadVoiceSettings,
        keepAwake: keepScreenAwake,
      }),
  )
  const { queue, index, history, writing, saveError } = useSyncExternalStore(session.subscribe, session.getState)
  const handsFreeState = useSyncExternalStore(handsFree.subscribe, handsFree.getState)
  const [editing, setEditing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [privacyNote, setPrivacyNote] = useState(false)
  const [recognizes, setRecognizes] = useState<boolean | null>(null)
  const [, setVoicesLoaded] = useState(false)

  // The queue is a snapshot taken on entry, so cards don't shuffle while we work.
  useEffect(() => {
    let stale = false
    getDueCards(deckId).then((cards) => !stale && session.load(cards))
    return () => {
      stale = true
      session.dispose()
    }
  }, [deckId, session])

  const slot = queue?.[index]
  const check = slot?.check
  const suggested = check?.status === 'done' ? check.assessment.grade : undefined
  const canCheck = makeGrader(settings, deck) !== null
  const missingLanguages =
    settings.enabled && !!getLlmApiKey(settings.baseUrl) && !!deck && !(deck.sourceLanguage && deck.targetLanguage)

  // --- Voice ---

  const source = deck?.sourceLanguage
  const target = deck?.targetLanguage
  const canDictate = canListen() && !!target && recognizes !== false
  const canHandsFree = canDictate && !!source
  // Hands-free reads the prompt, the reference, English announcements and, with grading,
  // the feedback summary, so it needs those voices.
  const missingVoice = [source, target, 'en-US', canCheck ? settings.feedbackLanguage : undefined].find(
    (lang) => lang && !hasVoice(lang),
  )
  const { phase } = handsFreeState
  const handsFreeRunning = phase !== 'off' && phase !== 'paused'
  const hideText = handsFreeRunning && voiceSettings.hideText
  const dictation = useDictation(session, slot, target, setVoiceError)

  // Voices load asynchronously in Chrome; re-render once they are known.
  useEffect(() => {
    voicesReady().then(() => setVoicesLoaded(true))
  }, [])

  useEffect(() => {
    let stale = false
    if (target) recognitionAvailable(target).then((available) => !stale && setRecognizes(available))
    return () => {
      stale = true
    }
  }, [target])

  // Read the reference on reveal, if set; hands-free reads it itself. Stops with the card.
  useEffect(() => {
    if (!slot?.revealed || handsFreeRunning || !voiceSettings.readReference || !target || !hasVoice(target)) return
    const controller = new AbortController()
    speak(slot.card.back, target, { rate: voiceSettings.rate, signal: controller.signal }).catch(
      (error) => !isAbort(error) && setVoiceError(errorMessage(error)),
    )
    return () => controller.abort()
  }, [slot?.key, slot?.revealed]) // only on reveal, not when hands-free stops

  // Hands-free stops when the screen is left, the page is hidden or the editor opens.
  useEffect(() => {
    const onVisibility = () => document.hidden && handsFree.stop()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      handsFree.dispose()
    }
  }, [handsFree])

  useEffect(() => {
    if (!editing) return
    handsFree.stop()
    dictation.cancel()
  }, [editing]) // handsFree is stable; dictation.cancel only reads a ref

  // The first use of the mic shows where the audio goes, until dismissed.
  const notePrivacy = () => {
    if (!voiceSettings.privacyNoteSeen) setPrivacyNote(true)
  }
  const dismissPrivacyNote = () => {
    const next = { ...voiceSettings, privacyNoteSeen: true }
    saveVoiceSettings(next)
    setVoiceSettings(next)
    setPrivacyNote(false)
  }

  const startDictation = () => {
    notePrivacy()
    setVoiceError(null)
    dictation.start()
  }

  // Runs inside the tap: priming unlocks speech on iOS and asks for permissions now.
  const startHandsFree = () => {
    if (!target) return
    notePrivacy()
    setVoiceError(null)
    dictation.cancel()
    handsFree.start(() => primeFromGesture(target))
  }

  // --- Answer and keyboard ---

  // While dictating, Enter only finishes it; the user checks the text and submits.
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (dictation.dictating) dictation.finish()
    else session.submit()
  }

  // Enter submits; Shift+Enter adds a newline. Enter that confirms an IME composition
  // (Chinese/Japanese input) must not count.
  const onAnswerKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
  }

  // Close the editor only once the edit is saved; a refused or failed save keeps it open.
  const saveEdit = async (front: string, back: string) => {
    if (await session.saveEdit(front, back)) setEditing(false)
  }

  // Keyboard, never while typing in a text field. After the reveal: 1/2/3 grade,
  // Space/Enter accept the suggestion (Good without one, nothing while checking),
  // "-" skips. Ctrl/Cmd+Z undoes; in the textarea it stays the browser's text undo.
  useEffect(() => {
    if (editing) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.repeat || event.altKey || target.matches('textarea, input')) return
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        session.undo()
        return
      }
      if (!slot?.revealed || event.ctrlKey || event.metaKey) return
      const hit = GRADES.find(({ grade }) => String(grade) === event.key)
      if (hit) session.grade(hit.grade)
      else if (event.key === '-') session.skip()
      // A focused button or link handles Space/Enter itself.
      else if ((event.key === ' ' || event.key === 'Enter') && !target.matches('button, a')) {
        event.preventDefault()
        if (check?.status === 'done') session.accept()
        else if (check?.status !== 'pending') session.grade(3)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!queue) return null
  const card = slot?.card
  const showVoiceError = (message: string) => setVoiceError(message)

  return (
    <>
      <header className="bar">
        <a className="btn" href={href.list} aria-label="Back to decks">
          ‹ Decks
        </a>
        <span className="bar__title muted">{card && `${index + 1} / ${queue.length}`}</span>
        <button className="btn btn--small" disabled={!history.length || writing} onClick={() => session.undo()}>
          Undo
        </button>
        {card && (
          <button className="btn btn--small" disabled={editing || writing} onClick={() => setEditing(true)}>
            Edit card
          </button>
        )}
        {card && canHandsFree && phase === 'off' && !editing && (
          <button
            className="btn btn--small"
            onClick={startHandsFree}
            disabled={!!missingVoice}
            title={missingVoice && `No ${languageName(missingVoice)} voice on this device`}
          >
            Hands-free
          </button>
        )}
      </header>

      {phase !== 'off' && (
        <div className="panel hands-free" role="status">
          <span className="hands-free__text">
            {phase === 'paused' ? handsFreeState.message || 'Paused.' : HANDS_FREE_STATUS[phase]}
            {handsFreeState.interim && <span className="muted"> “{handsFreeState.interim}”</span>}
          </span>
          {phase === 'paused' && (
            <button className="btn btn--small btn--primary" onClick={startHandsFree}>
              Resume
            </button>
          )}
          <button className="btn btn--small" onClick={() => handsFree.stop()}>
            Stop
          </button>
        </div>
      )}

      {privacyNote && (
        <div className="panel setup-card">
          <span className="setup-card__text muted">{PRIVACY_NOTE}</span>
          <button className="btn btn--small" onClick={dismissPrivacyNote} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!slot || !card ? (
        <p className="muted empty">{queue.length ? 'Done!' : 'Nothing due right now.'}</p>
      ) : editing ? (
        <section className="panel">
          <CardForm
            key={card.id}
            initialFront={card.front}
            initialBack={card.back}
            submitLabel="Save"
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        </section>
      ) : (
        <section className="panel study">
          <p className="study__prompt">
            {hideText ? <span className="muted">Listen…</span> : card.front}{' '}
            {!handsFreeRunning && !dictation.dictating && (
              <SpeakButton text={card.front} lang={source} rate={voiceSettings.otherRate} onError={showVoiceError} />
            )}
          </p>

          {slot.revealed ? (
            <>
              <Feedback
                slot={slot}
                canCheck={canCheck}
                missingLanguages={missingLanguages}
                deckId={deckId}
                onCheck={() => session.check()}
                voice={
                  handsFreeRunning
                    ? null
                    : { target, feedback: settings.feedbackLanguage, rate: voiceSettings.rate, otherRate: voiceSettings.otherRate }
                }
                hideReference={hideText}
                onVoiceError={showVoiceError}
              />
              <div className="study__actions">
                {[...GRADES].reverse().map(({ grade, label }) => (
                  <button
                    key={grade}
                    className={`${GRADE_CLASS[grade]}${grade === suggested ? ' btn--suggested' : ''}`}
                    disabled={writing}
                    onClick={() => session.grade(grade)}
                  >
                    {label} <kbd>{grade}</kbd>
                  </button>
                ))}
                <button className="btn" disabled={writing} onClick={() => session.skip()}>
                  Skip <kbd>-</kbd>
                </button>
              </div>
            </>
          ) : (
            <form className="study__form" onSubmit={submit}>
              <textarea
                value={slot.answer}
                onChange={(event) => session.setAnswer(event.target.value)}
                onKeyDown={onAnswerKeyDown}
                rows={3}
                placeholder="Translate into the target language…"
                aria-label="Your translation"
                autoFocus={phase === 'off'}
              />
              {dictation.dictating && <p className="muted study__interim">{dictation.interim || 'Listening…'}</p>}
              <div className="study__actions">
                <button className="btn btn--primary">
                  Show answer <kbd>Enter</kbd>
                </button>
                {canDictate && !handsFreeRunning && (
                  <button
                    type="button"
                    className={dictation.dictating ? 'btn btn--suggested' : 'btn'}
                    onClick={dictation.dictating ? dictation.finish : startDictation}
                  >
                    {dictation.dictating ? 'Stop' : 'Speak'}
                  </button>
                )}
                <button type="button" className="btn" disabled={writing} onClick={() => session.skip()}>
                  Skip
                </button>
              </div>
            </form>
          )}
        </section>
      )}
      {saveError && <p className="feedback__error">{saveError}</p>}
      {voiceError && <p className="feedback__error">{voiceError}</p>}
    </>
  )
}
