import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { getDueCards, recordReview, skipCard, type Card, type Grade } from './db'
import { schedule } from './scheduler'

const GRADES: { grade: Grade; label: string; className: string }[] = [
  { grade: 1, label: 'Bad', className: 'btn btn--danger' },
  { grade: 2, label: 'Fair', className: 'btn' },
  { grade: 3, label: 'Good', className: 'btn btn--primary' },
]

export default function Study({ deckId, onBack }: { deckId: string; onBack: () => void }) {
  // The queue is a snapshot taken on entry, so cards don't shuffle while we work through it.
  const [queue, setQueue] = useState<Card[] | null>(null)
  const [index, setIndex] = useState(0)
  const [answer, setAnswer] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    getDueCards(deckId).then((cards) => !stale && setQueue(cards))
    return () => {
      stale = true
    }
  }, [deckId])

  if (!queue) return null

  const card = queue[index] as Card | undefined

  const next = () => {
    setIndex(index + 1)
    setAnswer('')
    setRevealed(false)
  }

  // Run a db write for the current card, then move on. `busy` blocks double taps.
  const finish = async (write: (card: Card) => Promise<unknown>) => {
    if (!card || busy) return
    setBusy(true)
    try {
      await write(card)
      next()
    } finally {
      setBusy(false)
    }
  }

  const grade = (g: Grade) =>
    finish((c) => recordReview(c, g, schedule(c.sched, g), answer.trim() || undefined))

  const reveal = (e: FormEvent) => {
    e.preventDefault()
    setRevealed(true)
  }

  // Enter reveals the answer; Shift+Enter adds a newline. Enter that confirms an IME
  // composition (Chinese/Japanese input) must not count.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) reveal(e)
  }

  return (
    <>
      <header className="bar">
        <button className="btn" onClick={onBack} aria-label="Back to decks">
          ‹ Decks
        </button>
        <h1 className="bar__title">Study</h1>
        {card && (
          <span className="muted">
            {index + 1} / {queue.length}
          </span>
        )}
      </header>

      {!card ? (
        <p className="muted empty">{queue.length ? 'Done!' : 'Nothing due right now.'}</p>
      ) : (
        <section className="panel study">
          <p className="study__prompt">{card.front}</p>

          {revealed ? (
            <>
              {answer.trim() && (
                <div>
                  <span className="muted">Your answer</span>
                  <p className="study__text">{answer}</p>
                </div>
              )}
              <div>
                <span className="muted">Expected</span>
                <p className="study__text study__expected">{card.back}</p>
              </div>
              <div className="study__actions">
                {GRADES.map(({ grade: g, label, className }) => (
                  <button key={g} className={className} disabled={busy} onClick={() => grade(g)}>
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <form className="study__form" onSubmit={reveal}>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={onKeyDown}
                rows={3}
                placeholder="Translate into the target language…"
                aria-label="Your translation"
                autoFocus
              />
              <div className="study__actions">
                <button type="button" className="btn" disabled={busy} onClick={() => finish(skipCard)}>
                  Skip
                </button>
                <button className="btn btn--primary">Show answer</button>
              </div>
            </form>
          )}
        </section>
      )}
    </>
  )
}
