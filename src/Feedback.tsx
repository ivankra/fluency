import type { Slot } from './check'
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

const kindLabel = (kind: string) => kind[0].toUpperCase() + kind.slice(1).replace('-', ' ')

function FeedbackList({ title, items }: { title: string; items: FeedbackItem[] }) {
  if (!items.length) return null
  return (
    <div>
      <span className="muted">{title}</span>
      <ul className="feedback__items">
        {items.map((item, position) => (
          <li key={position}>
            <span className="feedback__kind">{kindLabel(item.kind)}</span> {item.note}
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
              <p className="study__text">{check.assessment.corrected}</p>
            </div>
          )}
          {check.assessment.summary && (
            <p className="feedback__summary">
              {check.assessment.summary} {speakButton(check.assessment.summary, voice?.feedback, voice?.otherRate)}
            </p>
          )}
          <FeedbackList title="Errors" items={check.assessment.errors} />
          <FeedbackList title="Suggestions" items={check.assessment.suggestions} />
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
