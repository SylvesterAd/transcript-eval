import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useRole } from '../../contexts/RoleContext.jsx'

export default function AuthDialog({ open, onClose }) {
  const { authEnabled, loading, signInWithPassword, signUp } = useRole()
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setMessage('')
  }, [open, mode])

  if (!open) return null

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setMessage('')

    try {
      if (mode === 'signin') {
        await signInWithPassword({ email, password })
        onClose()
        return
      }

      const result = await signUp({ email, password })
      if (result.session) {
        setMessage('Account created and signed in.')
        onClose()
        return
      }

      setMessage('Account created. Check your email to confirm the sign-in if confirmation is enabled.')
    } catch (err) {
      setError(err.message || 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Supabase Auth</p>
            <h2 className="mt-2 text-xl font-semibold">
              {mode === 'signin' ? 'Sign in to continue' : 'Create your account'}
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              This only wires session handling for now. Route protection comes next.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-zinc-800 p-2 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-100"
          >
            <X size={16} />
          </button>
        </div>

        {!authEnabled && (
          <div className="rounded-xl border border-amber-700/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to your local env file to enable auth.
          </div>
        )}

        {authEnabled && (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <label className="text-sm text-zinc-300" htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-lime-400"
                placeholder="you@example.com"
                required
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm text-zinc-300" htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition-colors focus:border-lime-400"
                placeholder="Minimum 6 characters"
                minLength={6}
                required
              />
            </div>

            {error && (
              <div className="rounded-xl border border-rose-700/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}

            {message && (
              <div className="rounded-xl border border-lime-700/40 bg-lime-500/10 px-4 py-3 text-sm text-lime-200">
                {message}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || loading}
              className="w-full rounded-xl bg-lime-400 px-4 py-3 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Working...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        )}

        <div className="mt-5 flex items-center justify-between gap-4 border-t border-zinc-900 pt-4 text-sm">
          <span className="text-zinc-500">
            {mode === 'signin' ? 'Need an account?' : 'Already have an account?'}
          </span>
          <button
            type="button"
            onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            className="font-medium text-lime-300 transition-colors hover:text-lime-200"
          >
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  )
}
