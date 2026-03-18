import { useParams, Link } from 'react-router-dom'
import { useState } from 'react'
import { useApi, apiPost } from '../../hooks/useApi.js'
import DiffPanel from '../shared/DiffPanel.jsx'
import ScoreCard from '../shared/ScoreCard.jsx'

export default function RunDetailView() {
  const { runId } = useParams()
  const { data: run, loading } = useApi(`/experiments/runs/${runId}`)
  const [activeStage, setActiveStage] = useState(0)

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>
  if (!run) return <div className="p-6 text-red-400 text-sm">Run not found</div>

  const stages = run.stages || []
  const currentStage = stages[activeStage]
  const stageMetrics = run.metrics?.filter(m => m.stage_index === activeStage) || []
  const humanVsCurrent = stageMetrics.find(m => m.comparison_type === 'human_vs_current')
  const stageDiff = run.stageDiffs?.[activeStage]

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div>
        <div className="text-sm text-zinc-500 mb-1">
          <Link to="/experiments" className="hover:text-zinc-300">Experiments</Link>
          <span className="mx-2">&rarr;</span>
          {run.experiment_name}
        </div>
        <h2 className="text-xl font-semibold">{run.video_title}</h2>
        <div className="text-sm text-zinc-400 mt-1 flex gap-4">
          <span>{run.strategy_name} v{run.version_number}</span>
          <span>Run #{run.run_number}</span>
          <StatusBadge status={run.status} />
          {run.total_runtime_ms && <span>{(run.total_runtime_ms / 1000).toFixed(1)}s</span>}
          {run.total_tokens && <span>{run.total_tokens} tokens</span>}
          {run.total_cost && <span>${run.total_cost.toFixed(4)}</span>}
        </div>
      </div>

      {/* Score card + reason-aware accuracy */}
      {run.scoreBreakdown && (
        <div className="grid grid-cols-2 gap-4">
          <ScoreCard score={run.scoreBreakdown} />
          <ReasonAccuracy scores={run.scoreBreakdown} />
        </div>
      )}

      {/* Stage pipeline */}
      <div>
        <h3 className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Stage Pipeline</h3>
        <div className="flex gap-1 overflow-x-auto">
          {stages.map((stage, i) => {
            const m = run.metrics?.find(m => m.stage_index === i && m.comparison_type === 'human_vs_current')
            return (
              <button
                key={i}
                onClick={() => setActiveStage(i)}
                className={`shrink-0 px-3 py-2 rounded text-sm transition-colors ${
                  activeStage === i
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                <div className="font-medium">{stage.stage_name}</div>
                {m && (
                  <div className="text-xs mt-0.5">
                    <span className={simColor(m.similarity_percent)}>{m.similarity_percent}%</span>
                    {m.delta_vs_previous_stage !== null && (
                      <span className={`ml-1 ${m.delta_vs_previous_stage < 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        ({m.delta_vs_previous_stage > 0 ? '+' : ''}{m.delta_vs_previous_stage}pp)
                      </span>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Stage metrics summary */}
      {humanVsCurrent && (
        <div className="grid grid-cols-4 gap-3">
          <StatBox label="Similarity" value={`${humanVsCurrent.similarity_percent}%`} color={simColor(humanVsCurrent.similarity_percent)} />
          <StatBox label="Diff" value={`${humanVsCurrent.diff_percent}%`} />
          <StatBox
            label="Delta vs Prev"
            value={humanVsCurrent.delta_vs_previous_stage !== null ? `${humanVsCurrent.delta_vs_previous_stage > 0 ? '+' : ''}${humanVsCurrent.delta_vs_previous_stage}pp` : '—'}
            color={humanVsCurrent.delta_vs_previous_stage < 0 ? 'text-emerald-400' : humanVsCurrent.delta_vs_previous_stage > 0 ? 'text-red-400' : ''}
          />
          <StatBox label="Timecodes" value={`${Math.round(humanVsCurrent.timecode_preservation_score * 100)}%`} />
        </div>
      )}

      {/* Stage detail tabs */}
      {currentStage && <StageDetail stage={currentStage} diff={stageDiff?.diff} human={run.human} raw={run.raw} />}

      {/* AI Analysis */}
      <AnalysisPanel runId={runId} />

      {/* All stages progression table */}
      {stages.length > 1 && (
        <div>
          <h3 className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Stage Progression (Human vs Current)</h3>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 text-left">
                  <th className="px-3 py-1.5">Stage</th>
                  <th className="px-3 py-1.5 text-right">Diff %</th>
                  <th className="px-3 py-1.5 text-right">Similarity %</th>
                  <th className="px-3 py-1.5 text-right">Delta</th>
                  <th className="px-3 py-1.5 text-right">Timecodes</th>
                  <th className="px-3 py-1.5 text-right">Pauses</th>
                  <th className="px-3 py-1.5 text-right">Tokens</th>
                  <th className="px-3 py-1.5 text-right">Runtime</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage, i) => {
                  const m = run.metrics?.find(m => m.stage_index === i && m.comparison_type === 'human_vs_current')
                  return (
                    <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer" onClick={() => setActiveStage(i)}>
                      <td className="px-3 py-1.5 text-zinc-300">{stage.stage_name}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-400">{m?.diff_percent ?? '—'}%</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={simColor(m?.similarity_percent)}>{m?.similarity_percent ?? '—'}%</span>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {m?.delta_vs_previous_stage !== null && m?.delta_vs_previous_stage !== undefined ? (
                          <span className={m.delta_vs_previous_stage < 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {m.delta_vs_previous_stage > 0 ? '+' : ''}{m.delta_vs_previous_stage}pp
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right text-zinc-400">{m ? Math.round(m.timecode_preservation_score * 100) + '%' : '—'}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-400">{m ? Math.round(m.pause_marker_preservation_score * 100) + '%' : '—'}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-500">{stage.tokens_in + stage.tokens_out || '—'}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-500">{stage.runtime_ms ? `${(stage.runtime_ms / 1000).toFixed(1)}s` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ReasonAccuracy({ scores }) {
  if (!scores?.reasonScores) return null
  const reasons = ['filler_word', 'false_start', 'meta_commentary']
  const labels = { filler_word: 'Filler Words', false_start: 'False Starts', meta_commentary: 'Meta Commentary' }
  const colors = { filler_word: 'text-orange-400', false_start: 'text-purple-400', meta_commentary: 'text-cyan-400' }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <div className="text-sm font-medium text-zinc-300">Reason-Aware Accuracy</div>
      <div className="space-y-2">
        {reasons.map(r => {
          const s = scores.reasonScores[r]
          if (!s || s.humanTotal === 0) return null
          return (
            <div key={r} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className={colors[r]}>{labels[r]}</span>
                <span className="text-zinc-300">{s.accuracy !== null ? Math.round(s.accuracy * 100) + '%' : '—'} <span className="text-zinc-500">({s.correct}/{s.humanTotal})</span></span>
              </div>
              {s.accuracy !== null && (
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${Math.round(s.accuracy * 100) >= 80 ? 'bg-emerald-500' : Math.round(s.accuracy * 100) >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.round(s.accuracy * 100)}%` }} />
                </div>
              )}
              <div className="flex gap-3 text-[10px] text-zinc-500">
                <span>Correct: <span className="text-emerald-400">{s.correct}</span></span>
                <span>Missed: <span className="text-amber-400">{s.missed}</span></span>
                <span>Wrong: <span className="text-red-400">{s.wrong}</span></span>
              </div>
            </div>
          )
        })}
      </div>
      {scores.deletions && (
        <div className="pt-2 border-t border-zinc-800 grid grid-cols-3 gap-2 text-center text-xs">
          <div><div className="text-emerald-400 font-bold">{scores.deletions.correct}</div><div className="text-zinc-500">Correct</div></div>
          <div><div className="text-amber-400 font-bold">{scores.deletions.missed}</div><div className="text-zinc-500">Missed</div></div>
          <div><div className="text-red-400 font-bold">{scores.deletions.wrong}</div><div className="text-zinc-500">Wrong</div></div>
        </div>
      )}
    </div>
  )
}

function StageDetail({ stage, diff, human, raw }) {
  const [tab, setTab] = useState('comparison')

  return (
    <div className="space-y-2">
      <div className="flex gap-1 border-b border-zinc-800">
        {['comparison', 'diff', 'output', 'prompt', 'metadata'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs transition-colors capitalize ${
              tab === t ? 'text-white border-b-2 border-white' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t === 'comparison' ? '3-Way Compare' : t}
          </button>
        ))}
      </div>

      {tab === 'comparison' && (
        <ThreeWayComparison raw={raw} human={human} current={stage.output_text} stageName={stage.stage_name} />
      )}

      {tab === 'diff' && diff && (
        <DiffPanel diff={diff} title={`Human Edited vs ${stage.stage_name} Output`} showReasons={false} />
      )}

      {tab === 'output' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
          <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400">Stage Output</div>
          <pre className="p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-auto">{stage.output_text}</pre>
        </div>
      )}

      {tab === 'prompt' && (
        <div className="space-y-3">
          {stage.system_instruction_used && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
              <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400">System Instruction</div>
              <pre className="p-4 text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-auto text-zinc-300">{stage.system_instruction_used}</pre>
            </div>
          )}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
            <div className="px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400">Prompt Used</div>
            <pre className="p-4 text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-auto text-zinc-300">{stage.prompt_used}</pre>
          </div>
        </div>
      )}

      {tab === 'metadata' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <MetaRow label="Model" value={stage.model} />
            <MetaRow label="Parameters" value={stage.params_json} />
            <MetaRow label="Tokens In" value={stage.tokens_in} />
            <MetaRow label="Tokens Out" value={stage.tokens_out} />
            <MetaRow label="Cost" value={stage.cost ? `$${stage.cost.toFixed(6)}` : '—'} />
            <MetaRow label="Runtime" value={stage.runtime_ms ? `${(stage.runtime_ms / 1000).toFixed(1)}s` : '—'} />
            <MetaRow label="Input Length" value={`${stage.input_text?.length || 0} chars`} />
            <MetaRow label="Output Length" value={`${stage.output_text?.length || 0} chars`} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 3-way comparison: Raw / Human Edited / Current Stage output
 * Shows all three transcripts side by side with color-coded word-level diffs.
 */
function ThreeWayComparison({ raw, human, current, stageName }) {
  if (!raw || !human || !current) {
    return <div className="text-zinc-500 text-sm p-4">All three transcripts needed for comparison.</div>
  }

  // Tokenize into words preserving whitespace
  const rawWords = tokenize(raw)
  const humanWords = tokenize(human)
  const currentWords = tokenize(current)

  // Build sets for quick lookup
  const humanSet = new Set(humanWords.map((w, i) => `${i}:${w.toLowerCase()}`))
  const rawSet = new Set(rawWords.map((w, i) => `${i}:${w.toLowerCase()}`))

  // Compute which words in raw are removed in human (human edit deletions)
  const rawToHuman = alignWords(rawWords, humanWords)
  const rawToCurrent = alignWords(rawWords, currentWords)
  const humanToCurrent = alignWords(humanWords, currentWords)

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Raw transcript */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium flex items-center justify-between">
          <span>Raw Transcript</span>
          <span className="text-blue-400">Original</span>
        </div>
        <div className="p-3 text-xs font-mono leading-relaxed max-h-[500px] overflow-auto whitespace-pre-wrap">
          {rawWords.map((word, i) => {
            const inHuman = rawToHuman[i]
            const inCurrent = rawToCurrent[i]
            // Word removed by human AND by current = correct removal (green)
            // Word removed by human but NOT by current = missed removal (amber)
            // Word NOT removed by human but removed by current = wrong removal (red)
            // Word kept by both = neutral
            if (!inHuman && !inCurrent) {
              return <span key={i} className="bg-emerald-900/40 text-emerald-300 rounded px-0.5" title="Correctly removed by both">{word} </span>
            }
            if (!inHuman && inCurrent) {
              return <span key={i} className="bg-amber-900/40 text-amber-300 rounded px-0.5" title="Human removed, current kept (missed)">{word} </span>
            }
            if (inHuman && !inCurrent) {
              return <span key={i} className="bg-red-900/40 text-red-300 rounded px-0.5" title="Human kept, current removed (wrong)">{word} </span>
            }
            return <span key={i}>{word} </span>
          })}
        </div>
      </div>

      {/* Human edited */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium flex items-center justify-between">
          <span>Human Edited</span>
          <span className="text-purple-400">Ground Truth</span>
        </div>
        <div className="p-3 text-xs font-mono leading-relaxed max-h-[500px] overflow-auto whitespace-pre-wrap">
          {humanWords.map((word, i) => {
            const inCurrent = humanToCurrent[i]
            if (!inCurrent) {
              // Word in human but not in current = current wrongly removed
              return <span key={i} className="bg-red-900/40 text-red-300 rounded px-0.5" title="Current removed this (wrong)">{word} </span>
            }
            return <span key={i}>{word} </span>
          })}
        </div>
      </div>

      {/* Current stage output */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium flex items-center justify-between">
          <span>{stageName} Output</span>
          <span className="text-violet-400">Current</span>
        </div>
        <div className="p-3 text-xs font-mono leading-relaxed max-h-[500px] overflow-auto whitespace-pre-wrap">
          {currentWords.map((word, i) => {
            // Check if this word exists in human
            const inHuman = alignedContains(humanWords, currentWords, i)
            if (!inHuman) {
              // Word in current but not in human = added or kept wrongly
              return <span key={i} className="bg-amber-900/40 text-amber-300 rounded px-0.5" title="Not in human edit (extra)">{word} </span>
            }
            return <span key={i}>{word} </span>
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="col-span-3 flex gap-4 text-xs text-zinc-500 px-1">
        <span><span className="inline-block w-3 h-3 rounded bg-emerald-900/60 mr-1 align-middle" /> Correctly removed</span>
        <span><span className="inline-block w-3 h-3 rounded bg-amber-900/60 mr-1 align-middle" /> Missed / Extra</span>
        <span><span className="inline-block w-3 h-3 rounded bg-red-900/60 mr-1 align-middle" /> Wrongly removed</span>
        <span className="ml-auto text-zinc-600">Word-level alignment (approximate)</span>
      </div>
    </div>
  )
}

// Simple word tokenizer
function tokenize(text) {
  if (!text) return []
  return text.split(/\s+/).filter(w => w.length > 0)
}

// Greedy word alignment: returns array[i] = true if word at index i in `source` is found in `target`
function alignWords(source, target) {
  const result = new Array(source.length).fill(false)
  const targetNorm = target.map(w => w.toLowerCase().replace(/[^\w]/g, ''))
  let targetIdx = 0

  for (let i = 0; i < source.length; i++) {
    const srcWord = source[i].toLowerCase().replace(/[^\w]/g, '')
    if (!srcWord) continue

    // Look for this word in target starting from current position (within window)
    let found = false
    for (let j = targetIdx; j < Math.min(targetIdx + 30, targetNorm.length); j++) {
      if (targetNorm[j] === srcWord) {
        result[i] = true
        targetIdx = j + 1
        found = true
        break
      }
    }
    if (!found) {
      result[i] = false
    }
  }
  return result
}

// Check if a word at position `idx` in `current` exists in `reference`
function alignedContains(reference, current, idx) {
  const word = current[idx]?.toLowerCase().replace(/[^\w]/g, '')
  if (!word) return false
  const refNorm = reference.map(w => w.toLowerCase().replace(/[^\w]/g, ''))
  return refNorm.includes(word)
}

function AnalysisPanel({ runId }) {
  const { data: analyses, loading, refetch } = useApi(`/experiments/runs/${runId}/analysis`)
  const [analyzing, setAnalyzing] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [customSystem, setCustomSystem] = useState('You are an expert transcript analysis assistant.')
  const [customPrompt, setCustomPrompt] = useState(
    'Analyze this transcript cleaning workflow run. Focus on what worked well and what could be improved.\n\n{{workflow}}\n\nProvide 3-5 concise bullet points.'
  )
  const [includeRaw, setIncludeRaw] = useState(false)
  const [includeOutputs, setIncludeOutputs] = useState(false)

  async function handleAnalyze(custom = false) {
    setAnalyzing(true)
    try {
      const body = custom ? {
        system_prompt: customSystem,
        user_prompt: customPrompt,
        include_raw_transcript: includeRaw,
        include_stage_outputs: includeOutputs,
      } : {}
      await apiPost(`/experiments/runs/${runId}/analyze`, body)
      refetch()
    } catch (err) {
      alert(err.message)
    } finally {
      setAnalyzing(false)
    }
  }

  const crossStage = analyses?.find(a => a.analysis_type === 'cross_stage')
  const stageAnalyses = analyses?.filter(a => a.analysis_type === 'stage') || []

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs text-zinc-500 uppercase tracking-wide">AI Analysis</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCustom(!showCustom)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showCustom ? 'Hide Custom' : 'Custom Prompt'}
          </button>
          <button
            onClick={() => handleAnalyze(false)}
            disabled={analyzing}
            className="text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors disabled:opacity-50"
          >
            {analyzing ? 'Analyzing...' : analyses?.length > 0 ? 'Re-analyze' : 'Analyze Run'}
          </button>
        </div>
      </div>

      {showCustom && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mb-3 space-y-2">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">System Prompt</label>
            <textarea
              value={customSystem}
              onChange={e => setCustomSystem(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-zinc-600"
              rows={2}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-zinc-500">User Prompt</label>
              <div className="flex gap-1">
                {['{{workflow}}', '{{raw_transcript}}', '{{stage_outputs}}'].map(tag => (
                  <button key={tag} type="button"
                    onClick={() => setCustomPrompt(prev => prev + '\n' + tag)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 font-mono"
                  >{tag}</button>
                ))}
              </div>
            </div>
            <textarea
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-zinc-600"
              rows={5}
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={includeRaw} onChange={e => setIncludeRaw(e.target.checked)} className="rounded" />
              Include raw transcript
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={includeOutputs} onChange={e => setIncludeOutputs(e.target.checked)} className="rounded" />
              Include stage outputs
            </label>
            <button
              onClick={() => handleAnalyze(true)}
              disabled={analyzing}
              className="ml-auto text-xs bg-white text-black px-3 py-1 rounded font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors"
            >
              {analyzing ? 'Running...' : 'Run Custom Analysis'}
            </button>
          </div>
        </div>
      )}

      {loading && <div className="text-zinc-500 text-sm">Loading...</div>}

      {crossStage && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-3">
          <div className="text-xs text-zinc-500 mb-2">Overall Analysis {crossStage.model_used && <span className="text-zinc-600">({crossStage.model_used})</span>}</div>
          <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed text-zinc-300">{crossStage.content}</pre>
        </div>
      )}

      {stageAnalyses.length > 0 && (
        <div className="space-y-2">
          {stageAnalyses.map(a => (
            <div key={a.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
              <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed text-zinc-400">{a.content}</pre>
            </div>
          ))}
        </div>
      )}

      {!loading && (!analyses || analyses.length === 0) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-center text-zinc-500 text-sm">
          No analysis yet. Click "Analyze Run" to generate insights.
        </div>
      )}
    </div>
  )
}

function MetaRow({ label, value }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-zinc-300 mt-0.5">{value || '—'}</div>
    </div>
  )
}

function StatBox({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  )
}

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    running: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function simColor(pct) {
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}
