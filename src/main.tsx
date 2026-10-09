import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { requestPersistentStorage } from './db'
import { seedSampleDecks } from './sampleDecks'
import './index.css'

requestPersistentStorage()
seedSampleDecks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
