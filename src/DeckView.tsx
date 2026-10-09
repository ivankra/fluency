import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addCard, deleteCard, deleteDeck, editCard, gradeCounts, listCards, listDecks, renameDeck, type Card, type Sched } from './db'
import { exportDeckCsv } from './exportFile'
import CardForm from './CardForm'
import { href } from './route'
import { DAY } from './scheduler'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function dueText(due: number, now: number) {
  const wait = due - now
  if (wait <= 0) return 'due now'
  const minutes = Math.round(wait / MINUTE)
  if (minutes < 60) return `due in ${Math.max(minutes, 1)}m`
  const hours = Math.round(wait / HOUR)
  return hours < 24 ? `due in ${hours}h` : `due in ${Math.round(wait / DAY)}d`
}

const GRADE_NAMES = ['Bad', 'Fair', 'Good']

// e.g. "2 1 4 · due in 3d", where the numbers count Bad / Fair / Good attempts.
function CardStats({ sched, counts }: { sched: Sched; counts?: number[] }) {
  return (
    <div className="card-row__stats">
      {counts ? (
        counts.map(
          (n, i) =>
            n > 0 && (
              <span key={i} className={`grade grade--${i + 1}`} title={`${GRADE_NAMES[i]}: ${n} ${n === 1 ? 'attempt' : 'attempts'}`}>
                {n}
              </span>
            ),
        )
      ) : (
        <span>new</span>
      )}
      <span>{dueText(sched.due, Date.now())}</span>
    </div>
  )
}

function CardRow({ card, counts }: { card: Card; counts?: number[] }) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <li className="card-row card-row--editing">
        <CardForm
          initialFront={card.front}
          initialBack={card.back}
          submitLabel="Save"
          onSubmit={(front, back) => editCard(card.id, front, back).then(() => setEditing(false))}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  }

  const remove = () => {
    if (confirm(`Delete this card?\n\n${card.front}`)) deleteCard(card.id)
  }

  return (
    <li className="card-row">
      <div className="card-row__text">
        <div>{card.front}</div>
        <div className="card-row__back">{card.back}</div>
        <CardStats sched={card.sched} counts={counts} />
      </div>
      <div className="card-row__actions">
        <button className="btn btn--small" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="btn btn--small btn--danger" onClick={remove}>
          Delete
        </button>
      </div>
    </li>
  )
}

export default function DeckView({ deckId }: { deckId: string }) {
  const deck = useLiveQuery(async () => (await listDecks()).find((d) => d.id === deckId) ?? null, [deckId])
  const cards = useLiveQuery(
    async () => (await listCards(deckId)).sort((a, b) => a.front.localeCompare(b.front)),
    [deckId],
  )
  const counts = useLiveQuery(() => gradeCounts(deckId), [deckId])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')

  if (deck === null) {
    // e.g. back button to a deck that has since been deleted
    return (
      <>
        <a className="btn" href={href.list}>
          ‹ Decks
        </a>
        <p className="muted empty">This deck no longer exists.</p>
      </>
    )
  }
  if (!deck || !cards) return null

  const startRename = () => {
    setName(deck.name)
    setRenaming(true)
  }

  const saveRename = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) await renameDeck(deck.id, name.trim())
    setRenaming(false)
  }

  const remove = async () => {
    if (!confirm(`Delete "${deck.name}" and all ${cards.length} cards? This can't be undone.`)) return
    location.hash = href.list
    await deleteDeck(deck.id)
  }

  return (
    <>
      <header className="bar">
        <a className="btn" href={href.list} aria-label="Back to decks">
          ‹ Decks
        </a>
        {renaming ? (
          <form className="inline-form bar__title" onSubmit={saveRename}>
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Deck name" autoFocus />
            <button className="btn btn--primary">Save</button>
          </form>
        ) : (
          <h1 className="bar__title">{deck.name}</h1>
        )}
      </header>

      <div className="toolbar">
        <span className="muted">
          {cards.length} {cards.length === 1 ? 'card' : 'cards'} · {cards.filter((c) => c.sched.due <= Date.now()).length} due
        </span>
        <span className="toolbar__spacer" />
        {!renaming && (
          <button className="btn btn--small" onClick={startRename}>
            Rename
          </button>
        )}
        <button className="btn btn--small" onClick={() => exportDeckCsv(deck, cards)} disabled={!cards.length}>
          Export CSV
        </button>
        <button className="btn btn--small btn--danger" onClick={remove}>
          Delete deck
        </button>
      </div>

      <section className="panel">
        <h2>Add a card</h2>
        <CardForm submitLabel="Add card" onSubmit={(front, back) => addCard(deck.id, front, back)} />
      </section>

      {cards.length === 0 && <p className="muted empty">No cards yet.</p>}
      <ul className="list">
        {cards.map((card) => (
          <CardRow key={card.id} card={card} counts={counts?.get(card.id)} />
        ))}
      </ul>
    </>
  )
}
