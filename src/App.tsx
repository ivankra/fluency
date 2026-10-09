import { useState } from 'react'
import DeckList from './DeckList'
import DeckView from './DeckView'
import Study from './Study'
import IosInstallPrompt from './IosInstallPrompt'

type View = { name: 'list' } | { name: 'study' | 'edit'; deckId: string }

export default function App() {
  const [view, setView] = useState<View>({ name: 'list' })
  const toList = () => setView({ name: 'list' })

  return (
    <main>
      {view.name === 'study' ? (
        <Study deckId={view.deckId} onBack={toList} />
      ) : view.name === 'edit' ? (
        <DeckView deckId={view.deckId} onBack={toList} />
      ) : (
        <DeckList
          onStudy={(deckId) => setView({ name: 'study', deckId })}
          onEdit={(deckId) => setView({ name: 'edit', deckId })}
        />
      )}
      <IosInstallPrompt />
    </main>
  )
}
