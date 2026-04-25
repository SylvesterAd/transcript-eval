// src/components/upload-config/primitives/RadioTile.jsx
import { useState } from 'react'

export default function RadioTile({ active, onClick, tone = 'primary', children, className = '' }) {
  const [hover, setHover] = useState(false)

  const ringClass =
    tone === 'primary' ? 'ring-lime shadow-[0_0_24px_rgba(206,252,0,0.10)]'
    : tone === 'tertiary' ? 'ring-teal shadow-[0_0_24px_rgba(45,212,191,0.10)]'
    : 'ring-purple-accent shadow-[0_0_24px_rgba(193,128,255,0.10)]'

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'rounded-xl p-5 cursor-pointer relative transition-all',
        active
          ? `bg-surface-container-high ring-[1.5px] ring-inset ${ringClass}`
          : hover
            ? 'bg-surface-container-highest ring-1 ring-inset ring-border-subtle/10'
            : 'bg-surface-container-low ring-1 ring-inset ring-border-subtle/10',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}
