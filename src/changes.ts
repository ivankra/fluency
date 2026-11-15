// Counts local changes to the database, so Drive sync knows whether there is anything
// to upload, and lets it schedule itself after an edit. db.ts calls noteChange after
// every user write; sync's own writes don't count.
const KEY = 'fluency:changes'

// Kept in memory too, so counting works within a session even if localStorage doesn't.
let count = (() => {
  try {
    return Number(localStorage.getItem(KEY)) || 0
  } catch {
    return 0
  }
})()

const listeners = new Set<() => void>()

export const changeCount = () => count

export function noteChange() {
  count++
  try {
    localStorage.setItem(KEY, String(count))
  } catch {
    // Only this session knows; sync then merges fully after a restart.
  }
  for (const listener of listeners) listener()
}

export function onChange(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
