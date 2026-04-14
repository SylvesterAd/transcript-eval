import { useState, useEffect } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import { Database, Video, FlaskConical, LayoutDashboard, DollarSign, Play, Film, Key, ScrollText } from 'lucide-react'
import { useRole } from '../../contexts/RoleContext.jsx'
import AuthDropdown from '../auth/AuthDropdown.jsx'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

const navItems = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/admin/videos', icon: Video, label: 'Videos' },
  { to: '/admin/strategies', icon: Database, label: 'Rough Cut Strategies' },
  { to: '/admin/broll', icon: Film, label: 'B-Roll Strategies' },
  { to: '/admin/experiments', icon: FlaskConical, label: 'Experiments' },
  { to: '/admin/runs', icon: Play, label: 'Rough Cut Runs' },
  { to: '/admin/broll-runs', icon: Play, label: 'B-Roll Runs' },
  { to: '/admin/keys', icon: Key, label: 'API Keys' },
  { to: '/admin/api-logs', icon: ScrollText, label: 'API Logs' },
]

export default function AdminLayout() {
  const { isAuthenticated, role, userDisplayName } = useRole()
  const [spending, setSpending] = useState(null)
  const [totalSpending, setTotalSpending] = useState(null)
  const [backendVersion, setBackendVersion] = useState(null)

  useEffect(() => {
    const getHeaders = async () => {
      const headers = {}
      if (supabase) {
        const { data } = await supabase.auth.getSession()
        if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
      }
      return headers
    }
    const fetchSpending = async () => {
      const headers = await getHeaders()
      fetch(`${API_BASE}/experiments/spending/today`, { headers }).then(r => r.ok ? r.json() : null).then(d => d && setSpending(d)).catch(() => {})
      fetch(`${API_BASE}/experiments/spending/total`, { headers }).then(r => r.ok ? r.json() : null).then(d => d && setTotalSpending(d)).catch(() => {})
    }
    fetchSpending()
    fetch(`${API_BASE}/health`).then(r => r.json()).then(setBackendVersion).catch(() => {})
    const interval = setInterval(fetchSpending, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      <nav className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h1 className="text-sm font-bold tracking-wide text-zinc-300 uppercase">Transcript Eval</h1>
          <AuthDropdown panel="admin" />
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
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Session</div>
              <div className="mt-1 text-sm text-zinc-200">{isAuthenticated ? userDisplayName : 'Guest mode'}</div>
              <div className="mt-1 text-[11px] text-zinc-500">{isAuthenticated ? `Role: ${role}` : 'Auth not enforced yet'}</div>
            </div>
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
            {totalSpending && (
              <>
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5 mt-3">
                  <DollarSign size={10} />
                  All Time
                </div>
                <div className="text-lg font-medium text-zinc-200">
                  ${totalSpending.total_cost < 1 ? totalSpending.total_cost.toFixed(4) : totalSpending.total_cost.toFixed(2)}
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5">
                  {totalSpending.runs} run{totalSpending.runs !== 1 ? 's' : ''} &middot; {totalSpending.total_tokens > 1000000 ? `${(totalSpending.total_tokens / 1000000).toFixed(1)}M` : `${Math.round(totalSpending.total_tokens / 1000)}k`} tokens
                </div>
              </>
            )}
          </div>
        )}
        {backendVersion && (
          <div className="px-3 pb-2 text-[10px] text-zinc-600 font-mono">
            FE: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?'} &middot; API: {backendVersion.version} &middot; {backendVersion.deployed ? new Date(backendVersion.deployed).toLocaleDateString() : ''}
          </div>
        )}
      </nav>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
