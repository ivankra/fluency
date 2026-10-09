import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import CardForm from './CardForm'
import { GRADES, editCard, getDueCards, recordReview, skipCard, undoAttempt, type Card, type Grade } from './db'
import { schedule, skip } from './scheduler'
import { href } from './route'

// A failed card is requeued this many times at most per session, so it can't loop forever.
const MAX_RETRIES = 2

const GRADE_CLASS: Record<Grade, string> = { 1: 'btn btn--danger', 2: 'btn', 3: 'btn btn--primary' }

// A queue entry: the card plus what the user has typed for it and whether the answer is
// shown. Keeping this per entry means going back (undo) finds the text where it was left.
interface Slot {
  card: Card
  answer: string
  revealed: boolean
}

const slotFor = (card: Card): Slot => ({ card, answer: '', revealed: false })

// A finished review or skip, kept so it can be undone.
interface Attempt {
  card: Card // as it was before, i.e. with the old schedule
  reviewId?: string
  requeued: boolean // a retry copy was appended to the queue
}

export default function Study({ deckId }: { deckId: string }) {
  // The queue is a snapshot taken on entry, so cards don't shuffle while we work through it.
  const [queue, setQueue] = useState<Slot[] | null>(null)
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [history, setHistory] = useState<Attempt[]>([])
  const retries = useRef(new Map<string, number>())
  // Retry entry dropped by an undo, so its typed text returns if the card fails again.
  const parked = useRef<Slot | null>(null)

  useEffect(() => {
    let stale = false
    getDueCards(deckId).then((cards) => !stale && setQueue(cards.map(slotFor)))
    return () => {
      stale = true
    }
  }, [deckId])

  const slot = queue?.[index]
  const card = slot?.card
  const answer = slot?.answer ?? ''
  const revealed = slot?.revealed ?? false

  const patch = (p: Partial<Slot>) =>
    setQueue((q) => q && q.map((s, i) => (i === index ? { ...s, ...p } : s)))

  // Run a db write for the current card, remember it for undo, then move on.
  // `busy` blocks double taps.
  const finish = async (write: (card: Card) => Promise<Pick<Attempt, 'reviewId' | 'requeued'>>) => {
    if (!card || busy) return
    setBusy(true)
    try {
      const done = await write(card)
      setHistory([...history, { card, ...done }])
      setIndex(index + 1)
    } finally {
      setBusy(false)
    }
  }

  const grade = (g: Grade) =>
    finish(async (c) => {
      const sched = schedule(c.sched, g)
      const reviewId = await recordReview(c, g, sched, answer.trim() || undefined)
      // interval 0 means the card is back to (re)learning: show it again this session.
      const tries = retries.current.get(c.id) ?? 0
      const requeued = sched.interval === 0 && tries < MAX_RETRIES
      if (requeued) {
        retries.current.set(c.id, tries + 1)
        const kept = parked.current?.card.id === c.id ? parked.current : slotFor(c)
        parked.current = null
        setQueue((q) => q && [...q, { ...kept, card: { ...c, sched } }])
      }
      return { reviewId, requeued }
    })

  const skipCurrent = () =>
    finish(async (c) => {
      await skipCard(c, skip(c.sched))
      return { requeued: false }
    })

  // Go back to the previous card exactly as it was: typed text and answer shown.
  const undo = async () => {
    const last = history.at(-1)
    if (!last || busy) return
    setBusy(true)
    try {
      await undoAttempt(last.card.id, last.card.sched, last.reviewId)
      if (last.requeued) {
        retries.current.set(last.card.id, (retries.current.get(last.card.id) ?? 1) - 1)
        parked.current = queue?.at(-1) ?? null
        setQueue((q) => q && q.slice(0, -1))
      }
      setHistory(history.slice(0, -1))
      setIndex(index - 1)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  // Fix a typo mid-session. Our snapshot of the card is updated too, so the fix shows at once.
  const saveEdit = async (front: string, back: string) => {
    if (!card || !queue) return
    await editCard(card.id, front, back)
    setQueue(queue.map((s) => (s.card.id === card.id ? { ...s, card: { ...s.card, front, back } } : s)))
    setEditing(false)
  }

  const reveal = (e: FormEvent) => {
    e.preventDefault()
    patch({ revealed: true })
  }

  // Enter reveals the answer; Shift+Enter adds a newline. Enter that confirms an IME
  // composition (Chinese/Japanese input) must not count.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) reveal(e)
  }

  // Keyboard, never while typing in a text field. Once Enter has revealed the answer
  // nothing is focused for typing, so: 1/2/3 grade, Space = Good, "-" skips (as Anki
  // buries). Ctrl/Cmd+Z undoes; inside the textarea it stays the browser's text undo.
  useEffect(() => {
    if (editing) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.repeat || e.altKey || target.matches('textarea, input')) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (!revealed || e.ctrlKey || e.metaKey) return
      const hit = GRADES.find(({ grade: g }) => String(g) === e.key)
      if (hit) grade(hit.grade)
      else if (e.key === '-') skipCurrent()
      // A focused button/link would also be "clicked" by Space, so leave it alone.
      else if (e.key === ' ' && !target.matches('button, a')) {
        e.preventDefault()
        grade(3)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!queue) return null

  return (
    <>
      <header className="bar">
        <a className="btn" href={href.list} aria-label="Back to decks">
          ‹ Decks
        </a>
        <span className="bar__title muted">{card && `${index + 1} / ${queue.length}`}</span>
        <button className="btn btn--small" disabled={!history.length || busy} onClick={undo}>
          Undo
        </button>
        {card && (
          <button className="btn btn--small" disabled={editing || busy} onClick={() => setEditing(true)}>
            Edit card
          </button>
        )}
      </header>

      {!card ? (
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
                {[...GRADES].reverse().map(({ grade: g, label }) => (
                  <button key={g} className={GRADE_CLASS[g]} disabled={busy} onClick={() => grade(g)}>
                    {label} <kbd>{g}</kbd>
                  </button>
                ))}
                <button className="btn" disabled={busy} onClick={skipCurrent}>
                  Skip <kbd>-</kbd>
                </button>
              </div>
            </>
          ) : (
            <form className="study__form" onSubmit={reveal}>
              <textarea
                value={answer}
                onChange={(e) => patch({ answer: e.target.value })}
                onKeyDown={onKeyDown}
                rows={3}
                placeholder="Translate into the target language…"
                aria-label="Your translation"
                autoFocus
              />
              <div className="study__actions">
                <button className="btn btn--primary">
                  Show answer <kbd>Enter</kbd>
                </button>
                <button type="button" className="btn" disabled={busy} onClick={skipCurrent}>
                  Skip
                </button>
              </div>
            </form>
          )}
        </section>
      )}
    </>
  )
}
