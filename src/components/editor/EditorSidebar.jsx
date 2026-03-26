const items = [
  { icon: 'folder', label: 'Files', id: 'files', filled: true },
  { icon: 'sync', label: 'Sync', id: 'sync' },
  { icon: 'movie_edit', label: 'Rough Cut', id: 'roughcut' },
  { icon: 'video_library', label: 'B-Rolls', id: 'brolls', disabled: true },
]

export default function EditorSidebar({ activeTab = 'sync', onTabChange }) {
  return (
    <aside className="flex flex-col items-center py-4 gap-8 border-r border-white/5 bg-[#0e0e10] w-20 shrink-0">
      <nav className="flex flex-col gap-6 w-full px-2">
        {items.map(item => {
          const active = item.id === activeTab
          return (
            <div
              key={item.id}
              onClick={() => !item.disabled && onTabChange?.(item.id)}
              className={`flex flex-col items-center gap-1 cursor-pointer py-3 rounded-lg transition-all ${
                active
                  ? 'text-[#cefc00] bg-[#cefc00]/5'
                  : item.disabled
                    ? 'text-[#f6f3f5] opacity-20 cursor-not-allowed'
                    : 'text-[#f6f3f5] opacity-40 hover:opacity-100 hover:bg-[#1a1a1c]'
              }`}
            >
              <span
                className="material-symbols-outlined"
                style={active || item.filled ? { fontVariationSettings: '"FILL" 1' } : undefined}
              >{item.icon}</span>
              <span className="text-[9px] font-bold uppercase tracking-tighter">{item.label}</span>
            </div>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-6 w-full px-2">
        <div className="flex flex-col items-center gap-1 opacity-40 hover:opacity-100 transition-all cursor-pointer">
          <span className="material-symbols-outlined">delete</span>
        </div>
        <div className="flex flex-col items-center gap-1 opacity-40 hover:opacity-100 transition-all cursor-pointer">
          <span className="material-symbols-outlined">help_outline</span>
        </div>
      </div>
    </aside>
  )
}
