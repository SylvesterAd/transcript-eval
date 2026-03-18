import { Routes, Route, NavLink } from 'react-router-dom'
import { Database, Video, FlaskConical, LayoutDashboard } from 'lucide-react'
import DashboardView from './components/views/DashboardView.jsx'
import VideosView from './components/views/VideosView.jsx'
import VideoDetailView from './components/views/VideoDetailView.jsx'
import StrategiesView from './components/views/StrategiesView.jsx'
import ExperimentsView from './components/views/ExperimentsView.jsx'
import RunDetailView from './components/views/RunDetailView.jsx'
import StabilityView from './components/views/StabilityView.jsx'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/videos', icon: Video, label: 'Videos' },
  { to: '/strategies', icon: Database, label: 'Flows' },
  { to: '/experiments', icon: FlaskConical, label: 'Experiments' },
]

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      {/* Sidebar */}
      <nav className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800">
          <h1 className="text-sm font-bold tracking-wide text-zinc-300 uppercase">Transcript Eval</h1>
        </div>
        <div className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
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
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<DashboardView />} />
          <Route path="/videos" element={<VideosView />} />
          <Route path="/videos/:id" element={<VideoDetailView />} />
          <Route path="/strategies" element={<StrategiesView />} />
          <Route path="/experiments" element={<ExperimentsView />} />
          <Route path="/runs/:runId" element={<RunDetailView />} />
          <Route path="/experiments/:experimentId/stability" element={<StabilityView />} />
        </Routes>
      </main>
    </div>
  )
}
