import { useState } from 'react'
import { useApi } from '../../hooks/useApi.js'
import { Eye, EyeOff, Copy, Check } from 'lucide-react'

export default function ApiKeysView() {
  const { data, loading, error } = useApi('/admin/keys')
  const [revealed, setRevealed] = useState({})
  const [copied, setCopied] = useState(null)

  function toggleReveal(name) {
    setRevealed(prev => ({ ...prev, [name]: !prev[name] }))
  }

  function copyKey(name, value) {
    navigator.clipboard.writeText(value)
    setCopied(name)
    setTimeout(() => setCopied(null), 2000)
  }

  function mask(value) {
    if (value.length <= 8) return '*'.repeat(value.length)
    return value.slice(0, 4) + '*'.repeat(Math.min(value.length - 8, 32)) + value.slice(-4)
  }

  if (loading) return <div className="p-6 text-zinc-400">Loading...</div>
  if (error) return <div className="p-6 text-red-400">Access denied or error: {error}</div>

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold">API Keys</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Keys are loaded from server environment. Only admins can view this page.
        </p>
      </div>

      {data?.groups?.map(({ group, keys }) => (
        <section key={group}>
          <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">{group}</h3>
          <div className="space-y-2">
            {keys.map(({ name, label, value }) => (
              <div
                key={name}
                className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-200">{label}</div>
                  <div className="text-xs text-zinc-500 font-mono">{name}</div>
                </div>
                <code className="text-xs text-zinc-400 font-mono max-w-[360px] truncate">
                  {revealed[name] ? value : mask(value)}
                </code>
                <button
                  onClick={() => toggleReveal(name)}
                  className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                  title={revealed[name] ? 'Hide' : 'Reveal'}
                >
                  {revealed[name] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  onClick={() => copyKey(name, value)}
                  className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                  title="Copy"
                >
                  {copied === name ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
