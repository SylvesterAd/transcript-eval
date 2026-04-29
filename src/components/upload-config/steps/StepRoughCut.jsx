import { useEffect, useState, useRef } from 'react'
import { supabase } from '../../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

const TARGETS = [
  { id: 'filler',   label: 'Filler words',    icon: 'speaker_notes_off',
    examples: ['um', 'uh', 'like', 'you know', 'sort of', 'I mean'] },
  { id: 'restarts', label: 'False starts',    icon: 'restart_alt',
    examples: ['"Actually, wait — let me rephrase…"', '"So, um, what I meant was…"'] },
  { id: 'meta',     label: 'Meta commentary', icon: 'chat_bubble_outline',
    examples: ['"Can you cut that?"', '"Let\'s redo that take."', '"[pause]"'] },
]

async function authHeaders() {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return headers
}

function formatTokens(n) {
  return n?.toLocaleString() ?? '—'
}

function formatTime(s) {
  if (!s) return '—'
  if (s < 60) return `~${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return sec === 0 ? `~${m}m` : `~${m}m ${sec}s`
}

export default function StepRoughCut({ groupId, state, setState, onValidityChange }) {
  const [estimate, setEstimate] = useState(null)
  const [polling, setPolling] = useState(false)
  const pollAttempts = useRef(0)

  useEffect(() => {
    if (!groupId) return
    let cancelled = false
    async function fetchEstimate() {
      try {
        const headers = await authHeaders()
        const res = await fetch(`${API_BASE}/videos/groups/${groupId}/estimate-ai-roughcut`, { method: 'POST', headers })
        if (!res.ok) return null
        return await res.json()
      } catch { return null }
    }
    async function loop() {
      setPolling(true)
      while (!cancelled) {
        const data = await fetchEstimate()
        if (cancelled) return
        if (data) {
          setEstimate(data)
          if (data.tokenCost > 0) { setPolling(false); return }
        }
        pollAttempts.current++
        const delay = pollAttempts.current < 60 ? 1000 : 3000
        await new Promise(r => setTimeout(r, delay))
      }
    }
    loop()
    return () => { cancelled = true }
  }, [groupId])

  useEffect(() => {
    if (!onValidityChange) return
    if (!state.autoRoughCut) { onValidityChange(true); return }
    if (!estimate || estimate.tokenCost === 0) { onValidityChange(true); return }
    onValidityChange(estimate.balance >= estimate.tokenCost)
  }, [state.autoRoughCut, estimate, onValidityChange])

  const insufficient = state.autoRoughCut && estimate && estimate.tokenCost > 0 && estimate.balance < estimate.tokenCost

  return (
    <div>
      <div className="mb-6">
        <div className="text-[10px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary text-base">content_cut</span>
          AI Rough Cut · Step 5 of 7
        </div>
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface mt-3">
          Want a clean transcript before we plan b-roll?
        </h1>
        <p className="text-on-surface-variant text-sm mt-3 max-w-[720px] leading-relaxed">
          Rough Cut runs an AI pass over the transcript and removes the throwaway bits —
          filler words, false starts, and director commentary — before any b-roll work begins.
          Skip it and the transcript goes through untouched.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <label className={`p-4 rounded-lg border cursor-pointer transition-all ${!state.autoRoughCut ? 'border-primary-fixed bg-primary-fixed/5' : 'border-outline-variant/20 hover:border-outline-variant/40'}`}>
          <input
            type="radio"
            name="rough-cut-mode"
            checked={!state.autoRoughCut}
            onChange={() => setState.autoRoughCut(false)}
            className="sr-only"
            aria-label="Skip"
          />
          <div className="font-bold text-sm text-on-surface">Skip</div>
          <div className="text-xs text-on-surface-variant mt-1">Use the raw transcript as-is.</div>
        </label>

        <label className={`p-4 rounded-lg border cursor-pointer transition-all ${state.autoRoughCut ? 'border-secondary bg-secondary/5' : 'border-outline-variant/20 hover:border-outline-variant/40'}`}>
          <input
            type="radio"
            name="rough-cut-mode"
            checked={!!state.autoRoughCut}
            onChange={() => setState.autoRoughCut(true)}
            className="sr-only"
            aria-label="Run"
          />
          <div className="font-bold text-sm text-on-surface">Run Rough Cut</div>
          <div className="text-xs text-on-surface-variant mt-1">
            ~{formatTokens(estimate?.tokenCost)} tokens · {formatTime(estimate?.estimatedTimeSeconds)}
          </div>
        </label>
      </div>

      {insufficient && (
        <div className="mb-6 rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
          Not enough tokens. You have <strong>{formatTokens(estimate.balance)}</strong>, this needs <strong>{formatTokens(estimate.tokenCost)}</strong>. Top up your balance or pick Skip to continue.
        </div>
      )}

      <div className="mb-6">
        <div className="text-[10px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant mb-3">
          What gets removed
        </div>
        <div className="grid grid-cols-3 gap-3">
          {TARGETS.map(t => (
            <div key={t.id} className="rounded-lg border border-outline-variant/10 bg-surface-container-low/50 p-4 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-base">{t.icon}</span>
              </div>
              <div className="min-w-0">
                <div className="font-bold text-xs text-on-surface mb-2">{t.label}</div>
                <div className="flex flex-wrap gap-1">
                  {t.examples.map((e, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded border border-error/15 bg-error/5 text-error/80 line-through font-mono">
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-outline-variant/10 bg-surface-container-low/50 p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary-fixed/10 text-primary-fixed flex items-center justify-center"><span className="material-symbols-outlined text-base">schedule</span></div>
          <div>
            <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant">Estimated time</div>
            <div className="text-lg font-extrabold text-on-surface mt-0.5">{polling && !estimate?.tokenCost ? 'Calculating...' : formatTime(estimate?.estimatedTimeSeconds)}</div>
          </div>
        </div>
        <div className="rounded-lg border border-outline-variant/10 bg-surface-container-low/50 p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center"><span className="material-symbols-outlined text-base">deployed_code</span></div>
          <div>
            <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant">Token usage</div>
            <div className="text-lg font-extrabold text-on-surface mt-0.5">{polling && !estimate?.tokenCost ? 'Calculating...' : `~${formatTokens(estimate?.tokenCost)} tokens`}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
