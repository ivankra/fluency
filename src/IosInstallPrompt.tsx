import { useEffect, useState } from 'react'

const DISMISSED_KEY = 'fluency:ios-install-dismissed'

// iOS has no `beforeinstallprompt` event, so the only way to install is
// Share → Add to Home Screen. We show instructions to Safari users instead.
function shouldShowPrompt(): boolean {
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac, so also check for touch support.
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  // Other iOS browsers (Chrome, Firefox, Edge, etc.) tag their UA.
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo/.test(ua)
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true

  let dismissed = false
  try {
    dismissed = localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    // Storage may be unavailable (e.g. private browsing); just show the prompt.
  }

  return isIos && isSafari && !isStandalone && !dismissed
}

function ShareIcon() {
  return (
    <svg
      className="ios-install__share"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Share"
    >
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" />
    </svg>
  )
}

export default function IosInstallPrompt() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(shouldShowPrompt())
  }, [])

  if (!visible) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Ignore; the prompt just won't be remembered as dismissed.
    }
    setVisible(false)
  }

  return (
    <div className="ios-install" role="dialog" aria-label="Install Fluency">
      <img className="ios-install__icon" src="/apple-touch-icon.png" alt="" />
      <div className="ios-install__text">
        <strong>Install Fluency</strong>
        <span>
          Tap <ShareIcon /> then <b>Add to Home Screen</b>.
        </span>
      </div>
      <button className="ios-install__close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
