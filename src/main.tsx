import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { requestPersistentStorage } from './db'
import { startDriveSync } from './driveSync'
import { seedSampleDecks } from './sampleDecks'
import './index.css'

requestPersistentStorage()
startDriveSync()
seedSampleDecks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
