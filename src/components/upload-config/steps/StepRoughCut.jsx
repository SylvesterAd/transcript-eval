import { useEffect, useState, useRef } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'
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

function TargetCard({ target }) {
  return (
    <div className="rounded-[10px] bg-surface-container-low/55 ring-1 ring-inset ring-border-subtle/10 px-4 py-[14px] flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-purple-accent/10 text-purple-accent flex items-center justify-center shrink-0">
        <span className="material-symbols-outlined text-base">{target.icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-xs text-on-surface mb-1.5 font-['Inter']">{target.label}</div>
        <div className="flex flex-wrap gap-1">
          {target.examples.map((e, i) => (
            <span key={i} className="text-[10px] px-2 py-[3px] rounded bg-error/8 text-error/90 ring-1 ring-inset ring-error/15 font-mono line-through">
              {e}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function TranscriptPreview() {
  return (
    <div className="grid grid-cols-2 gap-3.5 mt-1">
      <div className="p-[18px] rounded-[10px] bg-black/40 ring-1 ring-inset ring-border-subtle/15">
        <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant mb-2.5 font-['Inter']">Before</div>
        <p className="m-0 text-on-surface-variant text-xs leading-[1.65] font-['Inter']">
          "So, um, I was thinking about the project [pause] and I think we should, like, start with the intro. Um, let's look at the data first."
        </p>
        <p className="mt-2.5 text-on-surface-variant text-xs leading-[1.65] font-['Inter']">
          "Actually, wait, let me rephrase that. The data is the most important part of this whole sequence."
        </p>
      </div>
      <div className="p-[18px] rounded-[10px] bg-purple-accent/6 ring-1 ring-inset ring-purple-accent/20">
        <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-purple-accent mb-2.5 font-['Inter']">After · Rough Cut</div>
        <p className="m-0 text-on-surface text-xs leading-[1.65] font-['Inter']">
          "<span className="text-error line-through">So, um, I was thinking about the project [pause] and I think we should, like,</span> Start with the intro." <span className="text-error line-through">Um, let's look at the data first.</span>
        </p>
        <p className="mt-2.5 text-on-surface text-xs leading-[1.65] font-['Inter']">
          <span className="text-error line-through">"Actually, wait, let me rephrase that.</span> "The data is the most important part of this whole sequence."
        </p>
      </div>
    </div>
  )
}

export default function StepRoughCut({ groupId, state, setState, onValidityChange, onEstimate }) {
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
          onEstimate?.(data)
          if (data.tokenCost > 0) { setPolling(false); return }
        }
        pollAttempts.current++
        const delay = pollAttempts.current < 60 ? 1000 : 3000
        await new Promise(r => setTimeout(r, delay))
      }
    }
    loop()
    return () => { cancelled = true }
  }, [groupId, onEstimate])

  // Validity gates the Run button in the footer when balance is short.
  // Skip is always allowed.
  useEffect(() => {
    if (!onValidityChange) return
    if (!state.autoRoughCut) { onValidityChange(true); return }
    if (!estimate || estimate.tokenCost === 0) { onValidityChange(true); return }
    onValidityChange(estimate.balance >= estimate.tokenCost)
  }, [state.autoRoughCut, estimate, onValidityChange])

  const insufficient = state.autoRoughCut && estimate && estimate.tokenCost > 0 && estimate.balance < estimate.tokenCost

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="content_cut" tone="secondary">AI Rough Cut · Step 5 of 7</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="Want a clean transcript" line2="before we plan b-roll?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[720px] leading-[1.6]">
          Rough Cut runs an AI pass over the transcript and removes the throwaway bits — filler words, false starts,
          and director commentary — before any b-roll work begins. Skip it and the transcript goes through untouched.
        </p>
      </div>

      <div className="mb-[22px]">
        <div className="text-[10px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant mb-2.5 font-['Inter']">
          What gets removed
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {TARGETS.map(t => <TargetCard key={t.id} target={t} />)}
        </div>
      </div>

      <div className="mb-[22px]">
        <div className="text-[10px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant mb-2.5 font-['Inter']">
          Sample · before / after
        </div>
        <TranscriptPreview />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="px-4 py-[14px] rounded-[10px] bg-surface-container-low/55 ring-1 ring-inset ring-border-subtle/10 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-lime/10 text-lime flex items-center justify-center">
            <span className="material-symbols-outlined text-base">schedule</span>
          </div>
          <div>
            <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant font-['Inter']">Estimated time</div>
            <div className="text-lg font-extrabold text-on-surface mt-0.5 font-['Inter']">
              {polling && !estimate?.tokenCost ? 'Calculating…' : formatTime(estimate?.estimatedTimeSeconds)}
            </div>
          </div>
        </div>
        <div className="px-4 py-[14px] rounded-[10px] bg-surface-container-low/55 ring-1 ring-inset ring-border-subtle/10 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-accent/10 text-purple-accent flex items-center justify-center">
            <span className="material-symbols-outlined text-base">deployed_code</span>
          </div>
          <div>
            <div className="text-[9px] font-extrabold tracking-[0.22em] uppercase text-on-surface-variant font-['Inter']">Token usage</div>
            <div className="text-lg font-extrabold text-on-surface mt-0.5 font-['Inter']">
              {polling && !estimate?.tokenCost ? 'Calculating…' : `~${formatTokens(estimate?.tokenCost)} tokens`}
            </div>
          </div>
        </div>
      </div>

      {insufficient && (
        <div className="mt-4 rounded-lg ring-1 ring-inset ring-error/30 bg-error/5 px-4 py-3 text-sm text-error">
          Not enough tokens. You have <strong>{formatTokens(estimate.balance)}</strong>, this needs <strong>{formatTokens(estimate.tokenCost)}</strong>. Top up your balance or pick "No, thanks" to skip.
        </div>
      )}
    </div>
  )
}
