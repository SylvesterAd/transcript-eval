// src/components/upload-config/primitives/CheckPill.jsx
import { useState } from 'react'

export default function CheckPill({ label, icon, checked, onChange, tone = 'primary' }) {
  const [hover, setHover] = useState(false)

  const accentClass =
    tone === 'primary' ? 'text-lime'
    : tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'

  const ringClass =
    tone === 'primary' ? 'ring-lime shadow-[0_0_14px_rgba(206,252,0,0.18)]'
    : tone === 'tertiary' ? 'ring-teal shadow-[0_0_14px_rgba(45,212,191,0.18)]'
    : 'ring-purple-accent shadow-[0_0_14px_rgba(193,128,255,0.18)]'

  const bgChecked =
    tone === 'primary' ? 'bg-lime/10'
    : tone === 'tertiary' ? 'bg-teal/10'
    : 'bg-purple-accent/10'

  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'inline-flex items-center gap-2 px-4 py-2.5 rounded-full font-[\'Inter\']',
        'text-[11px] font-bold uppercase tracking-[0.12em] transition-all',
        'cursor-pointer border-none',
        checked
          ? `${bgChecked} ${accentClass} ring-[1.5px] ring-inset ${ringClass}`
          : hover
            ? 'bg-surface-container-highest text-on-surface ring-1 ring-inset ring-border-subtle/15'
            : 'bg-surface-container-low text-on-surface ring-1 ring-inset ring-border-subtle/15',
      ].join(' ')}
    >
      {icon && (
        <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: `"FILL" ${checked ? 1 : 0}` }}>
          {icon}
        </span>
      )}
      {label}
      {checked && (
        <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: '"wght" 700' }}>
          check
        </span>
      )}
    </button>
  )
}
