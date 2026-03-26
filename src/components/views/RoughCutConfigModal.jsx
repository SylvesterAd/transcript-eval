import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { apiPut } from '../../hooks/useApi.js'

const DEFAULT_CONFIG = {
  cut: { silences: true, false_starts: false, filler_words: true, meta_commentary: false },
  identify: { repetition: true, lengthy: false, technical_unclear: false, irrelevance: false },
}

const CUT_OPTIONS = [
  { key: 'silences', label: 'Cut silences', icon: 'airwave' },
  { key: 'false_starts', label: 'Cut False Starts', icon: 'content_cut' },
  { key: 'filler_words', label: 'Cut Filler Words', icon: 'voice_over_off' },
  { key: 'meta_commentary', label: 'Cut Meta Commentary', icon: 'chat_bubble_outline' },
]

const IDENTIFY_OPTIONS = [
  { key: 'repetition', label: 'Identify Repetitive parts', icon: 'replay' },
  { key: 'lengthy', label: 'Identify Over-explanation & Lengthy parts', icon: 'history_edu' },
  { key: 'technical_unclear', label: 'Identify Too technical & Unclear parts', icon: 'science' },
  { key: 'irrelevance', label: 'Identify Irrelevant parts', icon: 'delete_sweep' },
]

export default function RoughCutConfigModal({ groupId, onBack, onComplete }) {
  const [config, setConfig] = useState(() => {
    try {
      const saved = localStorage.getItem('rough-cut-defaults')
      if (saved) return JSON.parse(saved)
    } catch { /* ignore */ }
    return DEFAULT_CONFIG
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onBack() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onBack])

  const toggle = (section, key) => {
    setConfig(prev => ({
      ...prev,
      [section]: { ...prev[section], [key]: !prev[section][key] },
    }))
  }

  const handleContinue = async () => {
    setSaving(true)
    try {
      await apiPut(`/videos/groups/${groupId}`, { rough_cut_config_json: config })
      localStorage.setItem('rough-cut-defaults', JSON.stringify(config))
      onComplete(groupId)
    } catch (err) {
      console.error('Failed to save config:', err)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] min-h-screen flex items-center justify-center p-6 md:p-12 bg-black/80 backdrop-blur-sm">
      {/* Background decorative glow */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary-container/5 rounded-full blur-[120px] -z-10 pointer-events-none" />

      {/* Modal */}
      <div className="relative w-full max-w-5xl bg-surface-container-low/70 backdrop-blur-2xl rounded-xl p-8 shadow-[0_32px_64px_rgba(0,0,0,0.6)] border border-white/[0.03] max-h-[90vh] overflow-y-auto">

        {/* Header — centered */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-extrabold tracking-tight text-on-surface mb-2">
            Configure Your AI Rough Cut
          </h1>
          <p className="text-on-surface-variant font-medium">
            No worries you can adjust your choices later
          </p>
        </div>

        <div className="space-y-12 mb-10">

          {/* CUT OPTIONS */}
          <section>
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-xs font-black tracking-[0.2em] text-primary-container uppercase">
                Cut Options
              </h2>
              <div className="h-px flex-1 bg-white/[0.05]" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {CUT_OPTIONS.map(({ key, label, icon }) => {
                const active = config.cut[key]
                return active ? (
                  <div
                    key={key}
                    onClick={() => toggle('cut', key)}
                    className="group relative bg-surface-container-high p-5 rounded-xl transition-all duration-200 cursor-pointer"
                    style={{ boxShadow: 'inset 0 0 0 2px #cefc00' }}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex flex-col gap-4">
                        <div className="w-10 h-10 rounded-lg bg-primary-container/10 flex items-center justify-center">
                          <span className="material-symbols-outlined text-primary-container">{icon}</span>
                        </div>
                        <span className="font-bold text-on-surface tracking-wide uppercase text-[10px] opacity-80 leading-tight">
                          {label}
                        </span>
                      </div>
                      <div className="w-6 h-6 rounded-full bg-primary-container flex items-center justify-center shadow-[0_0_10px_rgba(206,252,0,0.4)] shrink-0">
                        <span className="material-symbols-outlined text-black text-sm" style={{ fontVariationSettings: '"wght" 700' }}>check</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    key={key}
                    onClick={() => toggle('cut', key)}
                    className="group relative bg-surface-container-low hover:bg-surface-container-highest p-5 rounded-xl transition-all duration-200 cursor-pointer border border-transparent hover:border-white/[0.05]"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex flex-col gap-4">
                        <div className="w-10 h-10 rounded-lg bg-surface-bright flex items-center justify-center">
                          <span className="material-symbols-outlined text-on-surface-variant">{icon}</span>
                        </div>
                        <span className="font-bold text-on-surface-variant tracking-wide uppercase text-[10px] leading-tight">
                          {label}
                        </span>
                      </div>
                      <div className="w-6 h-6 rounded-full border border-outline-variant flex items-center justify-center group-hover:bg-surface-bright shrink-0">
                        <span className="material-symbols-outlined text-on-surface-variant text-sm">add</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* IDENTIFY OPTIONS */}
          <section>
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-xs font-black tracking-[0.2em] text-teal uppercase">
                Identify Options
              </h2>
              <div className="h-px flex-1 bg-white/[0.05]" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {IDENTIFY_OPTIONS.map(({ key, label, icon }) => {
                const active = config.identify[key]
                return active ? (
                  <div
                    key={key}
                    onClick={() => toggle('identify', key)}
                    className="group relative bg-surface-container-high p-5 rounded-xl transition-all duration-200 cursor-pointer"
                    style={{ boxShadow: 'inset 0 0 0 2px #65fde6' }}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex flex-col gap-4">
                        <div className="w-10 h-10 rounded-lg bg-tertiary-container/10 flex items-center justify-center">
                          <span className="material-symbols-outlined text-teal">{icon}</span>
                        </div>
                        <span className="font-bold text-on-surface tracking-wide uppercase text-[10px] opacity-80 leading-tight">
                          {label}
                        </span>
                      </div>
                      <div className="w-6 h-6 rounded-full bg-tertiary-container flex items-center justify-center shadow-[0_0_10px_rgba(101,253,230,0.4)] shrink-0">
                        <span className="material-symbols-outlined text-on-tertiary-fixed text-sm" style={{ fontVariationSettings: '"wght" 700' }}>check</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    key={key}
                    onClick={() => toggle('identify', key)}
                    className="group relative bg-surface-container-low hover:bg-surface-container-highest p-5 rounded-xl transition-all duration-200 cursor-pointer border border-transparent hover:border-white/[0.05]"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex flex-col gap-4">
                        <div className="w-10 h-10 rounded-lg bg-surface-bright flex items-center justify-center">
                          <span className="material-symbols-outlined text-on-surface-variant">{icon}</span>
                        </div>
                        <span className="font-bold text-on-surface-variant tracking-wide uppercase text-[10px] leading-tight">
                          {label}
                        </span>
                      </div>
                      <div className="w-6 h-6 rounded-full border border-outline-variant flex items-center justify-center group-hover:bg-surface-bright shrink-0">
                        <span className="material-symbols-outlined text-on-surface-variant text-sm">add</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6 pt-6 border-t border-white/[0.05]">
          <button
            onClick={onBack}
            className="text-on-surface-variant font-bold uppercase tracking-widest text-xs hover:text-on-surface transition-colors px-4 py-2"
          >
            Back
          </button>
          <button
            onClick={handleContinue}
            disabled={saving}
            className="w-full sm:w-auto bg-gradient-to-br from-primary-container to-primary-dim text-on-primary-container font-bold px-10 py-4 rounded-xl shadow-[0_10px_30px_rgba(206,252,0,0.2)] hover:scale-[1.02] active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
