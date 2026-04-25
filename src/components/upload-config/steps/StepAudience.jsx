// src/components/upload-config/steps/StepAudience.jsx
import { useEffect, useRef, useState } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'
import FieldCard from '../primitives/FieldCard.jsx'
import CheckPill from '../primitives/CheckPill.jsx'

const AGE_GROUPS = [
  { id: 'gen_alpha',  label: 'Gen Alpha',  hint: '< 13' },
  { id: 'teens',      label: 'Teens',      hint: '13–17' },
  { id: 'gen_z',      label: 'Gen Z',      hint: '18–24' },
  { id: 'millennial', label: 'Millennial', hint: '25–40' },
  { id: 'gen_x',      label: 'Gen X',      hint: '41–56' },
  { id: 'boomer',     label: 'Boomers',    hint: '57+' },
]

const SEX = [
  { id: 'any',       label: 'Any' },
  { id: 'female',    label: 'Female' },
  { id: 'male',      label: 'Male' },
  { id: 'nonbinary', label: 'Non-binary' },
]

const ETHNICITY = [
  { id: 'any',        label: 'Any / mixed' },
  { id: 'white',      label: 'White' },
  { id: 'black',      label: 'Black' },
  { id: 'hispanic',   label: 'Hispanic / Latino' },
  { id: 'asian_ea',   label: 'East Asian' },
  { id: 'asian_sa',   label: 'South Asian' },
  { id: 'mena',       label: 'MENA' },
  { id: 'indigenous', label: 'Indigenous' },
  { id: 'pacific',    label: 'Pacific Islander' },
]

const LANGUAGES = [
  'English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian',
  'Mandarin', 'Japanese', 'Korean', 'Hindi', 'Arabic', 'Russian',
]

function LanguageSelect({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={[
          'w-full bg-surface-container-high rounded-md px-3.5 py-3 text-[13px] font-["Inter"] cursor-pointer',
          'flex items-center justify-between text-left transition-colors',
          value ? 'text-on-surface' : 'text-muted',
          open ? 'ring-1 ring-inset ring-lime/50' : 'ring-1 ring-inset ring-border-subtle/15',
        ].join(' ')}
      >
        <span>{value || 'Choose language…'}</span>
        <span className="material-symbols-outlined text-[18px]">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+4px)] inset-x-0 z-20 bg-surface-container-highest rounded-lg max-h-[240px] overflow-y-auto ring-1 ring-inset ring-border-subtle/25 shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
          {LANGUAGES.map(lang => (
            <div
              key={lang}
              onClick={() => { onChange(lang); setOpen(false) }}
              className={[
                'px-3.5 py-2.5 text-xs text-on-surface font-["Inter"] cursor-pointer',
                'flex items-center justify-between',
                value === lang ? 'bg-lime/8' : 'hover:bg-surface-container-high',
              ].join(' ')}
            >
              {lang}
              {value === lang && <span className="material-symbols-outlined text-[14px] text-lime">check</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TextField({ value, onChange, placeholder, icon }) {
  const [focus, setFocus] = useState(false)
  return (
    <div className={[
      'flex items-center gap-2.5 bg-surface-container-high rounded-md px-3.5 py-3 transition-colors',
      focus ? 'ring-1 ring-inset ring-lime/50' : 'ring-1 ring-inset ring-border-subtle/15',
    ].join(' ')}>
      {icon && <span className="material-symbols-outlined text-[16px] text-muted">{icon}</span>}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={placeholder}
        className="flex-1 bg-transparent border-none outline-none text-on-surface text-[13px] font-['Inter']"
      />
    </div>
  )
}

function TextArea({ value, onChange, placeholder, rows = 3 }) {
  const [focus, setFocus] = useState(false)
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      placeholder={placeholder}
      rows={rows}
      className={[
        'w-full bg-surface-container-high text-on-surface rounded-md px-3.5 py-3',
        'text-[13px] font-["Inter"] outline-none resize-y leading-[1.5] box-border',
        focus ? 'ring-1 ring-inset ring-lime/50' : 'ring-1 ring-inset ring-border-subtle/15',
      ].join(' ')}
    />
  )
}

export default function StepAudience({ state, setState }) {
  const audience = state.audience

  const toggleMulti = (key, val) => {
    const list = audience[key] || []
    const next = list.includes(val) ? list.filter(x => x !== val) : [...list, val]
    setState.audience({ ...audience, [key]: next })
  }
  const setField = (key, val) => setState.audience({ ...audience, [key]: val })

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="groups" tone="secondary">Audience Signal · Step 3 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="Who is this video" line2="speaking to?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[640px] leading-[1.6]">
          These signals feed the b-roll matcher so stock footage reflects the people your video is actually for.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-5">
        <FieldCard label="Age Group" hint="Multi-select" icon="elderly">
          <div className="flex flex-wrap gap-2">
            {AGE_GROUPS.map(g => (
              <CheckPill
                key={g.id}
                checked={(audience.age || []).includes(g.id)}
                onChange={() => toggleMulti('age', g.id)}
                label={<span>{g.label} <span className="opacity-50 font-medium">· {g.hint}</span></span>}
                tone="primary"
              />
            ))}
          </div>
        </FieldCard>

        <FieldCard label="Sex / Gender" hint="Multi-select" icon="wc">
          <div className="flex flex-wrap gap-2">
            {SEX.map(s => (
              <CheckPill
                key={s.id}
                checked={(audience.sex || []).includes(s.id)}
                onChange={() => toggleMulti('sex', s.id)}
                label={s.label}
                tone="primary"
              />
            ))}
          </div>
        </FieldCard>
      </div>

      <div className="mb-5">
        <FieldCard label="Ethnicity / Race" hint="Multi-select · used to guide casting in stock b-roll" icon="diversity_3">
          <div className="flex flex-wrap gap-2">
            {ETHNICITY.map(e => (
              <CheckPill
                key={e.id}
                checked={(audience.ethnicity || []).includes(e.id)}
                onChange={() => toggleMulti('ethnicity', e.id)}
                label={e.label}
                tone="tertiary"
              />
            ))}
          </div>
        </FieldCard>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-5">
        <FieldCard label="Primary Language" hint="Single" icon="translate">
          <LanguageSelect value={audience.language} onChange={v => setField('language', v)} />
        </FieldCard>

        <FieldCard label="Region / Locale" hint="Optional" icon="public">
          <TextField
            value={audience.region || ''}
            onChange={v => setField('region', v)}
            placeholder="e.g. North America, LATAM, EMEA…"
            icon="location_on"
          />
        </FieldCard>
      </div>

      <FieldCard label="Extra Comments" hint="Optional" icon="edit_note">
        <TextArea
          value={audience.notes || ''}
          onChange={v => setField('notes', v)}
          placeholder="Anything else the matcher should know? e.g. 'Indie music fans, outdoor lifestyle — avoid corporate office shots.'"
          rows={3}
        />
      </FieldCard>
    </div>
  )
}
