// src/components/upload-config/steps/StepPath.jsx
import { useState } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'

const PATHS = [
  {
    id: 'hands-off',
    badge: 'A · HANDS-OFF',
    title: 'Full Auto',
    subtitle: 'Start now, email when b-roll is ready',
    tone: 'secondary',
    icon: 'rocket_launch',
    flow: [
      { label: 'References analyzed', status: 'auto' },
      { label: 'Strategy proposal',   status: 'auto' },
      { label: 'B-roll plan',         status: 'auto' },
      { label: 'Search & download',   status: 'auto' },
      { label: 'Final review',        status: 'review', checkpoint: true },
    ],
    eta: '~18–24 hrs for a 40-min video',
    note: 'Kick it off and walk away — you review at the end before the cut goes live.',
  },
  {
    id: 'strategy-only',
    badge: 'B · BALANCED',
    title: 'Strategy Review',
    subtitle: 'Confirm the creative strategy, then we run',
    tone: 'tertiary',
    icon: 'center_focus_strong',
    flow: [
      { label: 'References analyzed', status: 'auto' },
      { label: 'Strategy proposal',   status: 'review', checkpoint: true },
      { label: 'B-roll plan',         status: 'auto' },
      { label: 'Search & download',   status: 'auto' },
      { label: 'Final review',        status: 'review', checkpoint: true },
    ],
    eta: '~20–28 hrs for a 40-min video',
    note: "Each checkpoint waits on your login — without it, the next phase won't start.",
    warn: true,
  },
  {
    id: 'guided',
    badge: 'C · FULL CONTROL',
    title: 'Guided Review',
    subtitle: 'Review and confirm at every step',
    tone: 'primary',
    icon: 'account_tree',
    flow: [
      { label: 'References analyzed', status: 'auto' },
      { label: 'Strategy proposal',   status: 'review', checkpoint: true },
      { label: 'B-roll plan',         status: 'review', checkpoint: true },
      { label: 'Search & download',   status: 'auto' },
      { label: 'Final review',        status: 'review', checkpoint: true },
    ],
    eta: '~24–36 hrs for a 40-min video',
    note: "Each checkpoint waits on your login — without it, the next phase won't start.",
    warn: true,
  },
]

