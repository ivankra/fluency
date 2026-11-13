import DeckList from './DeckList'
import DeckView from './DeckView'
import Study from './Study'
import Settings from './Settings'
import UpdateToast from './UpdateToast'
import IosInstallPrompt from './IosInstallPrompt'
import { useRoute } from './route'

export default function App() {
  const route = useRoute()

  return (
    <main>
      {route.name === 'study' ? (
        <Study key={route.deckId} deckId={route.deckId} />
      ) : route.name === 'edit' ? (
        <DeckView key={route.deckId} deckId={route.deckId} />
      ) : route.name === 'settings' ? (
        <Settings />
      ) : (
        <DeckList />
      )}
      <div className="banners">
        <UpdateToast />
        <IosInstallPrompt />
      </div>
    </main>
  )
}
