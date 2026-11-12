import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDeck, countDueCards, listDecks, type Deck } from './db'
import { exportBackupJson } from './exportFile'
import { getLlmApiKey, loadLlmSettings } from './llm'
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

const SETUP_DISMISSED_KEY = 'fluency:llm-setup-dismissed'

// Shown until an API key is set or the user dismisses it.
function SetupCard() {
  const [visible, setVisible] = useState(() => {
    try {
      if (localStorage.getItem(SETUP_DISMISSED_KEY)) return false
    } catch {
      // Storage unavailable: show the card.
    }
    return !getLlmApiKey(loadLlmSettings().baseUrl)
  })
  if (!visible) return null

  const dismiss = () => {
    try {
      localStorage.setItem(SETUP_DISMISSED_KEY, '1')
    } catch {
      // Not remembered; the card returns next time.
    }
    setVisible(false)
  }

  return (
    <div className="panel setup-card">
      <span className="setup-card__text">Get feedback on your translations: set up LLM grading.</span>
      <a className="btn btn--small btn--primary" href={href.settings}>
        Set up
      </a>
      <button className="btn btn--small" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
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
        <a className="btn btn--small" href={href.settings} aria-label="Settings" title="Settings">
          ⚙︎
        </a>
      </header>

      <SetupCard />

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
