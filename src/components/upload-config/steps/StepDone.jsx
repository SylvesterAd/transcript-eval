// src/components/upload-config/steps/StepDone.jsx
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'

function SummaryRow({ label, value, tone }) {
  const color = tone === 'primary' ? 'text-lime'
    : tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'
  return (
    <div className="flex items-baseline gap-4">
      <span className={`text-[9px] font-extrabold tracking-[0.2em] uppercase font-['Inter'] min-w-[130px] shrink-0 ${color}`}>
        {label}
      </span>
      <span className="text-xs text-on-surface font-['Inter'] leading-[1.5]">{value}</span>
    </div>
  )
}

function summarizeLibs(libs, freepik) {
  if (!libs || !libs.length) return `Pexels${freepik ? ' + Freepik ($0.05/clip, confirmed)' : ' only'}`
  const map = { envato: 'Envato', artlist: 'Artlist', storyblocks: 'Storyblocks' }
  return libs.map(l => map[l] || l).join(' · ')
}

function summarizeAudience(a) {
  if (!a) return 'No signals yet'
  const parts = []
  if (a.age?.length) parts.push(`${a.age.length} age group${a.age.length > 1 ? 's' : ''}`)
  if (a.sex?.length) parts.push(a.sex.join('/'))
  if (a.language) parts.push(a.language)
  return parts.length ? parts.join(' · ') : 'No signals yet'
}

function summarizePath(id) {
  return ({
    'guided':        'C · Guided Review',
    'strategy-only': 'B · Strategy Review',
    'hands-off':     'A · Full Auto',
  }[id]) || '—'
}

export default function StepDone({ state, onEdit, onComplete }) {
  return (
    <div className="text-center py-5">
      <div className="w-[88px] h-[88px] rounded-full mx-auto mb-6 bg-lime/10 flex items-center justify-center text-lime ring-[1.5px] ring-inset ring-lime/35 shadow-[0_0_48px_rgba(206,252,0,0.25)]">
        <span className="material-symbols-outlined text-[44px]" style={{ fontVariationSettings: '"wght" 700' }}>check</span>
      </div>
      <Eyebrow tone="primary" icon="check_circle">Configuration Saved</Eyebrow>
      <div className="mt-4">
        <PageTitle line1="Ready for" line2="calibration" accentTone="primary" size={26} />
      </div>
      <p className="mt-3 text-on-surface-variant text-[13px] max-w-[520px] leading-[1.6] mx-auto">
        Your preferences are saved to this project. Uploading video now — the Kinetic Engine will start
        analyzing as soon as encoding completes.
      </p>

      <div className="mt-7 inline-flex flex-col gap-2.5 p-5 rounded-xl bg-surface-container-low ring-1 ring-inset ring-border-subtle/12 text-left min-w-[420px]">
        <SummaryRow label="B-Roll Sources"   value={summarizeLibs(state.libraries, state.freepikOptIn)} tone="tertiary" />
        <SummaryRow label="Target Audience"  value={summarizeAudience(state.audience)} tone="secondary" />
        <SummaryRow label="Path"             value={summarizePath(state.pathId)} tone="primary" />
      </div>

      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-2 text-on-surface-variant font-bold text-xs uppercase tracking-widest px-4 py-2 hover:text-on-surface transition-colors"
        >
          <span className="material-symbols-outlined text-sm">edit</span>
          Edit Config
        </button>
        <button
          type="button"
          onClick={() => onComplete()}
          className="inline-flex items-center gap-2.5 bg-gradient-to-br from-lime to-primary-dim text-on-primary-container font-extrabold text-xs uppercase tracking-[0.15em] px-7 py-3.5 rounded-md shadow-[0_0_32px_rgba(206,252,0,0.25)] hover:shadow-[0_0_48px_rgba(206,252,0,0.45)] active:scale-95 transition-all"
        >
          <span className="material-symbols-outlined text-sm">play_arrow</span>
          Proceed to Editor
          <span className="material-symbols-outlined text-sm">arrow_forward</span>
        </button>
      </div>
    </div>
  )
}
