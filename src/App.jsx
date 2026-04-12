import { Component, useState } from 'react'
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
import RunsView from './components/views/RunsView.jsx'
import StabilityView from './components/views/StabilityView.jsx'
import BRollStrategiesView from './components/views/BRollStrategiesView.jsx'
import BRollRunsView from './components/views/BRollRunsView.jsx'
import ApiKeysView from './components/views/ApiKeysView.jsx'
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

function AuthGate() {
  const { authEnabled, isAuthenticated, loading, signInWithPassword, signUp } = useRole()
  const [mode, setMode] = useState('signin') // signin | signup | forgot
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        Loading...
      </div>
    )
  }

  if (!authEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-amber-300 text-sm">
        Auth not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.
      </div>
    )
  }

  if (isAuthenticated) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'signin') {
        await signInWithPassword({ email, password })
      } else if (mode === 'signup') {
        const result = await signUp({ email, password })
        if (!result.session) {
          setMessage('Account created. Check your email to confirm.')
          setSubmitting(false)
          return
        }
      } else if (mode === 'forgot') {
        const { supabase } = await import('./lib/supabaseClient.js')
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        })
        if (resetError) throw resetError
        setMessage('Password reset email sent. Check your inbox.')
        setSubmitting(false)
        return
      }
    } catch (err) {
      setError(err.message || 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-xl font-semibold text-zinc-100">
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}
        </h1>
        <p className="mb-6 text-center text-sm text-zinc-500">
          {mode === 'forgot' ? 'Enter your email to receive a reset link' : 'Transcript Eval'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
          />
          {mode !== 'forgot' && (
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-zinc-600"
            />
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
          {message && <p className="text-sm text-green-400">{message}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-zinc-100 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {submitting ? 'Working...' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </button>
        </form>

        <div className="mt-4 flex flex-col items-center gap-2 text-sm text-zinc-500">
          {mode === 'signin' && (
            <>
              <button onClick={() => { setMode('forgot'); setError(''); setMessage('') }} className="hover:text-zinc-300">Forgot password?</button>
              <button onClick={() => { setMode('signup'); setError(''); setMessage('') }} className="hover:text-zinc-300">Create an account</button>
            </>
          )}
          {mode === 'signup' && (
            <button onClick={() => { setMode('signin'); setError(''); setMessage('') }} className="hover:text-zinc-300">Already have an account? Sign in</button>
          )}
          {mode === 'forgot' && (
            <button onClick={() => { setMode('signin'); setError(''); setMessage('') }} className="hover:text-zinc-300">Back to sign in</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { role, isAuthenticated, loading, authEnabled } = useRole()

  // Gate: show login when auth is enabled and user is not authenticated
  if (authEnabled && !isAuthenticated && !loading) {
    return <AuthGate />
  }
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">Loading...</div>
  }

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
        <Route path="broll" element={<BRollStrategiesView />} />
        <Route path="broll-runs" element={<BRollRunsView />} />
        <Route path="keys" element={<ApiKeysView />} />
        <Route path="experiments" element={<ExperimentsView />} />
        <Route path="runs" element={<RunsView />} />
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
