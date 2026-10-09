import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDeck, countDueCards, listDecks, type Deck } from './db'
import { exportBackupJson } from './exportFile'
import { href } from './route'

// Tapping the row starts studying; Edit opens the deck's cards.
function DeckRow({ deck }: { deck: Deck }) {
  const due = useLiveQuery(() => countDueCards(deck.id), [deck.id])
  return (
    <li className="deck-item">
      <a className="deck-row" href={href.study(deck.id)}>
        <span className="deck-row__name">{deck.name}</span>
        <span className="muted">{due === undefined ? '…' : `${due} due`}</span>
      </a>
      <a className="btn" href={href.edit(deck.id)} aria-label={`Edit ${deck.name}`}>
        Edit
      </a>
    </li>
  )
}

export default function DeckList() {
  const decks = useLiveQuery(listDecks)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const deck = await addDeck(trimmed)
    setName('')
    setCreating(false)
    location.hash = href.edit(deck.id)
  }

  return (
    <>
      <header className="bar">
        <h1 className="bar__title">Fluency</h1>
        <button className="btn btn--small" onClick={() => setCreating(!creating)}>
          New deck
        </button>
        <button className="btn btn--small" onClick={exportBackupJson}>
          Export all
        </button>
      </header>

      {creating && (
        <form className="inline-form" onSubmit={create}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New deck name"
            aria-label="New deck name"
            autoFocus
          />
          <button className="btn btn--primary" disabled={!name.trim()}>
            Create
          </button>
        </form>
      )}

      {decks?.length === 0 && <p className="muted empty">No decks yet. Tap “New deck” to create one.</p>}
      <ul className="list">
        {decks?.map((deck) => (
          <DeckRow key={deck.id} deck={deck} />
        ))}
      </ul>
    </>
  )
}
