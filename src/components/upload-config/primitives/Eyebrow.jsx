// src/components/upload-config/primitives/Eyebrow.jsx
export default function Eyebrow({ icon, tone = 'secondary', children }) {
  const color =
    tone === 'primary' ? 'text-lime'
    : tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'

  return (
    <div className={`flex items-center gap-2 ${color}`}>
      {icon && (
        <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>
          {icon}
        </span>
      )}
      <span className="text-[10px] font-bold uppercase tracking-[0.2em] font-['Inter']">
        {children}
      </span>
    </div>
  )
}
