// Polls Supabase broll_jobs for newly-failed rows every 30s and fires
// Slack alerts. GPU work runs externally, so this is our only hook.

import { createClient } from '@supabase/supabase-js'
import { notify } from './slack-notifier.js'

const POLL_INTERVAL_MS = 30_000
const DEDUPE_CAP = 1000

const seenJobIds = new Set()
let lastPollTs = null

export function startGpuFailurePoller() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    console.warn('[gpu-failure-poller] SUPABASE_URL/SUPABASE_SECRET_KEY missing, poller disabled')
    return
  }
  const supabase = createClient(url, key)
  lastPollTs = new Date().toISOString()

  const tick = async () => {
    try {
      const { data, error } = await supabase
        .from('broll_jobs')
        .select('id, error, instance_id, request, updated_at')
        .eq('status', 'failed')
        .gte('updated_at', lastPollTs)
        .order('updated_at', { ascending: true })
        .limit(100)

      if (error) {
        console.warn('[gpu-failure-poller] Supabase query failed:', error.message)
        return
      }

      for (const row of (data || [])) {
        if (seenJobIds.has(row.id)) continue
        seenJobIds.add(row.id)
        if (seenJobIds.size > DEDUPE_CAP) {
          const first = seenJobIds.values().next().value
          seenJobIds.delete(first)
        }
        notify({
          source: 'gpu',
          title: 'GPU job failed',
          error: row.error,
          meta: {
            jobId: row.id,
            instanceId: row.instance_id,
            brief: row.request?.brief || null,
          },
        })
      }

      if (data && data.length > 0) {
        lastPollTs = data[data.length - 1].updated_at
      }
    } catch (err) {
      console.warn('[gpu-failure-poller] Tick failed:', err.message)
    }
  }

  setInterval(tick, POLL_INTERVAL_MS)
  console.log('[gpu-failure-poller] Started (30s interval)')
}
