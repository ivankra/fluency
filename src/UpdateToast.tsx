import { useRegisterSW } from 'virtual:pwa-register/react'

const UPDATE_CHECK_MS = 60 * 60 * 1000

// Tells the user when the app is ready for offline use or a new version is waiting.
export default function UpdateToast() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    // An installed PWA can stay open for days; the browser only checks for a new
    // service worker on navigation, so poll as well.
    onRegisteredSW: (_url, registration) => {
      if (registration) setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS)
    },
  })

  if (!needRefresh && !offlineReady) return null

  return (
    <div className="toast" role="status">
      <span className="toast__text">
        {needRefresh ? 'A new version is available.' : 'Ready to use offline.'}
      </span>
      {needRefresh ? (
        <>
          <button className="btn btn--small" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
          <button className="btn btn--small btn--primary" onClick={() => updateServiceWorker(true)}>
            Reload
          </button>
        </>
      ) : (
        <button className="btn btn--small" onClick={() => setOfflineReady(false)}>
          OK
        </button>
      )}
    </div>
  )
}
