// Minimal hash router, so the browser's back/forward buttons move between screens.
import { useSyncExternalStore } from 'react'

export type Route = { name: 'list' } | { name: 'study' | 'edit'; deckId: string }

export const href = {
  list: '#/',
  study: (deckId: string) => `#/study/${deckId}`,
  edit: (deckId: string) => `#/edit/${deckId}`,
}

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash)
  const [name, deckId] = hash.replace(/^#\/?/, '').split('/')
  return (name === 'study' || name === 'edit') && deckId ? { name, deckId } : { name: 'list' }
}
