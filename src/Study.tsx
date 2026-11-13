import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import CardForm from './CardForm'
import Feedback from './Feedback'
import { Session, type Grader } from './check'
import { GRADES, editCard, getDeck, getDueCards, recordReview, skipCard, undoAttempt, type Deck, type Grade } from './db'
import { assessAnswer } from './grader'
import { getLlmApiKey, loadLlmSettings, type LlmSettings } from './llm'
import { href } from './route'

const GRADE_CLASS: Record<Grade, string> = { 1: 'btn btn--danger', 2: 'btn', 3: 'btn btn--primary' }

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
  const { queue, index, history, writing, saveError } = useSyncExternalStore(session.subscribe, session.getState)
  const [editing, setEditing] = useState(false)

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

  const submit = (event: FormEvent) => {
    event.preventDefault()
    session.submit()
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
      </header>

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
          <p className="study__prompt">{card.front}</p>

          {slot.revealed ? (
            <>
              <Feedback
                slot={slot}
                canCheck={canCheck}
                missingLanguages={missingLanguages}
                deckId={deckId}
                onCheck={() => session.check()}
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
                autoFocus
              />
              <div className="study__actions">
                <button className="btn btn--primary">
                  Show answer <kbd>Enter</kbd>
                </button>
                <button type="button" className="btn" disabled={writing} onClick={() => session.skip()}>
                  Skip
                </button>
              </div>
            </form>
          )}
        </section>
      )}
      {saveError && <p className="feedback__error">{saveError}</p>}
    </>
  )
}
