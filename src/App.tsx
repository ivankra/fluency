import { useState } from 'react'
import DeckList from './DeckList'
import DeckView from './DeckView'
import IosInstallPrompt from './IosInstallPrompt'

export default function App() {
  const [deckId, setDeckId] = useState<string | null>(null)

  return (
    <main>
      {deckId ? <DeckView deckId={deckId} onBack={() => setDeckId(null)} /> : <DeckList onOpen={setDeckId} />}
      <IosInstallPrompt />
    </main>
  )
}
