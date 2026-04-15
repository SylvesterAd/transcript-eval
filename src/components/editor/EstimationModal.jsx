import { Loader2 } from 'lucide-react'

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m === 0) return `${s}s`
  if (s === 0) return `${m}m`
  return `${m}m ${s}s`
}

export default function EstimationModal({ estimation, onAccept, onDecline, loading }) {
  const { tokenCost, estimatedTimeSeconds, balance, sufficient } = estimation

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4" onClick={onDecline}>
      <div
        className="w-full max-w-2xl bg-surface-container-low rounded-xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] overflow-hidden border border-white/5"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-8 pt-8 pb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-2xl font-extrabold font-headline tracking-tight text-on-surface">
              AI Rough Cut Estimation
            </h2>
            <span className="px-2 py-1 rounded bg-secondary/20 text-secondary text-[10px] font-bold tracking-widest uppercase">
              AI Enhanced
            </span>
          </div>
          <p className="text-on-surface-variant text-sm max-w-md">
            Our AI models will analyze your footage. Here is the predicted output structure and resource estimation.
          </p>
        </div>

        {/* Content */}
        <div className="px-8 pb-8 space-y-6">
          {/* What to expect */}
          <div className="space-y-3">
            <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 font-label">What to expect</label>
            <div className="grid grid-cols-2 gap-4">
              {/* Before */}
              <div className="bg-surface-container-high rounded-lg p-4 h-48 flex flex-col">
                <span className="text-[10px] font-bold text-zinc-400 mb-3 uppercase">Before</span>
                <div className="text-xs text-on-surface-variant space-y-2 leading-relaxed overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
                  <p>"So, um, I was thinking about the project... [pause] and I think we should, like, start with the intro. Um, let's look at the data first."</p>
                  <p>"Actually, wait, let me rephrase that. The data is the most important part of this whole sequence."</p>
                </div>
              </div>
              {/* After */}
              <div className="bg-surface-container-high rounded-lg p-4 h-48 flex flex-col border border-primary/5">
                <span className="text-[10px] font-bold text-primary mb-3 uppercase">After</span>
                <div className="text-xs text-on-surface space-y-2 leading-relaxed overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
                  <p>
                    <span className="text-error line-through opacity-50">"So, um, I was thinking about the project... [pause] and I think we should, like,"</span>
                    {' '}<span>"Start with the intro."</span>
                    {' '}<span className="text-error line-through opacity-50">"Um, let's look at the data first."</span>
                  </p>
                  <p>"The data is the most important part of this whole sequence."</p>
                </div>
              </div>
            </div>
          </div>

          {/* Statistics Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-surface-container rounded-lg flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary text-xl">timer</span>
              </div>
              <div>
                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-tight">Estimated Time</p>
                <p className="text-lg font-bold font-headline text-on-surface">{formatTime(estimatedTimeSeconds)}</p>
              </div>
            </div>
            <div className="p-4 bg-surface-container rounded-lg flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-secondary/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-secondary text-xl">token</span>
              </div>
              <div>
                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-tight">Token Usage</p>
                <p className="text-lg font-bold font-headline text-on-surface">~{tokenCost.toLocaleString()} tokens</p>
              </div>
            </div>
          </div>

          {/* Insufficient tokens warning */}
          {!sufficient && (
            <div className="p-3 rounded-lg bg-error-container/20 border border-error/20 flex items-center gap-3">
              <span className="material-symbols-outlined text-error text-lg">warning</span>
              <p className="text-xs text-error">
                Not enough tokens. You need <span className="font-bold">{tokenCost.toLocaleString()}</span> but have <span className="font-bold">{balance.toLocaleString()}</span>.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-6 bg-surface-container-high/50 flex flex-row-reverse gap-4 items-center">
          <button
            onClick={onAccept}
            disabled={!sufficient || loading}
            className="px-6 py-3 bg-gradient-to-br from-primary to-primary-fixed-dim text-on-primary-fixed font-bold font-headline rounded-md active:scale-95 transition-all duration-150 shadow-lg shadow-primary/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center gap-2"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            Accept & Start Edit
          </button>
          <button
            onClick={onDecline}
            disabled={loading}
            className="px-6 py-3 text-on-surface-variant font-semibold font-headline hover:text-on-surface hover:bg-white/5 rounded-md transition-all"
          >
            Decline & Back
          </button>
        </div>
      </div>
    </div>
  )
}
