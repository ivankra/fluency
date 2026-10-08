import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addCard, deleteCard, deleteDeck, editCard, listCards, listDecks, renameDeck, type Card } from './db'
import { exportDeckCsv } from './exportFile'
import CardForm from './CardForm'

function CardRow({ card }: { card: Card }) {
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

export default function DeckView({ deckId, onBack }: { deckId: string; onBack: () => void }) {
  const deck = useLiveQuery(async () => (await listDecks()).find((d) => d.id === deckId), [deckId])
  const cards = useLiveQuery(
    async () => (await listCards(deckId)).sort((a, b) => a.front.localeCompare(b.front)),
    [deckId],
  )
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')

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
    onBack()
    await deleteDeck(deck.id)
  }

  return (
    <>
      <header className="bar">
        <button className="btn" onClick={onBack} aria-label="Back to decks">
          ‹ Decks
        </button>
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
          {cards.length} {cards.length === 1 ? 'card' : 'cards'}
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
          <CardRow key={card.id} card={card} />
        ))}
      </ul>
    </>
  )
}
