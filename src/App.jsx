import { Component } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useRole } from './contexts/RoleContext.jsx'
import AdminLayout from './components/layouts/AdminLayout.jsx'
import UserLayout from './components/layouts/UserLayout.jsx'
import DashboardView from './components/views/DashboardView.jsx'
import VideosView from './components/views/VideosView.jsx'
import VideoDetailView from './components/views/VideoDetailView.jsx'
import StrategiesView from './components/views/StrategiesView.jsx'
import ExperimentsView from './components/views/ExperimentsView.jsx'
import RunDetailView from './components/views/RunDetailView.jsx'
import StabilityView from './components/views/StabilityView.jsx'
import ProjectsView from './components/views/ProjectsView.jsx'
import EditorView from './components/editor/EditorView.jsx'

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#ff6b6b', background: '#1a1a1a', minHeight: '100vh', fontFamily: 'monospace' }}>
          <h1>Runtime Error</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ffa' }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#aaa', fontSize: 12, marginTop: 16 }}>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 20, padding: '8px 16px', cursor: 'pointer' }}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const { role } = useRole()

  return (
    <Routes>
      {/* Editor — full-screen, outside UserLayout */}
      <Route path="/editor/:id" element={<ErrorBoundary><EditorView /></ErrorBoundary>} />
      <Route path="/editor/:id/:tab" element={<ErrorBoundary><EditorView /></ErrorBoundary>} />

      {/* Admin panel routes */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<DashboardView />} />
        <Route path="videos" element={<VideosView />} />
        <Route path="videos/:id" element={<VideoDetailView />} />
        <Route path="strategies" element={<StrategiesView />} />
        <Route path="experiments" element={<ExperimentsView />} />
        <Route path="runs/:runId" element={<RunDetailView />} />
        <Route path="experiments/:experimentId/stability" element={<StabilityView />} />
      </Route>

      {/* User panel routes */}
      <Route path="/" element={<UserLayout />}>
        <Route index element={<ProjectsView />} />
        <Route path="projects/:id" element={<VideosView />} />
      </Route>

      {/* Fallback: redirect based on role */}
      <Route path="*" element={<Navigate to={role === 'admin' ? '/admin' : '/'} replace />} />
    </Routes>
  )
}
