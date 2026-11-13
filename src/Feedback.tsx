import type { Slot } from './check'
import type { FeedbackItem } from './grader'
import { href } from './route'

interface Props {
  slot: Slot
  canCheck: boolean // grading is set up for this deck
  missingLanguages: boolean // grading is set up, but the deck has no languages
  deckId: string
  onCheck: () => void
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
export default function Feedback({ slot, canCheck, missingLanguages, deckId, onCheck }: Props) {
  const answer = slot.answer.trim()
  const { check } = slot

  return (
    <>
      {answer && (
        <div>
          <span className="muted">Your answer</span>
          <p className="study__text">{slot.answer}</p>
        </div>
      )}
      <div>
        <span className="muted">Reference translation</span>
        <p className="study__text study__expected">{slot.card.back}</p>
      </div>

      {check.status === 'pending' && <p className="muted feedback__status">Checking…</p>}

      {check.status === 'done' && (
        <div className="feedback">
          {check.assessment.corrected && check.assessment.corrected !== answer && (
            <div>
              <span className="muted">Corrected</span>
              <p className="study__text">{check.assessment.corrected}</p>
            </div>
          )}
          {check.assessment.summary && <p className="feedback__summary">{check.assessment.summary}</p>}
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
