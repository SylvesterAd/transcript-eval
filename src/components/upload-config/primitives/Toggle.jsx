// src/components/upload-config/primitives/Toggle.jsx
export default function Toggle({ checked, onChange, tone = 'primary' }) {
  const bgClass = checked
    ? (tone === 'primary' ? 'bg-lime'
      : tone === 'tertiary' ? 'bg-teal'
      : 'bg-purple-accent')
    : 'bg-surface-container-high'

  const glow = checked
    ? (tone === 'primary' ? 'shadow-[0_0_12px_rgba(206,252,0,0.4)]'
      : tone === 'tertiary' ? 'shadow-[0_0_12px_rgba(45,212,191,0.4)]'
      : 'shadow-[0_0_12px_rgba(193,128,255,0.4)]')
    : ''

  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full border-none p-0 cursor-pointer transition-colors shrink-0 ${bgClass} ${glow}`}
    >
      <div
        className={`absolute top-[3px] w-4 h-4 rounded-full transition-[left] ${checked ? 'bg-on-surface' : 'bg-on-surface'}`}
        style={{ left: checked ? 21 : 3 }}
      />
    </button>
  )
}
