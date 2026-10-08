import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { requestPersistentStorage } from './db'
import { seedSampleDecks } from './sampleDecks'
import './index.css'

registerSW({ immediate: true })
requestPersistentStorage()
seedSampleDecks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
