// src/components/upload-config/steps/StepLibraries.jsx
import { useState } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'
import Toggle from '../primitives/Toggle.jsx'

const LIBRARIES = [
  { id: 'envato',      name: 'Envato',      tagline: 'Elements · premium footage',   stats: '12M+ assets' },
  { id: 'artlist',     name: 'Artlist',     tagline: 'Cinematic footage & music',    stats: '2M+ clips' },
  { id: 'storyblocks', name: 'Storyblocks', tagline: 'Unlimited stock subscription', stats: '1M+ clips' },
]

function LibraryTile({ lib, checked, onToggle }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={() => onToggle(lib.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'rounded-xl p-5 cursor-pointer transition-all flex flex-col gap-3.5 min-h-[150px] relative',
        checked
          ? 'bg-surface-container-high ring-[1.5px] ring-inset ring-lime shadow-[0_0_24px_rgba(206,252,0,0.08)]'
          : hover
            ? 'bg-surface-container-highest ring-1 ring-inset ring-border-subtle/10'
            : 'bg-surface-container-low ring-1 ring-inset ring-border-subtle/10',
      ].join(' ')}
    >
      <div className="flex justify-between items-start">
        <div className="h-9 flex items-center px-2.5 py-1.5 rounded bg-black/25">
          <span className="text-sm font-extrabold text-on-surface font-['Inter']">{lib.name}</span>
        </div>
        <div className={[
          'w-[22px] h-[22px] rounded-full flex items-center justify-center',
          checked ? 'bg-lime text-on-primary-container shadow-[0_0_10px_rgba(206,252,0,0.4)]'
            : 'bg-transparent text-muted ring-1 ring-border-subtle/40',
        ].join(' ')}>
          <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: '"wght" 700' }}>
            {checked ? 'check' : 'add'}
          </span>
        </div>
      </div>
      <div className="text-xs text-on-surface-variant font-['Inter'] leading-[1.4]">
        {lib.tagline}
      </div>
      <div className="mt-auto">
        <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-container-high text-on-surface-variant text-[10px] font-bold tracking-[0.15em] uppercase font-['Inter'] ring-1 ring-inset ring-border-subtle/15">
          {lib.stats}
        </span>
      </div>
    </div>
  )
}

export default function StepLibraries({ state, setState }) {
  const selected = state.libraries
  const none = selected.length === 0
  const toggle = id => setState.libraries(
    selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]
  )
  const clearAll = () => setState.libraries([])

  const sourcesLine = none
    ? `Pexels${state.freepikOptIn ? ' + Freepik (paid, confirm each)' : ' only'}`
    : selected.map(id => LIBRARIES.find(l => l.id === id)?.name).filter(Boolean).join(' · ')

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="inventory_2" tone="secondary">B-Roll Sources · Step 2 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="Which stock libraries" line2="do you subscribe to?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[640px] leading-[1.6]">
          Select every subscription you already have a paid seat for. Kinetic will search b-roll across these
          libraries at no extra cost. Select all that apply.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3.5 mb-4">
        {LIBRARIES.map(lib => (
          <LibraryTile
            key={lib.id}
            lib={lib}
            checked={selected.includes(lib.id)}
            onToggle={toggle}
          />
        ))}
      </div>

      <div
        onClick={() => none ? null : clearAll()}
        className={[
          'rounded-xl transition-all',
          none
            ? 'bg-purple-accent/6 p-[22px] ring-[1.5px] ring-inset ring-purple-accent/35 shadow-[0_0_32px_rgba(193,128,255,0.06)] cursor-default'
            : 'bg-surface-container-low p-[18px] ring-1 ring-inset ring-border-subtle/10 cursor-pointer',
        ].join(' ')}
      >
        <div className="flex items-start gap-4">
          <div className={[
            'w-[42px] h-[42px] rounded-[10px] shrink-0 flex items-center justify-center',
            none ? 'bg-purple-accent/15 text-purple-accent' : 'bg-surface-container-high text-on-surface-variant',
          ].join(' ')}>
            <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: `"FILL" ${none ? 1 : 0}` }}>
              public
            </span>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2.5 mb-1">
              <span className="text-[15px] font-bold text-on-surface font-['Inter']">
                I don't own any subscriptions
              </span>
              {none && (
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-purple-accent/12 text-purple-accent text-[9px] font-bold tracking-[0.15em] uppercase font-['Inter'] ring-1 ring-inset ring-purple-accent/25">
                  <span className="material-symbols-outlined text-[11px]">bolt</span>
                  Active fallback
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-variant leading-[1.6] m-0 mt-2 max-w-[680px]">
              We'll use <span className="text-on-surface font-semibold">Pexels</span> (free) wherever possible.
              For moments Pexels can't cover, we can also pull from{' '}
              <span className="text-on-surface font-semibold">Freepik</span> at{' '}
              <span className="font-mono text-lime">$0.05 / clip</span>.{' '}
              <span className="text-on-surface font-semibold">Nothing is charged until you confirm each download.</span>
            </p>

            {none && (
              <div className="mt-4 p-3.5 rounded-[10px] bg-surface-container-highest ring-1 ring-inset ring-border-subtle/12 flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="px-2.5 py-1.5 rounded bg-black/25 flex items-center">
                    <span className="text-sm font-extrabold text-on-surface font-['Inter']">Freepik</span>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-on-surface font-['Inter']">Allow paid Freepik fallback</div>
                    <div className="text-[11px] text-on-surface-variant mt-[3px] font-['Inter']">
                      Surfaces clips for shots Pexels misses — you approve every charge before download.
                    </div>
                  </div>
                </div>
                <Toggle checked={state.freepikOptIn} onChange={setState.freepikOptIn} tone="secondary" />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 px-[18px] py-3.5 rounded-[10px] bg-surface-container-low ring-1 ring-inset ring-border-subtle/8 flex items-center gap-3">
        <span className="material-symbols-outlined text-[18px] text-lime">search</span>
        <div className="text-xs text-on-surface-variant leading-[1.5] font-['Inter']">
          <span className="text-on-surface font-semibold">B-roll will be searched across:</span>{' '}
          {sourcesLine}
        </div>
      </div>
    </div>
  )
}
