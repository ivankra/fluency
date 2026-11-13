// JSON values in localStorage. It can be unavailable or throw (private mode), so
// failures read as "nothing stored" and writes are best effort.

export function readStored(key: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function writeStored(key: string, value: object | null) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  } catch {
    // Not persisted; in-memory state still applies.
  }
}
