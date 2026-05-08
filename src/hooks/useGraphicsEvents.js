import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const BASE = import.meta.env.VITE_API_URL || '/api'

const NAMED_EVENTS = [
  'brief_thinking',
  'brief_replied',
  'render_queued',
  'render_started',
  'frames_captured',
  'critic_scored',
  'retry_triggered',
  'render_finished',
  'render_complete',
]

export function useGraphicsEvents(sessionId) {
  const [events, setEvents] = useState([])

  useEffect(() => {
    if (!sessionId) return undefined
    let es
    let cancelled = false

    async function open() {
      const { data } = (await supabase?.auth.getSession()) || {}
      const token = data?.session?.access_token
      const url = `${BASE}/graphics/sessions/${sessionId}/events${
        token ? `?token=${encodeURIComponent(token)}` : ''
      }`
      if (cancelled) return
      es = new EventSource(url)

      const handler = (ev) => {
        try {
          const event = JSON.parse(ev.data)
          setEvents((prev) => [...prev, event])
        } catch {}
      }
      es.onmessage = handler
      NAMED_EVENTS.forEach((step) => es.addEventListener(step, handler))
      es.onerror = () => {
        es?.close()
      }
    }
    open()

    return () => {
      cancelled = true
      es?.close()
    }
  }, [sessionId])

  // Reset events when session changes
  useEffect(() => {
    setEvents([])
  }, [sessionId])

  return events
}
