import { useRole } from '../../contexts/RoleContext.jsx'

const items = [
  { icon: 'folder', label: 'Assets', id: 'assets', filled: true },
  { icon: 'sync', label: 'Sync', id: 'sync', needsSync: true },
  { icon: 'movie_edit', label: 'Rough Cut', id: 'roughcut', needsSync: true },
  { icon: 'auto_awesome', label: 'B-Roll Strategy', id: 'brolls-strategy', navTo: 'brolls/strategy', tab: 'brolls', needsSync: true, adminOnly: true },
  { icon: 'video_library', label: 'B-Roll Editor', id: 'brolls-edit', navTo: 'brolls/edit', tab: 'brolls', needsSync: true, adminOnly: true, needsBrollSearch: true },
]

const SYNC_READY_STATUSES = ['done', 'confirmed']

export default function EditorSidebar({ activeTab = 'sync', activeSub, assemblyStatus, hasVideos = true, hasBrollSearch = false, onTabChange }) {
  const { isAdmin } = useRole()
  return (
    <aside className="flex flex-col items-center py-4 gap-8 border-r border-white/5 bg-[#0e0e10] w-20 shrink-0">
      <nav className="flex flex-col gap-6 w-full px-2">
        {items.filter(item => !item.adminOnly || isAdmin).map(item => {
          const locked = item.needsSync && (!SYNC_READY_STATUSES.includes(assemblyStatus) || !hasVideos)
          const brollLocked = item.needsBrollSearch && !hasBrollSearch
          const disabled = item.disabled || locked || brollLocked
          const active = item.tab
            ? activeTab === item.tab && (item.id === 'brolls-strategy' ? activeSub !== 'edit' : activeSub === 'edit')
            : item.id === activeTab
          return (
            <div
              key={item.id}
              onClick={() => !disabled && onTabChange?.(item.navTo || item.id)}
              className={`flex flex-col items-center gap-1 cursor-pointer py-3 rounded-lg transition-all ${
                active
                  ? 'text-[#cefc00] bg-[#cefc00]/5'
                  : disabled
                    ? 'text-[#f6f3f5] opacity-20 cursor-not-allowed'
                    : 'text-[#f6f3f5] opacity-40 hover:opacity-100 hover:bg-[#1a1a1c]'
              }`}
            >
              <span
                className="material-symbols-outlined"
                style={active || item.filled ? { fontVariationSettings: '"FILL" 1' } : undefined}
              >{item.icon}</span>
              <span className="text-[9px] font-bold uppercase tracking-tighter text-center leading-tight">{item.label}</span>
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
