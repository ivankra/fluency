import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addReviews, listCards, listDecks, rebuildSchedules } from './db'
import { demoReviews } from './demoHistory'
import { createFsrs } from './fsrs'
import { createScheduler } from './scheduler'
import {
  DEFAULT_FSRS,
  formatSteps,
  loadSchedulerSettings,
  MAX_INTERVAL_LIMIT,
  parseSteps,
  RETENTION_RANGE,
  saveSchedulerSettings,
  type Algorithm,
  type FsrsOptions,
  type SchedulerSettings,
} from './schedulerSettings'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Rebuild every card's schedule from its history with the given settings.
async function rescheduleAll(settings: SchedulerSettings) {
  const scheduler = await createScheduler(settings)
  return rebuildSchedules((card, reviews) => scheduler.rebuild(card, reviews))
}

// Text fields keep what the user typed; each one is saved once it's valid.
interface Drafts {
  retention: string
  maximumInterval: string
  learningSteps: string
  relearningSteps: string
}

const draftsOf = (fsrs: FsrsOptions): Drafts => ({
  retention: String(fsrs.desiredRetention),
  maximumInterval: String(fsrs.maximumInterval),
  learningSteps: formatSteps(fsrs.learningSteps),
  relearningSteps: formatSteps(fsrs.relearningSteps),
})

// Parses the drafts into options; null for the fields that aren't valid.
function parseDrafts(drafts: Drafts) {
  const retention = Number(drafts.retention)
  const maximumInterval = Number(drafts.maximumInterval)
  return {
    desiredRetention:
      drafts.retention.trim() && retention >= RETENTION_RANGE.min && retention <= RETENTION_RANGE.max ? retention : null,
    maximumInterval:
      Number.isInteger(maximumInterval) && maximumInterval >= 1 && maximumInterval <= MAX_INTERVAL_LIMIT ? maximumInterval : null,
    learningSteps: parseSteps(drafts.learningSteps),
    relearningSteps: parseSteps(drafts.relearningSteps),
  }
}

