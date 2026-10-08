import { useState, type FormEvent } from 'react'

interface Props {
  initialFront?: string
  initialBack?: string
  submitLabel: string
  onSubmit: (front: string, back: string) => Promise<unknown>
  onCancel?: () => void
}

// Used both to add a new card and to edit an existing one.
export default function CardForm({ initialFront = '', initialBack = '', submitLabel, onSubmit, onCancel }: Props) {
  const [front, setFront] = useState(initialFront)
  const [back, setBack] = useState(initialBack)
  const valid = front.trim() !== '' && back.trim() !== ''

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    await onSubmit(front.trim(), back.trim())
    // Reset only when adding; when editing the form is unmounted.
    if (!onCancel) {
      setFront('')
      setBack('')
    }
  }

  return (
    <form className="card-form" onSubmit={submit}>
      <label>
        <span>Front (your language)</span>
        <textarea value={front} onChange={(e) => setFront(e.target.value)} rows={2} />
      </label>
      <label>
        <span>Back (target language)</span>
        <textarea value={back} onChange={(e) => setBack(e.target.value)} rows={2} />
      </label>
      <div className="card-form__actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn--primary" disabled={!valid}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
