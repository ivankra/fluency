import { useEffect, useRef, useState } from 'react'
import { languageName } from './languages'
import { canSpeak, hasVoice, isAbort, speak } from './speech'

interface Props {
  text: string
  lang: string | undefined // BCP 47; hidden without one
  rate?: number
  onError: (message: string) => void
}

// Reads `text` aloud; tapping again stops. Playback also stops when the text changes
// or the button goes away (e.g. the next card).
export default function SpeakButton({ text, lang, rate = 1, onError }: Props) {
  const [playing, setPlaying] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [text, lang])
  if (!lang || !text.trim() || !canSpeak()) return null

  const available = hasVoice(lang)
  const toggle = () => {
    if (controller.current) return controller.current.abort()
    const current = new AbortController()
    controller.current = current
    setPlaying(true)
    speak(text, lang, { rate, signal: current.signal })
      .catch((error) => !isAbort(error) && onError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        if (controller.current === current) controller.current = null
        setPlaying(false)
      })
  }

  const label = !available ? `No ${languageName(lang)} voice on this device` : playing ? 'Stop reading' : 'Read aloud'
  return (
    <button type="button" className="btn btn--icon" onClick={toggle} disabled={!available} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
        {playing ? (
          <rect x="6" y="6" width="12" height="12" rx="1" />
        ) : (
          <path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
        )}
      </svg>
    </button>
  )
}
