// Build-time variables (Vite exposes those prefixed with VITE_).
interface ImportMetaEnv {
  // OAuth client ID for Google Drive sync; unset means no sync UI. See doc/drive-sync.md.
  readonly VITE_GOOGLE_CLIENT_ID?: string
}
