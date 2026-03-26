import { Outlet } from 'react-router-dom'
import { Search, HelpCircle, MessageSquare, Database } from 'lucide-react'
import { useRole } from '../../contexts/RoleContext.jsx'
import AuthDropdown from '../auth/AuthDropdown.jsx'

export default function UserLayout() {
  const { authEnabled, isAuthenticated, role, userDisplayName } = useRole()

  return (
    <div className="min-h-screen bg-obsidian text-gray-100 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-surface-dark border-b border-border-subtle">
        <div className="flex items-center flex-1">
          <div className="relative w-full max-w-2xl">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search size={16} className="text-muted" />
            </span>
            <input
              className="w-full bg-surface text-sm rounded-md pl-10 pr-4 py-2 border border-transparent focus:bg-surface-dark focus:border-lime focus:ring-1 focus:ring-lime outline-none transition-colors text-white placeholder-muted"
              placeholder="Search projects"
              type="text"
            />
          </div>
        </div>
        <div className="flex items-center space-x-4 ml-6">
          {/* Credits badge */}
          <div className="flex items-center bg-surface rounded-md border border-border-subtle p-1 text-sm px-1">
            <div className="flex items-center px-3 space-x-2 text-muted">
              <Database size={14} />
              <span>{isAuthenticated ? userDisplayName : 'Guest Mode'}</span>
            </div>
            <div className="bg-lime text-black px-3 py-1 rounded text-xs font-bold ml-2 shadow-[0_0_10px_rgba(208,255,0,0.2)]">
              {isAuthenticated ? role : authEnabled ? 'Sign in available' : 'Auth pending'}
            </div>
          </div>
          {/* Actions */}
          <div className="flex items-center space-x-3">
            {/* Avatar with dropdown */}
            <AuthDropdown panel="user" />
            {/* Help */}
            <div className="relative">
              <button className="text-muted hover:text-gray-300 transition-colors">
                <HelpCircle size={20} />
              </button>
              <div className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border border-obsidian" />
            </div>
            {/* Chat */}
            <button className="w-8 h-8 bg-yellow-600 text-white rounded flex items-center justify-center hover:opacity-90 transition-opacity">
              <MessageSquare size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-obsidian p-8 rounded-tl-xl border-t border-l border-border-subtle mt-2 ml-2">
        <Outlet />
      </main>
    </div>
  )
}