function PathCard({ path, active, onSelect }) {
  const [hover, setHover] = useState(false)

  const accent = path.tone === 'primary' ? 'text-lime'
    : path.tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'
  const accentBg = path.tone === 'primary' ? 'bg-lime/12'
    : path.tone === 'tertiary' ? 'bg-teal/12'
    : 'bg-purple-accent/12'
  const checkpointBg = path.tone === 'primary' ? 'bg-lime/5'
    : path.tone === 'tertiary' ? 'bg-teal/5'
    : 'bg-purple-accent/5'
  const ringClass = path.tone === 'primary'
    ? 'ring-lime shadow-[0_0_28px_rgba(206,252,0,0.10)]'
    : path.tone === 'tertiary'
      ? 'ring-teal shadow-[0_0_28px_rgba(45,212,191,0.10)]'
      : 'ring-purple-accent shadow-[0_0_28px_rgba(193,128,255,0.14)]'

  return (
    <div
      onClick={() => onSelect(path.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'rounded-[14px] p-[22px] cursor-pointer flex flex-col gap-4 transition-all relative',
        active
          ? `bg-surface-container-high ring-[1.5px] ring-inset ${ringClass}`
          : hover
            ? 'bg-surface-container-highest ring-1 ring-inset ring-border-subtle/10'
            : 'bg-surface-container-low ring-1 ring-inset ring-border-subtle/10',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2.5 min-w-0 flex-1">
          <span className={`text-[9px] font-extrabold tracking-[0.22em] uppercase font-['Inter'] ${accent}`}>
            {path.badge}
          </span>
          <div className="text-lg font-bold text-on-surface leading-[1.15] tracking-tight font-['Inter']">
            {path.title}
          </div>
          <div className="text-xs text-on-surface-variant font-['Inter'] leading-[1.4]">
            {path.subtitle}
          </div>
        </div>
        <div className={[
          'w-11 h-11 rounded-[10px] shrink-0 flex items-center justify-center',
          active ? `${accentBg} ${accent}` : 'bg-surface-container-high text-on-surface-variant',
        ].join(' ')}>
          <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: `"FILL" ${active ? 1 : 0}` }}>
            {path.icon}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 mt-1">
        {path.flow.map((f, i) => (
          <div key={i} className={[
            'flex items-center gap-2.5 px-2.5 py-[7px] rounded-md',
            f.checkpoint ? checkpointBg : 'bg-transparent',
          ].join(' ')}>
            <div className={[
              'w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center',
              f.status === 'review'
                ? (path.tone === 'primary' ? 'bg-lime text-on-primary-container'
                  : path.tone === 'tertiary' ? 'bg-teal text-[#00201c]'
                  : 'bg-purple-accent text-[#33005b]')
                : 'bg-surface-container-high text-on-surface-variant',
            ].join(' ')}>
              <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: '"wght" 700' }}>
                {f.status === 'review' ? 'visibility' : 'auto_mode'}
              </span>
            </div>
            <span className={[
              'flex-1 text-[11px] font-["Inter"]',
              f.checkpoint ? 'text-on-surface font-semibold' : 'text-on-surface-variant font-medium',
            ].join(' ')}>
              {f.label}
            </span>
            {f.checkpoint && (
              <span className={`text-[9px] font-bold uppercase tracking-[0.15em] font-['Inter'] ${accent}`}>
                You review
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-auto pt-3.5 ring-[0.5px] ring-inset ring-white/3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[13px] text-muted">schedule</span>
          <span className="text-[11px] text-on-surface-variant font-mono tabular-nums">{path.eta}</span>
        </div>
        <p className={[
          'text-[11px] leading-[1.5] m-0 font-["Inter"]',
          path.warn ? 'text-orange-400' : 'text-muted',
        ].join(' ')}>
          {path.warn && (
            <span className="material-symbols-outlined text-[12px] align-middle mr-1.5" style={{ fontVariationSettings: '"FILL" 1' }}>warning</span>
          )}
          {path.note}
        </p>
      </div>
    </div>
  )
}

export default function StepPath({ state, setState }) {
  return (
    <div>
      <div className="mb-6">
        <Eyebrow icon="fork_right" tone="secondary">Automation · Step 5 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="How hands-on" line2="do you want to be?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[720px] leading-[1.6]">
          B-roll search is long-running — for a 40-minute video, expect somewhere between 18 and 36 hours end-to-end.
          Pick how many review checkpoints you want along the way.{' '}
          <span className="text-on-surface font-semibold">You must be logged in to confirm each checkpoint, or we pause.</span>
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3.5 mb-4">
        {PATHS.map(p => (
          <PathCard key={p.id} path={p} active={state.pathId === p.id} onSelect={setState.pathId} />
        ))}
      </div>

      <div className="px-[18px] py-3.5 rounded-[10px] bg-orange-500/5 ring-1 ring-inset ring-orange-500/20 flex items-start gap-3">
        <span className="material-symbols-outlined text-[18px] text-orange-400 shrink-0 mt-px" style={{ fontVariationSettings: '"FILL" 1' }}>report</span>
        <div className="text-xs text-on-surface-variant leading-[1.6] font-['Inter']">
          <span className="text-orange-400 font-bold uppercase tracking-[0.12em] text-[10px] mr-2">Important</span>
          Every path ends with a final review after search & download.
          Mid-run checkpoints may wait 15–20 minutes for analysis before asking you —
          we'll email and notify when your input is needed. You can switch paths mid-run from the project dashboard.
        </div>
      </div>
    </div>
  )
}
