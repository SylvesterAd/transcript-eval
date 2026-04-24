// src/components/upload-config/primitives/FieldCard.jsx
export default function FieldCard({ label, hint, icon, children }) {
  return (
    <div className="bg-surface-container-low rounded-xl p-[18px] ring-1 ring-inset ring-border-subtle/8">
      <div className="flex items-center gap-2.5 mb-3.5">
        {icon && (
          <div className="w-7 h-7 rounded-md bg-surface-container-high text-on-surface-variant flex items-center justify-center">
            <span className="material-symbols-outlined text-[16px]">{icon}</span>
          </div>
        )}
        <div className="flex-1">
          <div className="text-[10px] font-extrabold text-on-surface tracking-[0.2em] uppercase font-['Inter']">
            {label}
          </div>
          {hint && <div className="text-[10px] text-muted mt-[3px] font-['Inter']">{hint}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}
