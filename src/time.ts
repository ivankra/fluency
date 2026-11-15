export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

// A wait as a short label: "10m", "5h", "3d", "2.5mo", "1.2y".
export function formatInterval(ms: number): string {
  const days = ms / DAY
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${+(days / 30).toFixed(1)}mo`
  return `${+(days / 365).toFixed(1)}y`
}

// How long ago, for "Last synced 3 min ago".
export function formatAgo(ms: number): string {
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min ago`
  if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`
  return `${Math.round(ms / DAY)} d ago`
}
