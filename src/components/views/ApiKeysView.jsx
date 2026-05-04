import { useState } from 'react'
import { useApi } from '../../hooks/useApi.js'
import { Eye, EyeOff, Copy, Check } from 'lucide-react'

export default function ApiKeysView() {
  const { data, loading, error } = useApi('/admin/keys')
  const { data: spendByKey } = useApi('/experiments/spending/by-key')
  const [revealed, setRevealed] = useState({})
  const [copied, setCopied] = useState(null)

  const spendIndex = (spendByKey?.keys || []).reduce((acc, k) => {
    if (k.api_key_last5) acc[k.api_key_last5] = k
    return acc
  }, {})
  const preTracking = (spendByKey?.keys || []).find(k => !k.api_key_last5)
  const fmt = (cost) => cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
  const fmtTokens = (n) => n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n > 1000 ? `${Math.round(n / 1000)}k` : String(n)

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
            {keys.map(({ name, label, value }) => {
              const last5 = value.slice(-5)
              const spend = spendIndex[last5]
              return (
                <div
                  key={name}
                  className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-200">{label}</div>
                    <div className="text-xs text-zinc-500 font-mono">{name}</div>
                  </div>
                  <div className="text-right text-xs min-w-[140px]">
                    {spend ? (
                      <>
                        <div className="text-zinc-200 font-medium">{fmt(spend.total_cost)}</div>
                        <div className="text-zinc-500">{spend.runs} run{spend.runs !== 1 ? 's' : ''} · {fmtTokens(spend.total_tokens)} tok</div>
                      </>
                    ) : (
                      <div className="text-zinc-600">—</div>
                    )}
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
              )
            })}
          </div>
        </section>
      ))}

      {preTracking && preTracking.runs > 0 && (
        <section>
          <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">Pre-tracking</h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-4 py-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-zinc-300">Spend logged before per-key tracking shipped</div>
              <div className="text-xs text-zinc-500 mt-0.5">Cannot be attributed to a specific key.</div>
            </div>
            <div className="text-right text-xs">
              <div className="text-zinc-200 font-medium">{fmt(preTracking.total_cost)}</div>
              <div className="text-zinc-500">{preTracking.runs} runs · {fmtTokens(preTracking.total_tokens)} tok</div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
