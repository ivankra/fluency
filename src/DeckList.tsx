import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDeck, countCards, listDecks, type Deck } from './db'
import { exportBackupJson } from './exportFile'

function DeckRow({ deck, onOpen }: { deck: Deck; onOpen: () => void }) {
  const count = useLiveQuery(() => countCards(deck.id), [deck.id])
  return (
    <li>
      <button className="deck-row" onClick={onOpen}>
        <span className="deck-row__name">{deck.name}</span>
        <span className="muted">
          {count ?? '…'} {count === 1 ? 'card' : 'cards'}
        </span>
      </button>
    </li>
  )
}

export default function DeckList({ onOpen }: { onOpen: (deckId: string) => void }) {
  const decks = useLiveQuery(listDecks)
  const [name, setName] = useState('')

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const deck = await addDeck(trimmed)
    setName('')
    onOpen(deck.id)
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
          <DeckRow key={deck.id} deck={deck} onOpen={() => onOpen(deck.id)} />
        ))}
      </ul>
    </>
  )
}
