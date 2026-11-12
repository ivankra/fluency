import { useState } from 'react'
import { COMMON_LANGUAGES, canonicalLanguage, languageName } from './languages'

const OTHER = '__other'

interface Props {
  value: string // BCP 47 tag, or '' for none
  onChange: (tag: string) => void // '' while "Other…" holds no valid tag
  label: string
}

// Common languages by name, plus "Other…" for any valid tag. While the typed tag is
// invalid the value is '', so the form can't save a language other than the one shown.
export default function LanguagePicker({ value, onChange, label }: Props) {
  const [other, setOther] = useState<string | null>(null)
  const tags = [...new Set([...COMMON_LANGUAGES, ...(value ? [value] : [])])]
    .map((tag) => ({ tag, name: languageName(tag) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const valid = other === null || canonicalLanguage(other) !== null

  return (
    <>
      <select
        value={other !== null ? OTHER : value}
        aria-label={label}
        onChange={(event) => {
          if (event.target.value === OTHER) {
            setOther('')
            onChange('')
            return
          }
          setOther(null)
          onChange(event.target.value)
        }}
      >
        {!value && <option value="">Choose…</option>}
        {tags.map(({ tag, name }) => (
          <option key={tag} value={tag}>
            {name}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {other !== null && (
        <input
          value={other}
          aria-label={`${label}: language code`}
          aria-invalid={!valid}
          placeholder="Language code, e.g. pt-BR"
          autoCapitalize="off"
          onChange={(event) => {
            setOther(event.target.value)
            onChange(canonicalLanguage(event.target.value) ?? '')
          }}
        />
      )}
    </>
  )
}
