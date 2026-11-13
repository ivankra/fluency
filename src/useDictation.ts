import { useEffect, useRef, useState } from 'react'
import type { Session, Slot } from './check'
import { isAbort, joinTranscript, listen, type Listening } from './speech'

// Dictating the answer of the current card: the transcript is appended to the answer,
// which stays editable. Discarded if the card changes or is revealed meanwhile.
export function useDictation(session: Session, slot: Slot | undefined, lang: string | undefined, onError: (message: string) => void) {
  const [interim, setInterim] = useState<string | null>(null) // null while not dictating
  const running = useRef<{ controller: AbortController; listening: Listening } | null>(null)

  const cancel = () => running.current?.controller.abort()
  useEffect(() => cancel, [slot?.key, slot?.revealed])

  const start = () => {
    if (!slot || !lang || running.current) return
    const key = slot.key
    const controller = new AbortController()
    const listening = listen({ lang, signal: controller.signal, onInterim: setInterim })
    running.current = { controller, listening }
    setInterim('')
    listening.result
      .then(
        ({ text }) => {
          const current = session.current
          if (text && current?.key === key) session.setAnswer(joinTranscript([current.answer, text], lang), 'spoken', key)
        },
        (error) => !isAbort(error) && onError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        if (running.current?.controller !== controller) return
        running.current = null
        setInterim(null)
      })
  }

  return {
    dictating: interim !== null,
    interim: interim ?? '',
    start,
    finish: () => running.current?.listening.finish(), // stop listening, keep what was heard
    cancel,
  }
}
