import { useState, useEffect } from 'react'
import { apiPost } from '../../hooks/useApi.js'

export default function SyncOptionsModal({ groupId, onBack, onComplete }) {
  const [syncMode, setSyncMode] = useState('sync')
  const [submitting, setSubmitting] = useState(false)
  const [groupName, setGroupName] = useState('')

  useEffect(() => {
    fetch(`/api/videos/groups/${groupId}/detail`)
      .then(r => r.json())
      .then(data => setGroupName(data.name || ''))
      .catch(() => {})
  }, [groupId])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onBack() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onBack])

  const handleConfirm = async () => {
    setSubmitting(true)
    try {
      await apiPost(`/videos/groups/${groupId}/start-assembly`, { sync_mode: syncMode })
      onComplete(groupId)
    } catch (err) {
      console.error('Start assembly failed:', err)
      setSubmitting(false)
    }
  }

  const selected = syncMode === 'sync'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl bg-surface-container rounded-xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-8 pt-8 pb-6 flex flex-col gap-1">
          <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
            Multi-cam detected. Let&apos;s sync it?
          </h1>
          {groupName && (
            <p className="font-headline text-primary-container text-sm font-bold tracking-wider uppercase">
              {groupName}
            </p>
          )}
        </div>

        {/* Cards */}
        <div className="px-8 py-4 grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Card A — Don't sync */}
          <button
            type="button"
            onClick={() => setSyncMode('no_sync')}
            className={`text-left rounded-lg overflow-hidden transition-all ${
              syncMode === 'no_sync'
                ? 'bg-surface-container-high ring-2 ring-primary-container'
                : 'bg-surface-container-low hover:ring-2 hover:ring-outline-variant'
            }`}
          >
            {/* Illustration — offset waveforms */}
            <div className="aspect-video bg-surface-container-highest flex items-center justify-center relative overflow-hidden">
              <svg viewBox="0 0 400 200" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
                {/* Playhead */}
                <line x1="180" y1="0" x2="180" y2="200" stroke="#cefc00" strokeWidth="1.5" opacity="0.4" />
                <polygon points="177,0 183,0 180,8" fill="#cefc00" opacity="0.5" />
                {/* Track 1 — offset left */}
                <g opacity="0.5">
                  <rect x="20" y="30" width="250" height="28" rx="4" fill="#262528" stroke="#48474a" strokeWidth="0.5" />
                  <text x="28" y="48" fill="#acaaad" fontSize="9" fontFamily="Inter">Camera 1</text>
                  {/* Waveform */}
                  <path d="M70,44 Q80,32 90,44 Q100,56 110,44 Q120,30 130,44 Q140,58 150,44 Q160,34 170,44 Q180,52 190,44 Q200,36 210,44 Q220,54 230,44 Q240,38 250,44" fill="none" stroke="#65fde6" strokeWidth="1.5" opacity="0.6" />
                </g>
                {/* Track 2 — offset right (misaligned) */}
                <g opacity="0.5">
                  <rect x="100" y="72" width="280" height="28" rx="4" fill="#262528" stroke="#48474a" strokeWidth="0.5" />
                  <text x="108" y="90" fill="#acaaad" fontSize="9" fontFamily="Inter">Camera 2</text>
                  {/* Waveform */}
                  <path d="M160,86 Q170,74 180,86 Q190,98 200,86 Q210,72 220,86 Q230,100 240,86 Q250,76 260,86 Q270,94 280,86 Q290,78 300,86 Q310,96 320,86 Q330,80 340,86" fill="none" stroke="#c180ff" strokeWidth="1.5" opacity="0.6" />
                </g>
                {/* Track 3 — even more offset */}
                <g opacity="0.5">
                  <rect x="60" y="114" width="300" height="28" rx="4" fill="#262528" stroke="#48474a" strokeWidth="0.5" />
                  <text x="68" y="132" fill="#acaaad" fontSize="9" fontFamily="Inter">Camera 3</text>
                  {/* Waveform */}
                  <path d="M120,128 Q130,116 140,128 Q150,140 160,128 Q170,114 180,128 Q190,142 200,128 Q210,118 220,128 Q230,136 240,128 Q250,120 260,128 Q270,138 280,128 Q290,122 300,128" fill="none" stroke="#65fde6" strokeWidth="1.5" opacity="0.6" />
                </g>
                {/* Offset arrows showing misalignment */}
                <path d="M95,66 L105,66" stroke="#ff7351" strokeWidth="1.5" strokeDasharray="3,2" opacity="0.7" />
                <path d="M55,108 L65,108" stroke="#ff7351" strokeWidth="1.5" strokeDasharray="3,2" opacity="0.7" />
                {/* Label */}
                <text x="200" y="170" fill="#acaaad" fontSize="10" fontFamily="Inter" textAnchor="middle" opacity="0.6">Tracks at original positions</text>
              </svg>
            </div>
            <div className="p-6">
              <div className="flex items-center justify-between mb-3">
                <span className={`font-headline font-bold text-lg ${
                  syncMode === 'no_sync' ? 'text-primary-container' : 'text-on-surface'
                }`}>
                  Don&apos;t sync
                </span>
                {/* Radio */}
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  syncMode === 'no_sync'
                    ? 'bg-primary-container border-primary-container'
                    : 'border-outline'
                }`}>
                  {syncMode === 'no_sync' && (
                    <span className="material-symbols-outlined text-on-primary-container text-sm">check</span>
                  )}
                </div>
              </div>
              <p className="text-on-surface-variant text-sm">
                Keep each audio track in its original position.
              </p>
            </div>
          </button>

          {/* Card B — Sync it */}
          <button
            type="button"
            onClick={() => setSyncMode('sync')}
            className={`text-left rounded-lg overflow-hidden transition-all relative ${
              selected
                ? 'bg-surface-container-high ring-2 ring-primary-container'
                : 'bg-surface-container-low hover:ring-2 hover:ring-outline-variant'
            }`}
          >
            {/* Inner glow overlay */}
            {selected && (
              <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_20px_rgba(206,252,0,0.1)] rounded-lg z-10" />
            )}
            {/* Illustration — aligned waveforms */}
            <div className="aspect-video bg-surface-container-highest flex items-center justify-center relative overflow-hidden">
              <svg viewBox="0 0 400 200" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
                {/* Glow effect behind aligned area */}
                <rect x="48" y="20" width="320" height="150" rx="8" fill="#cefc00" opacity="0.02" />
                {/* Playhead */}
                <line x1="180" y1="0" x2="180" y2="200" stroke="#cefc00" strokeWidth="2" opacity="0.6" />
                <polygon points="176,0 184,0 180,10" fill="#cefc00" opacity="0.8" />
                {/* Track 1 — aligned */}
                <g>
                  <rect x="50" y="30" width="300" height="28" rx="4" fill="#262528" stroke="#cefc00" strokeWidth="0.5" opacity="0.8" />
                  <text x="58" y="48" fill="#cefc00" fontSize="9" fontFamily="Inter" opacity="0.8">Camera 1</text>
                  <path d="M100,44 Q110,30 120,44 Q130,58 140,44 Q150,28 160,44 Q170,60 180,44 Q190,32 200,44 Q210,54 220,44 Q230,34 240,44 Q250,56 260,44 Q270,36 280,44 Q290,52 300,44" fill="none" stroke="#65fde6" strokeWidth="1.5" opacity="0.8" />
                </g>
                {/* Track 2 — aligned */}
                <g>
                  <rect x="50" y="72" width="300" height="28" rx="4" fill="#262528" stroke="#c180ff" strokeWidth="0.5" opacity="0.8" />
                  <text x="58" y="90" fill="#c180ff" fontSize="9" fontFamily="Inter" opacity="0.8">Camera 2</text>
                  <path d="M100,86 Q110,72 120,86 Q130,100 140,86 Q150,70 160,86 Q170,102 180,86 Q190,74 200,86 Q210,96 220,86 Q230,76 240,86 Q250,98 260,86 Q270,78 280,86 Q290,94 300,86" fill="none" stroke="#c180ff" strokeWidth="1.5" opacity="0.8" />
                </g>
                {/* Track 3 — aligned */}
                <g>
                  <rect x="50" y="114" width="300" height="28" rx="4" fill="#262528" stroke="#65fde6" strokeWidth="0.5" opacity="0.8" />
                  <text x="58" y="132" fill="#65fde6" fontSize="9" fontFamily="Inter" opacity="0.8">Camera 3</text>
                  <path d="M100,128 Q110,114 120,128 Q130,142 140,128 Q150,112 160,128 Q170,144 180,128 Q190,116 200,128 Q210,138 220,128 Q230,118 240,128 Q250,140 260,128 Q270,120 280,128 Q290,136 300,128" fill="none" stroke="#65fde6" strokeWidth="1.5" opacity="0.8" />
                </g>
                {/* Alignment lines showing sync */}
                <line x1="100" y1="44" x2="100" y2="128" stroke="#cefc00" strokeWidth="0.5" strokeDasharray="4,3" opacity="0.3" />
                <line x1="200" y1="44" x2="200" y2="128" stroke="#cefc00" strokeWidth="0.5" strokeDasharray="4,3" opacity="0.3" />
                <line x1="300" y1="44" x2="300" y2="128" stroke="#cefc00" strokeWidth="0.5" strokeDasharray="4,3" opacity="0.3" />
                {/* Label */}
                <text x="200" y="170" fill="#cefc00" fontSize="10" fontFamily="Inter" textAnchor="middle" opacity="0.5">Tracks aligned by audio</text>
              </svg>
              {/* Recommended badge */}
              <span className="absolute top-4 right-4 bg-primary-container text-on-primary-container text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded z-10">
                Recommended
              </span>
            </div>
            <div className="p-6">
              <div className="flex items-center justify-between mb-3">
                <span className={`font-headline font-bold text-lg ${
                  selected ? 'text-primary-container' : 'text-on-surface'
                }`}>
                  Sync it
                </span>
                {/* Radio */}
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  selected
                    ? 'bg-primary-container border-primary-container'
                    : 'border-outline'
                }`}>
                  {selected && (
                    <span className="material-symbols-outlined text-on-primary-container text-sm">check</span>
                  )}
                </div>
              </div>
              <p className="text-on-surface text-sm">
                Automatically align audio tracks using waveform matching.
              </p>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="mt-8 px-8 py-6 bg-surface-container-high flex items-center justify-between">
          <button
            onClick={onBack}
            className="font-label text-sm font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-bright px-4 py-2 rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="bg-gradient-to-br from-primary-container to-primary-dim text-on-primary-container font-extrabold uppercase tracking-widest text-sm px-8 py-3 rounded-xl hover:shadow-[0_0_15px_rgba(206,252,0,0.3)] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Starting...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
