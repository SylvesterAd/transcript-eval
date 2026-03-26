import { useState, useEffect, useRef } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Database, Video, FlaskConical, LayoutDashboard, DollarSign, User } from 'lucide-react'
import { useRole } from '../../contexts/RoleContext.jsx'

const navItems = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/admin/videos', icon: Video, label: 'Videos' },
  { to: '/admin/strategies', icon: Database, label: 'Flows' },
  { to: '/admin/experiments', icon: FlaskConical, label: 'Experiments' },
]

export default function AdminLayout() {
  const { setRole } = useRole()
  const navigate = useNavigate()
  const [spending, setSpending] = useState(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef(null)

  useEffect(() => {
    const fetchSpending = () => {
      fetch('/api/experiments/spending/today')
        .then(r => r.json())
        .then(setSpending)
        .catch(() => {})
    }
    fetchSpending()
    const interval = setInterval(fetchSpending, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handleClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const switchToUser = () => {
    setRole('user')
    navigate('/')
    setDropdownOpen(false)
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      <nav className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h1 className="text-sm font-bold tracking-wide text-zinc-300 uppercase">Transcript Eval</h1>
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-medium hover:opacity-90 transition-opacity"
            >
              A
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-9 w-48 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg z-50 py-1">
                <div className="px-3 py-2 text-xs text-zinc-400 border-b border-zinc-700">
                  Role: Admin
                </div>
                <button
                  onClick={switchToUser}
                  className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  Switch to User Panel
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/admin'}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                  isActive
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </div>
        {spending && (
          <div className="p-3 border-t border-zinc-800">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
              <DollarSign size={10} />
              Today
            </div>
            <div className="text-lg font-medium text-zinc-200">
              ${spending.total_cost < 1 ? spending.total_cost.toFixed(4) : spending.total_cost.toFixed(2)}
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              {spending.runs} run{spending.runs !== 1 ? 's' : ''} &middot; {spending.total_tokens > 1000000 ? `${(spending.total_tokens / 1000000).toFixed(1)}M` : `${Math.round(spending.total_tokens / 1000)}k`} tokens
            </div>
          </div>
        )}
      </nav>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
