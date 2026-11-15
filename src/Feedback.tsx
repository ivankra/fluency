import type { Slot } from './check'
import { diffWords } from './diff'
import { showCorrected, type FeedbackItem } from './grader'
import { href } from './route'
import SpeakButton from './SpeakButton'

interface Props {
  slot: Slot
  canCheck: boolean // grading is set up for this deck
  missingLanguages: boolean // grading is set up, but the deck has no languages
  deckId: string
  onCheck: () => void
  voice: { target?: string; feedback: string; rate: number; otherRate: number } | null // read-aloud buttons; null hides them
  hideReference: boolean // hands-free listening practice
  onVoiceError: (message: string) => void
}

// Ignores case, spacing and punctuation, e.g. "Hola, amigo." matches "hola amigo".
const normalize = (text: string) => text.toLocaleLowerCase().replace(/[\s\p{P}]+/gu, '')

const kindLabel = (kind: string) => kind[0].toUpperCase() + kind.slice(1).replace('-', ' ')

// The answer with removed words struck through and added words highlighted.
function CorrectionDiff({ answer, corrected, lang }: { answer: string; corrected: string; lang?: string }) {
  return (
    <p className="study__text" lang={lang}>
      {diffWords(answer, corrected).map((part, position) =>
        part.type === 'same' ? (
          part.text
        ) : part.type === 'removed' ? (
          <del key={position} className="diff diff--removed">{part.text}</del>
        ) : (
          <ins key={position} className="diff diff--added">{part.text}</ins>
        ),
      )}
    </p>
  )
}

// e.g. "Grammar  soy → estoy  Use estar for temporary states."
// Items from older reviews have no excerpt or fix.
function FeedbackList({ title, items, lang }: { title: string; items: FeedbackItem[]; lang?: string }) {
  if (!items.length) return null
  return (
    <div>
      <span className="muted">{title}</span>
      <ul className="feedback__items">
        {items.map((item, position) => (
          <li key={position}>
            <span className="feedback__kind">{kindLabel(item.kind)}</span>{' '}
            {(item.excerpt || item.fix) && (
              <span className="feedback__change" lang={lang}>
                {item.excerpt && <del className="diff diff--removed">{item.excerpt}</del>}
                {item.excerpt && item.fix && ' → '}
                {item.fix && <ins className="diff diff--added">{item.fix}</ins>}
              </span>
            )}{' '}
            {item.note}
          </li>
        ))}
      </ul>
    </div>
  )
}

// The revealed card: the answer, the reference, and the LLM's feedback if any.
// Model output is rendered as plain text only.
export default function Feedback({ slot, canCheck, missingLanguages, deckId, onCheck, voice, hideReference, onVoiceError }: Props) {
  const answer = slot.answer.trim()
  const { check } = slot
  const lang = check.status === 'done' ? check.request.input.targetLanguage : undefined
  // Skip alternatives that repeat what's already on screen.
  const shown = new Set([answer, slot.card.back, check.status === 'done' ? check.assessment.corrected : ''].map(normalize))
  const alternatives = check.status === 'done' ? (check.assessment.alternatives ?? []).filter((text) => !shown.has(normalize(text))) : []
  const speakButton = (text: string, lang: string | undefined, rate = 1) =>
    voice && <SpeakButton text={text} lang={lang} rate={rate} onError={onVoiceError} />

  return (
    <>
      {answer && (
        <div>
          <span className="muted">{slot.answerMode === 'spoken' ? 'You said' : 'Your answer'}</span>
          <p className="study__text">{slot.answer}</p>
        </div>
      )}
      <div>
        <span className="muted">Reference translation</span> {speakButton(slot.card.back, voice?.target, voice?.rate)}
        <p className="study__text study__expected">{hideReference ? <span className="muted">Hidden</span> : slot.card.back}</p>
      </div>

      {check.status === 'pending' && <p className="muted feedback__status">Checking…</p>}

      {check.status === 'done' && (
        <div className="feedback">
          {showCorrected(check.assessment, answer, slot.answerMode) && !hideReference && (
            <div>
              <span className="muted">Corrected</span>{' '}
              {speakButton(check.assessment.corrected, voice?.target, voice?.rate)}
              {slot.answerMode === 'spoken' ? (
                // A transcript has no punctuation, so a diff would mark every sentence.
                <p className="study__text" lang={lang}>{check.assessment.corrected}</p>
              ) : (
                <CorrectionDiff answer={answer} corrected={check.assessment.corrected} lang={lang} />
              )}
            </div>
          )}
          {check.assessment.summary && (
            <p className="feedback__summary">
              {check.assessment.summary} {speakButton(check.assessment.summary, voice?.feedback, voice?.otherRate)}
            </p>
          )}
          <FeedbackList title="Errors" items={check.assessment.errors} lang={lang} />
          <FeedbackList title="Suggestions" items={check.assessment.suggestions} lang={lang} />
          {alternatives.length > 0 && !hideReference && (
            <div>
              <span className="muted">Other ways to say it</span>
              <ul className="feedback__items">
                {alternatives.map((text) => (
                  <li key={text}>
                    <span lang={lang}>{text}</span> {speakButton(text, voice?.target, voice?.rate)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {check.status === 'error' && (
        <p className="feedback__status">
          Couldn't check: {check.error.message}{' '}
          {check.error.kind === 'auth' && <a href={href.settings}>Settings</a>}{' '}
          <button className="btn btn--small" onClick={onCheck}>
            Retry
          </button>
        </p>
      )}

      {check.status === 'idle' && answer && canCheck && (
        <p className="feedback__status">
          <button className="btn btn--small" onClick={onCheck}>
            Check answer
          </button>
        </p>
      )}

      {missingLanguages && answer && (
        <p className="muted feedback__status">
          Set this deck's languages to get feedback: <a href={href.edit(deckId)}>Edit deck</a>
        </p>
      )}
    </>
  )
}
