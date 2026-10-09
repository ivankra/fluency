import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDeck, countDueCards, listDecks, type Deck } from './db'
import { exportBackupJson } from './exportFile'

// Tapping the row starts studying; Edit opens the deck's cards.
function DeckRow({ deck, onStudy, onEdit }: { deck: Deck; onStudy: () => void; onEdit: () => void }) {
  const due = useLiveQuery(() => countDueCards(deck.id), [deck.id])
  return (
    <li className="deck-item">
      <button className="deck-row" onClick={onStudy}>
        <span className="deck-row__name">{deck.name}</span>
        <span className="muted">{due === undefined ? '…' : `${due} due`}</span>
      </button>
      <button className="btn" onClick={onEdit} aria-label={`Edit ${deck.name}`}>
        Edit
      </button>
    </li>
  )
}

export default function DeckList({ onStudy, onEdit }: { onStudy: (deckId: string) => void; onEdit: (deckId: string) => void }) {
  const decks = useLiveQuery(listDecks)
  const [name, setName] = useState('')

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const deck = await addDeck(trimmed)
    setName('')
    onEdit(deck.id)
  }

  return (
    <>
      <header className="bar">
        <h1>Fluency</h1>
        <button className="btn" onClick={exportBackupJson}>
          Export all
        </button>
      </header>

      <form className="inline-form" onSubmit={create}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New deck name"
          aria-label="New deck name"
        />
        <button className="btn btn--primary" disabled={!name.trim()}>
          Create deck
        </button>
      </form>

      {decks?.length === 0 && <p className="muted empty">No decks yet. Create one above.</p>}
      <ul className="list">
        {decks?.map((deck) => (
          <DeckRow key={deck.id} deck={deck} onStudy={() => onStudy(deck.id)} onEdit={() => onEdit(deck.id)} />
        ))}
      </ul>
    </>
  )
}
