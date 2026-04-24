// src/components/upload-config/primitives/PageTitle.jsx
export default function PageTitle({ line1, line2, accentTone = 'primary', size = 26 }) {
  const color =
    accentTone === 'primary' ? 'text-lime'
    : accentTone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'

  return (
    <h1
      className="font-bold tracking-tight text-on-surface m-0 leading-[1.15] font-['Inter']"
      style={{ fontSize: size }}
    >
      {line1}
      {line2 ? <> <span className={color}>{line2}</span></> : null}
    </h1>
  )
}