export default function SchedulingSettings() {
  const [settings, setSettings] = useState(loadSchedulerSettings)
  const [drafts, setDrafts] = useState(() => draftsOf(settings.fsrs))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const parsed = parseDrafts(drafts)

  const switchTo = async (algorithm: Algorithm) => {
    if (algorithm === settings.algorithm || busy) return
    const name = algorithm === 'fsrs' ? 'FSRS' : 'Simple (SM-2)'
    if (!confirm(`Switch to ${name}? Every card is rescheduled from its review history.`)) return
    const next = { ...settings, algorithm }
    setBusy(true)
    setStatus('Rescheduling…')
    try {
      const count = await rescheduleAll(next)
      saveSchedulerSettings(next)
      setSettings(next)
      setStatus(`Switched to ${name}: rescheduled ${count} ${count === 1 ? 'card' : 'cards'}.`)
    } catch (error) {
      setStatus(`Couldn't switch: ${errorText(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // Options apply from each card's next review; nothing is rescheduled.
  const changeFsrs = async (patch: Partial<FsrsOptions>) => {
    const next = { ...settings, fsrs: { ...settings.fsrs, ...patch } }
    try {
      await createFsrs(next.fsrs) // ts-fsrs validates the options
      saveSchedulerSettings(next)
      setSettings(next)
      setStatus('')
    } catch (error) {
      setStatus(`Not saved: ${errorText(error)}`)
    }
  }

  const changeDraft = (field: keyof Drafts, value: string) => {
    const nextDrafts = { ...drafts, [field]: value }
    setDrafts(nextDrafts)
    const fields = parseDrafts(nextDrafts)
    const key = field === 'retention' ? 'desiredRetention' : field
    const parsedValue = fields[key]
    if (parsedValue !== null) changeFsrs({ [key]: parsedValue })
  }

  const resetOptions = () => {
    const { weights } = settings.fsrs
    setDrafts(draftsOf(DEFAULT_FSRS))
    changeFsrs({ ...DEFAULT_FSRS, weights })
  }

  return (
    <section className="panel card-form">
      <h2>Scheduling</h2>
      <p className="muted">How the app decides when each card comes back.</p>
      <fieldset className="choice" disabled={busy}>
        <legend className="muted">Algorithm</legend>
        <label className="checkbox">
          <input type="radio" name="algorithm" checked={settings.algorithm === 'sm2'} onChange={() => switchTo('sm2')} />
          <span>
            <b>Simple (SM-2)</b>: intervals grow by a fixed factor per card. Predictable.
          </span>
        </label>
        <label className="checkbox">
          <input type="radio" name="algorithm" checked={settings.algorithm === 'fsrs'} onChange={() => switchTo('fsrs')} />
          <span>
            <b>FSRS</b>: models how well you remember each card and schedules the next review for the retention you
            choose. Usually fewer reviews for the same retention.
          </span>
        </label>
      </fieldset>

      {settings.algorithm === 'fsrs' && (
        <>
          <label>
            <span>Desired retention</span>
            <input
              type="number"
              inputMode="decimal"
              step={0.01}
              min={RETENTION_RANGE.min}
              max={RETENTION_RANGE.max}
              value={drafts.retention}
              aria-invalid={parsed.desiredRetention === null}
              onChange={(event) => changeDraft('retention', event.target.value)}
            />
          </label>
          <p className="muted">
            The chance of remembering a card when it comes back, {RETENTION_RANGE.min}–{RETENTION_RANGE.max}. Higher
            means more reviews; 0.90 is a good balance.
          </p>
          <label>
            <span>Maximum interval (days)</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_INTERVAL_LIMIT}
              value={drafts.maximumInterval}
              aria-invalid={parsed.maximumInterval === null}
              onChange={(event) => changeDraft('maximumInterval', event.target.value)}
            />
          </label>
          <label>
            <span>Learning steps</span>
            <input
              value={drafts.learningSteps}
              aria-invalid={parsed.learningSteps === null}
              onChange={(event) => changeDraft('learningSteps', event.target.value)}
              placeholder="e.g. 1m 10m"
            />
          </label>
          <label>
            <span>Relearning steps</span>
            <input
              value={drafts.relearningSteps}
              aria-invalid={parsed.relearningSteps === null}
              onChange={(event) => changeDraft('relearningSteps', event.target.value)}
              placeholder="e.g. 10m"
            />
          </label>
          <p className="muted">
            Short waits before a new or forgotten card moves to day-long intervals, like 1m, 10m, 1h or 1d. Leave empty
            for none.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={settings.fsrs.enableFuzz} onChange={(event) => changeFsrs({ enableFuzz: event.target.checked })} />
            <span>Spread out reviews of cards learned together (fuzz)</span>
          </label>
          <p className="muted">
            Parameters: {settings.fsrs.weights ? 'custom' : 'FSRS-6 defaults'}. Changes apply from each card's next
            review.{' '}
            <button type="button" className="btn btn--small" onClick={resetOptions}>
              Reset options
            </button>
          </p>
        </>
      )}
      {status && <p role="status">{status}</p>}
      {import.meta.env.DEV && <DemoHistory settings={settings} />}
    </section>
  )
}

// Development builds only: fill a deck with past reviews to try the schedulers.
function DemoHistory({ settings }: { settings: SchedulerSettings }) {
  const decks = useLiveQuery(listDecks)
  const [deckId, setDeckId] = useState('')
  const [status, setStatus] = useState('')
  const deck = decks?.find((d) => d.id === deckId) ?? decks?.[0]

  const generate = async () => {
    if (!deck || !confirm(`Add 60 days of made-up reviews to every card in "${deck.name}"?`)) return
    try {
      const cards = await listCards(deck.id)
      const reviews = demoReviews(
        cards.map((card) => card.id),
        Date.now(),
      )
      await addReviews(reviews)
      const scheduler = await createScheduler(settings)
      await rebuildSchedules(
        (card, cardReviews) => scheduler.rebuild(card, cardReviews),
        cards.map((card) => card.id),
      )
      setStatus(`Added ${reviews.length} reviews to ${cards.length} cards.`)
    } catch (error) {
      setStatus(errorText(error))
    }
  }

  if (!decks?.length) return null
  return (
    <div className="dev-tools">
      <span className="muted">Developer: demo history</span>
      <div className="inline-form">
        <select value={deck?.id} onChange={(event) => setDeckId(event.target.value)} aria-label="Deck">
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn--small" onClick={generate}>
          Generate
        </button>
      </div>
      {status && <p role="status">{status}</p>}
    </div>
  )
}
