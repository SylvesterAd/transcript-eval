// src/components/upload-config/Stepper.jsx
import { Fragment } from 'react'

export default function Stepper({ steps, current, onJump }) {
  return (
    <div className="flex items-center gap-1">
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        const canJump = done

        return (
          <Fragment key={s.id}>
            <div
              onClick={() => canJump && onJump?.(i)}
              className={[
                'flex items-center gap-2 px-2.5 py-1.5 rounded-full transition-all',
                active ? 'bg-lime/10' : 'bg-transparent',
                canJump ? 'cursor-pointer' : 'cursor-default',
              ].join(' ')}
            >
              <div
                className={[
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold font-["Inter"] transition-all',
                  active ? 'bg-lime text-on-primary-container shadow-[0_0_12px_rgba(206,252,0,0.45)]'
                    : done ? 'bg-lime/25 text-lime'
                    : 'bg-surface-container-high text-muted',
                ].join(' ')}
              >
                {done ? (
                  <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: '"wght" 700' }}>
                    check
                  </span>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={[
                  'text-[10px] font-bold uppercase tracking-[0.2em] font-["Inter"]',
                  active ? 'text-lime' : done ? 'text-on-surface-variant' : 'text-muted/60',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={[
                  'w-5 h-px',
                  done ? 'bg-lime/25' : 'bg-border-subtle/25',
                ].join(' ')}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
