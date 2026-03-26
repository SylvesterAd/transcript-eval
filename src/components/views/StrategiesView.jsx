import { useState, useRef } from 'react'
import { useApi, apiPost, apiPut, apiDelete } from '../../hooks/useApi.js'
import { previewAugmentedSystem, updateSegmentRulesInSystem, hasSegmentRules, stripSegmentRules } from '../../lib/promptPreview.js'
import { Plus, ChevronDown, ChevronRight, Trash2, ArrowUp, ArrowDown, Bot, Layers, Cpu, Pencil, Copy, Loader2, Sparkles, Send, Check, RotateCcw, MessageCircleQuestion } from 'lucide-react'

const MODELS = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'gemini' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', provider: 'gemini' },
  { id: 'gpt-5.4', label: 'GPT 5.4', provider: 'openai' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4.6', provider: 'anthropic' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
]

const THINKING_LEVELS = ['OFF', 'LOW', 'MEDIUM', 'HIGH']

const SEGMENT_PRESETS = {
  short:  { label: 'Short (40–60s)',   minSeconds: 40,  maxSeconds: 60,  contextSeconds: 30 },
  medium: { label: 'Medium (60–100s)', minSeconds: 60,  maxSeconds: 100, contextSeconds: 30 },
  long:   { label: 'Long (100–130s)',  minSeconds: 100, maxSeconds: 130, contextSeconds: 30 },
}

const TEMPLATE_VARS = [
  { tag: '<transcript>', desc: 'Full transcript text' },
  { tag: '{{transcript}}', desc: 'Full transcript (mustache)' },
  { tag: '{{segment_number}}', desc: 'Current segment #' },
  { tag: '{{total_segments}}', desc: 'Total segments' },
  { tag: '{{llm_answer}}', desc: 'Output from most recent LLM Question stage' },
]

export default function StrategiesView() {
  const { data: strategies, loading, refetch } = useApi('/strategies')
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Flows</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 text-sm bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded transition-colors"
        >
          <Plus size={14} />
          New Flow
        </button>
      </div>

      {showCreate && <CreateStrategyForm onCreated={() => { setShowCreate(false); refetch() }} />}

      {strategies?.length === 0 ? (
        <p className="text-zinc-500 text-sm">No flows defined yet. Create one to build an LLM pipeline.</p>
      ) : (
        <div className="space-y-3">
          {strategies?.map(s => (
            <FlowCard
              key={s.id}
              strategy={s}
              expanded={expandedId === s.id}
              onToggle={() => setExpandedId(expandedId === s.id ? null : s.id)}
              onRefetch={refetch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FlowCard({ strategy, expanded, onToggle, onRefetch }) {
  const [editing, setEditing] = useState(false)
  const [summarizing, setSummarizing] = useState(false)

  const stages = JSON.parse(strategy.stages_json || '[]')
  const stageCount = stages.length
  const updatedAt = strategy.updated_at || strategy.created_at

  async function handleDelete(e) {
    e.stopPropagation()
    if (!confirm(`Delete flow "${strategy.name}"? This cannot be undone.`)) return
    try {
      await apiDelete(`/strategies/${strategy.id}`)
      onRefetch()
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleDuplicate(e) {
    e.stopPropagation()
    try {
      const newStrategy = await apiPost('/strategies', { name: `${strategy.name} (copy)`, description: strategy.description })
      await apiPost(`/strategies/${newStrategy.id}/versions`, { stages, notes: 'Duplicated from ' + strategy.name })
      onRefetch()
    } catch (err) {
      alert(err.message)
    }
  }

  async function handleSummarize(e) {
    e.stopPropagation()
    setSummarizing(true)
    try {
      await apiPost(`/strategies/${strategy.id}/summarize`)
      onRefetch()
    } catch (err) {
      alert(err.message)
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="p-4 flex items-center justify-between cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {expanded ? <ChevronDown size={16} className="text-zinc-500 shrink-0" /> : <ChevronRight size={16} className="text-zinc-500 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{strategy.name}</div>
            <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-2">
              <span>{stageCount} stage{stageCount !== 1 ? 's' : ''}</span>
              <span>·</span>
              <span>{new Date(updatedAt).toLocaleDateString()}</span>
              {strategy.description ? (
                <span className="text-zinc-400 truncate">· {strategy.description}</span>
              ) : (
                <button onClick={handleSummarize} disabled={summarizing}
                  className="text-zinc-600 hover:text-zinc-300 flex items-center gap-1 transition-colors">
                  {summarizing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                  {summarizing ? 'Generating...' : 'Generate summary'}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
          {strategy.description && (
            <button onClick={handleSummarize} disabled={summarizing}
              className="text-zinc-600 hover:text-zinc-300 p-1 transition-colors" title="Regenerate summary">
              {summarizing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            </button>
          )}
          <button onClick={handleDuplicate} className="text-zinc-600 hover:text-zinc-300 p-1 transition-colors" title="Duplicate flow">
            <Copy size={14} />
          </button>
          <button onClick={handleDelete} className="text-zinc-600 hover:text-red-400 p-1 transition-colors" title="Delete flow">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {editing ? (
            <StageEditor
              strategyId={strategy.id}
              editingVersion={{ id: strategy.latest_version_id, stages_json: strategy.stages_json, notes: '' }}
              onSaved={() => { setEditing(false); onRefetch() }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              {stages.length === 0 ? (
                <p className="text-xs text-zinc-500">No stages defined.</p>
              ) : (
                <StagePipeline stages={stages} />
              )}
              <button onClick={() => setEditing(true)}
                className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white transition-colors">
                <Pencil size={12} /> Edit Flow
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function StagePipeline({ stages }) {
  return (
    <div className="space-y-3">
      {stages.map((stage, i) => (
        <div key={i} className="bg-zinc-800/50 rounded p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300">Stage {i + 1}</span>
            <StageBadge type={stage.type} />
            <span className="text-sm font-medium">{stage.name}</span>
            {stage.model && stage.model !== 'programmatic' && (
              <span className="text-xs text-zinc-500">{MODELS.find(m => m.id === stage.model)?.label || stage.model}</span>
            )}
            {stage.output_mode && stage.output_mode !== 'passthrough' && (
              <span className={`text-xs px-1.5 py-0.5 rounded ${
                stage.output_mode === 'deletion'
                  ? 'bg-red-900/30 border border-red-800 text-red-300'
                  : 'bg-emerald-900/30 border border-emerald-800 text-emerald-300'
              }`}>
                {stage.output_mode === 'deletion' ? 'Deletion' : 'Keep Only'}
              </span>
            )}
            {(stage.type === 'llm' || stage.type === 'llm_parallel' || stage.type === 'llm_question') && (
              <span className="text-xs text-zinc-600 ml-auto">
                {stage.type === 'llm' ? 'Whole transcript' : stage.type === 'llm_parallel' ? 'Per segment' : 'Question → {{llm_answer}}'}
              </span>
            )}
          </div>
          {stage.type === 'programmatic' && (
            <div className="text-xs text-zinc-400">{stage.action === 'reassemble' ? 'Reassemble segments' : (stage.description || 'Segment transcript')}</div>
          )}
          {stage.type !== 'programmatic' && stage.description && <div className="text-xs text-zinc-400">{stage.description}</div>}
          {stage.type === 'programmatic' && stage.action === 'segment' && stage.actionParams && (
            <div className="flex flex-wrap gap-2">
              {stage.actionParams.preset ? (
                <span className="text-xs bg-zinc-800 border border-zinc-700 px-2 py-0.5 rounded text-zinc-400">
                  {SEGMENT_PRESETS[stage.actionParams.preset]?.label || stage.actionParams.preset} · {stage.actionParams.contextSeconds}s context
                </span>
              ) : (
                Object.entries(stage.actionParams).map(([k, v]) => (
                  <span key={k} className="text-xs bg-zinc-800 border border-zinc-700 px-2 py-0.5 rounded text-zinc-400">
                    {k}: {v}
                  </span>
                ))
              )}
            </div>
          )}
          {(stage.type === 'llm' || stage.type === 'llm_parallel' || stage.type === 'llm_question') && (
            <>
              {(stage.system_instruction || stage.output_mode) && (
                <div>
                  <div className="text-xs text-zinc-500 mb-1">System Prompt {stage.type !== 'llm_question' && <span className="text-zinc-600">(with auto-appended output mode rules)</span>}</div>
                  <pre className="text-xs text-zinc-400 bg-zinc-900 rounded p-2 whitespace-pre-wrap max-h-32 overflow-auto">{stage.type === 'llm_question' ? stage.system_instruction : previewAugmentedSystem(stage.system_instruction, stage.output_mode, stage.type)}</pre>
                </div>
              )}
              {stage.prompt && (
                <div>
                  <div className="text-xs text-zinc-500 mb-1">User Prompt</div>
                  <pre className="text-xs text-zinc-400 bg-zinc-900 rounded p-2 whitespace-pre-wrap max-h-32 overflow-auto">{stage.prompt}</pre>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function StageEditor({ strategyId, editingVersion, onSaved, onCancel }) {
  const isEditing = !!editingVersion
  const initialStages = isEditing
    ? JSON.parse(editingVersion.stages_json || '[]').map(s => {
        // Migrate: inject segment rules into llm_parallel stages that don't have them yet
        if (s.type === 'llm_parallel' && !hasSegmentRules(s.system_instruction)) {
          return { ...s, system_instruction: updateSegmentRulesInSystem(s.system_instruction, s.output_mode) }
        }
        return s
      })
    : [{ name: 'Stage 1', type: 'llm', prompt: '', system_instruction: '', model: 'claude-sonnet-4-20250514', params: {} }]

  const [stages, setStages] = useState(initialStages)
  const [saving, setSaving] = useState(false)

  const stageOps = makeStageOps(stages, setStages)
  const { addStage, removeStage, moveStage, updateStage, duplicateStage, insertStage } = stageOps

  function insertTemplate(stageIndex, field, template) {
    const prefix = isEditing ? '' : 'new-'
    const textarea = document.querySelector(`[data-stage="${prefix}${stageIndex}"][data-field="${field}"]`)
    const stage = stages[stageIndex]
    const currentValue = stage[field] || ''
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = currentValue.slice(0, start) + template + currentValue.slice(end)
      updateStage(stageIndex, 'field_replace', { field, value: newValue })
      setTimeout(() => { textarea.focus(); textarea.setSelectionRange(start + template.length, start + template.length) }, 0)
    } else {
      updateStage(stageIndex, 'field_replace', { field, value: currentValue + template })
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      if (isEditing) {
        await apiPut(`/strategies/${strategyId}/versions/${editingVersion.id}`, { stages })
      } else {
        await apiPost(`/strategies/${strategyId}/versions`, { stages })
      }
      onSaved()
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const dataPrefix = isEditing ? '' : 'new-'

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500 uppercase tracking-wide">Pipeline Stages</div>
        {onCancel && <button type="button" onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>}
      </div>

      <StageList stages={stages} stageOps={stageOps} dataPrefix={dataPrefix} insertTemplate={insertTemplate} />

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button type="button" onClick={() => addStage('llm')}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
            <Plus size={12} /> Add LLM Run
          </button>
          <button type="button" onClick={() => addStage('llm_question')}
            className="flex items-center gap-1 text-xs text-pink-500/70 hover:text-pink-400 transition-colors">
            <Plus size={12} /> Add Question
          </button>
          <button type="button" onClick={() => addStage('programmatic')}
            className="flex items-center gap-1 text-xs text-amber-500/70 hover:text-amber-400 transition-colors">
            <Plus size={12} /> Add Segment Step
          </button>
        </div>

        <button type="submit" disabled={saving}
          className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function CreateStrategyForm({ onCreated }) {
  const [mode, setMode] = useState('ai') // ai | manual
  const [name, setName] = useState('')
  const [stages, setStages] = useState([{ name: 'Stage 1', type: 'llm', prompt: '', system_instruction: '', model: 'claude-sonnet-4-20250514', params: {} }])
  const [creating, setCreating] = useState(false)

  // AI state
  const [aiModel, setAiModel] = useState('gemini-3.1-pro-preview')
  const [aiInput, setAiInput] = useState('')
  const [aiHistory, setAiHistory] = useState([])
  const [aiProposal, setAiProposal] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const chatEndRef = useRef(null)

  const stageOps = makeStageOps(stages, setStages)
  const { addStage } = stageOps

  function insertTemplate(stageIndex, field, template) {
    const textarea = document.querySelector(`[data-stage="new-${stageIndex}"][data-field="${field}"]`)
    const stage = stages[stageIndex]; const currentValue = stage[field] || ''
    if (textarea) {
      const start = textarea.selectionStart; const end = textarea.selectionEnd
      const newValue = currentValue.slice(0, start) + template + currentValue.slice(end)
      stageOps.updateStage(stageIndex, 'field_replace', { field, value: newValue })
      setTimeout(() => { textarea.focus(); textarea.setSelectionRange(start + template.length, start + template.length) }, 0)
    } else { stageOps.updateStage(stageIndex, 'field_replace', { field, value: currentValue + template }) }
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const strategy = await apiPost('/strategies', { name: name.trim() })
      await apiPost(`/strategies/${strategy.id}/versions`, { stages })
      try { await apiPost(`/strategies/${strategy.id}/summarize`) } catch {}
      onCreated()
    } catch (err) { alert(err.message) }
    finally { setCreating(false) }
  }

  async function aiPropose(userMessage) {
    setAiLoading(true)
    setAiError(null)
    const newHistory = [...aiHistory]
    if (userMessage) newHistory.push({ role: 'user', content: userMessage })
    setAiHistory(newHistory)
    setAiInput('')
    try {
      const res = await apiPost('/strategies/ai-propose', {
        message: userMessage || undefined,
        history: newHistory.length > 0 ? newHistory : undefined,
        model: aiModel,
      })
      newHistory.push({ role: 'model', content: res.explanation || 'Here is the proposed workflow.' })
      setAiHistory(newHistory)
      setAiProposal({ name: res.name, explanation: res.explanation, stages: res.stages })
      if (!name) setName(res.name || '')
    } catch (err) {
      setAiError(err.message)
    } finally {
      setAiLoading(false)
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }

  async function aiRevise(feedback) {
    setAiProposal(null)
    await aiPropose(feedback)
  }

  async function handleAcceptProposal() {
    if (!aiProposal) return
    setCreating(true)
    try {
      const strategy = await apiPost('/strategies', {
        name: aiProposal.name || `AI Flow ${Date.now()}`,
        description: aiProposal.explanation || null,
      })
      await apiPost(`/strategies/${strategy.id}/versions`, { stages: aiProposal.stages, notes: 'AI-generated workflow' })
      onCreated()
    } catch (err) {
      setAiError(`Failed to save: ${err.message}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-300">New Flow</div>
        <div className="flex gap-1 text-xs">
          <button type="button" onClick={() => setMode('ai')}
            className={`px-2.5 py-1 rounded flex items-center gap-1 ${mode === 'ai' ? 'bg-violet-900/50 text-violet-300 border border-violet-700/50' : 'text-zinc-500 hover:text-zinc-300'}`}>
            <Sparkles size={11} /> AI Design
          </button>
          <button type="button" onClick={() => setMode('manual')}
            className={`px-2.5 py-1 rounded flex items-center gap-1 ${mode === 'manual' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
            <Cpu size={11} /> Manual
          </button>
        </div>
      </div>

      {mode === 'ai' && (
        <div className="space-y-3">
          {/* Chat history */}
          {aiHistory.length > 0 && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {aiHistory.map((msg, i) => (
                <div key={i} className={`text-xs px-3 py-2 rounded ${
                  msg.role === 'user' ? 'bg-zinc-800 text-zinc-300 ml-8' : 'bg-violet-900/20 border border-violet-800/30 text-violet-200 mr-8'
                }`}>{msg.content}</div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Proposal visualization */}
          {aiProposal && (
            <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-200">{aiProposal.name}</div>
                <span className="text-xs text-zinc-500">{aiProposal.stages.length} stages</span>
              </div>
              <div className="flex flex-wrap gap-1 items-center py-1">
                {aiProposal.stages.map((stage, i) => (
                  <div key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-zinc-600 text-xs">→</span>}
                    <span className={`text-xs px-2 py-1 rounded border ${
                      stage.type === 'programmatic' ? 'border-amber-800/50 bg-amber-900/20 text-amber-400' :
                      stage.type === 'llm_parallel' ? 'border-cyan-800/50 bg-cyan-900/20 text-cyan-400' :
                      stage.type === 'llm_question' ? 'border-pink-800/50 bg-pink-900/20 text-pink-400' :
                      'border-violet-800/50 bg-violet-900/20 text-violet-400'
                    }`}>{stage.name}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                {aiProposal.stages.map((stage, i) => (
                  <div key={i} className="bg-zinc-900/50 rounded p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] bg-zinc-700 px-1 py-0.5 rounded text-zinc-400">{i + 1}</span>
                      <StageBadge type={stage.type} />
                      <span className="text-xs font-medium text-zinc-300">{stage.name}</span>
                      {stage.model && <span className="text-[10px] text-zinc-500">{stage.model}</span>}
                    </div>
                    {stage.description && <div className="text-[11px] text-zinc-500 pl-6">{stage.description}</div>}
                    {stage.system_instruction && (
                      <div className="pl-6">
                        <div className="text-[10px] text-zinc-600">System:</div>
                        <pre className="text-[10px] text-zinc-500 whitespace-pre-wrap max-h-40 overflow-auto">{stage.system_instruction}</pre>
                      </div>
                    )}
                    {stage.prompt && (
                      <div className="pl-6">
                        <div className="text-[10px] text-zinc-600">Prompt:</div>
                        <pre className="text-[10px] text-zinc-500 whitespace-pre-wrap max-h-40 overflow-auto">{stage.prompt}</pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={handleAcceptProposal} disabled={creating}
                  className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50">
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Accept & Create Flow
                </button>
                <button type="button" onClick={() => { setAiHistory([]); setAiProposal(null); setAiError(null); setAiInput('') }}
                  className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded text-xs transition-colors">
                  <RotateCcw size={12} /> Start Over
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          {!aiProposal ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-zinc-500">Describe what kind of transcript processing you need, or let AI propose a default pipeline.</div>
                <select value={aiModel} onChange={e => setAiModel(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-violet-600 ml-2 shrink-0">
                  {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <input type="text" value={aiInput} onChange={e => setAiInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && aiInput.trim()) { e.preventDefault(); aiPropose(aiInput.trim()) } }}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-violet-600"
                  placeholder="e.g. Remove fillers, fix grammar, keep timecodes..." disabled={aiLoading} />
                <button type="button" onClick={() => aiPropose(aiInput.trim() || null)} disabled={aiLoading}
                  className="flex items-center gap-1 bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50">
                  {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  {aiInput.trim() ? 'Design' : 'Auto Propose'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <input type="text" value={aiInput} onChange={e => setAiInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && aiInput.trim()) { e.preventDefault(); aiRevise(aiInput.trim()) } }}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-violet-600"
                placeholder="Give feedback to revise..." disabled={aiLoading} />
              <button type="button" onClick={() => { if (aiInput.trim()) aiRevise(aiInput.trim()) }} disabled={aiLoading || !aiInput.trim()}
                className="flex items-center gap-1 bg-zinc-700 hover:bg-zinc-600 text-white px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-50">
                {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Revise
              </button>
            </div>
          )}

          {aiError && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded px-3 py-2">{aiError}</div>}
        </div>
      )}

      {mode === 'manual' && (
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Flow Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
              placeholder="e.g. Aggressive Filler Removal" />
          </div>

          <div className="text-xs text-zinc-500 uppercase tracking-wide">Pipeline Stages</div>
          <StageList stages={stages} stageOps={stageOps} dataPrefix="new-" insertTemplate={insertTemplate} />

          <div className="flex gap-2">
            <button type="button" onClick={() => addStage('llm')} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors"><Plus size={12} /> Add LLM Run</button>
            <button type="button" onClick={() => addStage('llm_question')} className="flex items-center gap-1 text-xs text-pink-500/70 hover:text-pink-400 transition-colors"><Plus size={12} /> Add Question</button>
            <button type="button" onClick={() => addStage('programmatic')} className="flex items-center gap-1 text-xs text-amber-500/70 hover:text-amber-400 transition-colors"><Plus size={12} /> Add Segment Step</button>
          </div>

          <button type="submit" disabled={creating || !name.trim()}
            className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors">
            {creating ? 'Creating...' : 'Create Flow'}
          </button>
        </form>
      )}
    </div>
  )
}

/** Shared stage operations factory */
function makeStageOps(stages, setStages) {
  function addStage(type = 'llm') {
    const base = { name: `Stage ${stages.length + 1}`, type }
    if (type === 'programmatic') {
      setStages(prev => [...prev, { ...base, action: 'segment', actionParams: { preset: 'short', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 }, description: 'Segment transcript' }])
    } else if (type === 'llm_question') {
      setStages(prev => [...prev, { ...base, prompt: '', system_instruction: '', model: 'claude-sonnet-4-20250514', params: { temperature: 1 } }])
    } else {
      setStages(prev => [...prev, { ...base, prompt: '', system_instruction: '', model: 'claude-sonnet-4-20250514', params: { temperature: 1 } }])
    }
  }
  function insertStage(atIndex, type = 'llm') {
    const base = { name: `Stage`, type }
    let newStage
    if (type === 'programmatic') {
      newStage = { ...base, action: 'segment', actionParams: { preset: 'short', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 }, description: 'Segment transcript' }
    } else {
      newStage = { ...base, prompt: '', system_instruction: '', model: 'claude-sonnet-4-20250514', params: { temperature: 1 } }
    }
    setStages(prev => { const arr = [...prev]; arr.splice(atIndex, 0, newStage); return arr })
  }
  function removeStage(i) { setStages(prev => prev.filter((_, idx) => idx !== i)) }
  function moveStage(from, to) {
    if (to < 0 || to >= stages.length) return
    setStages(prev => { const u = [...prev]; const [m] = u.splice(from, 1); u.splice(to, 0, m); return u })
  }
  function updateStage(i, field, value) {
    if (field === 'field_replace') {
      setStages(prev => { const u = [...prev]; u[i] = { ...u[i], [value.field]: value.value }; return u })
    } else {
      setStages(prev => { const u = [...prev]; u[i] = { ...u[i], [field]: value }; return u })
    }
  }
  function updateParams(i, paramKey, paramValue) {
    setStages(prev => { const u = [...prev]; u[i] = { ...u[i], params: { ...u[i].params, [paramKey]: paramValue } }; return u })
  }
  function duplicateStage(i) { setStages(prev => { const copy = { ...prev[i], name: prev[i].name + ' (copy)' }; const u = [...prev]; u.splice(i + 1, 0, copy); return u }) }
  function changeType(i, newType) {
    setStages(prev => {
      const u = [...prev]
      const s = u[i]
      if (newType === 'programmatic') {
        u[i] = { name: s.name, type: newType, action: 'segment', actionParams: { preset: 'short', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 }, description: 'Segment transcript' }
      } else {
        let sysInstr = s.system_instruction || ''
        if (newType === 'llm_parallel') {
          sysInstr = updateSegmentRulesInSystem(sysInstr, s.output_mode)
        } else if (s.type === 'llm_parallel') {
          sysInstr = stripSegmentRules(sysInstr)
        }
        const stage = { name: s.name, type: newType, model: s.model || 'claude-sonnet-4-20250514', prompt: s.prompt || '', system_instruction: sysInstr, params: s.params || { temperature: 1 } }
        // llm_question doesn't use output_mode; preserve it for other types
        if (newType !== 'llm_question' && s.output_mode) {
          stage.output_mode = s.output_mode
        }
        u[i] = stage
      }
      return u
    })
  }
  return { addStage, insertStage, removeStage, moveStage, updateStage, updateParams, duplicateStage, changeType }
}

/** Shared stage list with insert buttons, temperature, and thinking */
function StageList({ stages, stageOps, dataPrefix, insertTemplate }) {
  const { insertStage, removeStage, moveStage, updateStage, updateParams, duplicateStage, changeType } = stageOps

  return (
    <div>
      {stages.map((stage, i) => {
        const modelOpt = MODELS.find(m => m.id === stage.model)
        const showThinking = (stage.type === 'llm' || stage.type === 'llm_parallel' || stage.type === 'llm_question')
        return (
          <div key={i}>
            {/* Insert button between stages */}
            {i > 0 && (
              <div className="flex items-center gap-2 py-2">
                <div className="flex-1 border-t border-zinc-700/50" />
                <button type="button" onClick={() => insertStage(i)}
                  className="text-xs text-zinc-500 hover:text-white hover:bg-zinc-700 border border-dashed border-zinc-600 rounded px-3 py-1 transition-colors">
                  + Insert stage
                </button>
                <div className="flex-1 border-t border-zinc-700/50" />
              </div>
            )}

            <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded">Stage {i + 1}</span>
                  <StageBadge type={stage.type} />
                  <input type="text" value={stage.name} onChange={e => updateStage(i, 'name', e.target.value)}
                    className="bg-transparent border-none text-sm font-medium focus:outline-none" placeholder="Stage name" />
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => moveStage(i, i - 1)} disabled={i === 0}
                    className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 p-0.5"><ArrowUp size={12} /></button>
                  <button type="button" onClick={() => moveStage(i, i + 1)} disabled={i === stages.length - 1}
                    className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 p-0.5"><ArrowDown size={12} /></button>
                  <button type="button" onClick={() => duplicateStage(i)} className="text-zinc-600 hover:text-zinc-300 p-0.5" title="Duplicate">
                    <Copy size={12} /></button>
                  {stages.length > 1 && (
                    <button type="button" onClick={() => removeStage(i)} className="text-zinc-600 hover:text-red-400 p-0.5">
                      <Trash2 size={12} /></button>
                  )}
                </div>
              </div>

              {/* Type + Model row */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Type</label>
                  <select value={stage.type || 'llm'} onChange={e => changeType(i, e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                    <option value="llm">LLM — Whole Transcript</option>
                    <option value="llm_parallel">LLM — Per Segment</option>
                    <option value="llm_question">LLM — Question</option>
                    <option value="programmatic">Programmatic</option>
                  </select>
                </div>
                {(stage.type === 'llm' || stage.type === 'llm_parallel' || stage.type === 'llm_question') && (
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Model</label>
                    <select value={stage.model} onChange={e => updateStage(i, 'model', e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                      {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {/* Temperature + Thinking + Output Mode row (LLM only) */}
              {(stage.type === 'llm' || stage.type === 'llm_parallel' || stage.type === 'llm_question') && (
                <div className={`grid ${stage.type === 'llm_question' ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Temperature: {stage.params?.temperature ?? 1}</label>
                    <input type="range" min="0" max="2" step="0.1" value={stage.params?.temperature ?? 1}
                      onChange={e => updateParams(i, 'temperature', Number(e.target.value))}
                      className="w-full accent-zinc-400" />
                  </div>
                  {showThinking && (
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Thinking</label>
                      <select value={stage.params?.thinking_level || 'OFF'}
                        onChange={e => updateParams(i, 'thinking_level', e.target.value === 'OFF' ? undefined : e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                        {THINKING_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  )}
                  {stage.type !== 'llm_question' && (
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Output Mode</label>
                      <select value={stage.output_mode || ''}
                        onChange={e => {
                          const newMode = e.target.value || undefined
                          updateStage(i, 'output_mode', newMode)
                          if (stage.type === 'llm_parallel') {
                            updateStage(i, 'system_instruction', updateSegmentRulesInSystem(stage.system_instruction, newMode))
                          }
                        }}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                        <option value="">None (return cleaned text)</option>
                        <option value="deletion">Deletion</option>
                        <option value="keep_only">Keep Only</option>
                        <option value="identify">Identify (classify problems)</option>
                      </select>
                    </div>
                  )}
                  {(stage.output_mode === 'deletion' || stage.output_mode === 'keep_only') && (
                    <div className="col-span-2">
                      <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer mb-1.5">
                        <input type="checkbox"
                          checked={stage.identifyPreselect?.enabled || false}
                          onChange={e => updateStage(i, 'identifyPreselect', {
                            ...stage.identifyPreselect,
                            enabled: e.target.checked,
                            categories: stage.identifyPreselect?.categories || []
                          })}
                          className="rounded" />
                        Identification Preselect
                      </label>
                      {stage.identifyPreselect?.enabled && (
                        <div className="flex gap-3 ml-5">
                          {[
                            { key: 'filler_words', label: 'Fillers', color: 'text-red-300' },
                            { key: 'false_starts', label: 'False Starts', color: 'text-rose-400' },
                          ].map(cat => (
                            <label key={cat.key} className={`flex items-center gap-1.5 text-xs cursor-pointer ${cat.color}`}>
                              <input type="checkbox"
                                checked={stage.identifyPreselect?.categories?.includes(cat.key) || false}
                                onChange={e => {
                                  const cats = stage.identifyPreselect?.categories || []
                                  const newCats = e.target.checked
                                    ? [...cats, cat.key]
                                    : cats.filter(c => c !== cat.key)
                                  updateStage(i, 'identifyPreselect', {
                                    ...stage.identifyPreselect,
                                    categories: newCats
                                  })
                                }}
                                className="rounded" />
                              {cat.label}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Programmatic config */}
              {stage.type === 'programmatic' && (
                <>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Action</label>
                    <select value={stage.action || 'segment'} onChange={e => updateStage(i, 'action', e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                      <option value="segment">Segment Transcript</option>
                      <option value="reassemble">Reassemble Segments</option>
                    </select>
                  </div>
                  {stage.action === 'segment' && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">Segment Size</label>
                        <select
                          value={stage.actionParams?.preset || 'short'}
                          onChange={e => {
                            const p = SEGMENT_PRESETS[e.target.value]
                            updateStage(i, 'actionParams', { ...stage.actionParams, preset: e.target.value, minSeconds: p.minSeconds, maxSeconds: p.maxSeconds })
                          }}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none"
                        >
                          {Object.entries(SEGMENT_PRESETS).map(([k, v]) => (
                            <option key={k} value={k}>{v.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-zinc-500 mb-1">Context Sec</label>
                        <input type="number" value={stage.actionParams?.contextSeconds ?? 30}
                          onChange={e => updateStage(i, 'actionParams', { ...stage.actionParams, contextSeconds: Number(e.target.value) })}
                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none" />
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Description</label>
                    <input type="text" value={stage.description || ''} onChange={e => updateStage(i, 'description', e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none" placeholder="What this step does..." />
                  </div>
                </>
              )}

              {/* LLM Question info banner */}
              {stage.type === 'llm_question' && (
                <div className="text-[10px] text-pink-400/70 bg-pink-900/10 border border-pink-800/20 rounded px-2 py-1.5">
                  Question stage: LLM answer is stored as <code className="font-mono bg-pink-900/30 px-1 rounded">{'{{llm_answer}}'}</code> for use in later stages. Transcript passes through unchanged.
                </div>
              )}

              {/* LLM prompts */}
              {(stage.type === 'llm' || stage.type === 'llm_parallel' || stage.type === 'llm_question') && (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-zinc-500">System Prompt</label>
                      <TemplateButtons stageIndex={i} field="system_instruction" onInsert={insertTemplate} />
                    </div>
                    <textarea data-stage={`${dataPrefix}${i}`} data-field="system_instruction"
                      value={stage.system_instruction} onChange={e => updateStage(i, 'system_instruction', e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-zinc-600"
                      rows={3} placeholder="You are a transcript editor..." />
                    {stage.output_mode && (
                      <details className="mt-1">
                        <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400">Show full prompt (with auto-appended output mode rules)</summary>
                        <pre className="mt-1 text-[10px] text-zinc-500 bg-zinc-900/50 border border-zinc-800 rounded p-2 whitespace-pre-wrap max-h-48 overflow-auto">{previewAugmentedSystem(stage.system_instruction, stage.output_mode, stage.type, stage.identifyPreselect)}</pre>
                      </details>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-zinc-500">User Prompt</label>
                      <TemplateButtons stageIndex={i} field="prompt" onInsert={insertTemplate} />
                    </div>
                    <textarea data-stage={`${dataPrefix}${i}`} data-field="prompt"
                      value={stage.prompt} onChange={e => updateStage(i, 'prompt', e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-zinc-600"
                      rows={5} placeholder={'Clean the following transcript:\n\n<transcript>\n{{transcript}}\n</transcript>'} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Description</label>
                    <input type="text" value={stage.description || ''} onChange={e => updateStage(i, 'description', e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none" placeholder="What this step does..." />
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TemplateButtons({ stageIndex, field, onInsert }) {
  return (
    <div className="flex gap-1">
      {TEMPLATE_VARS.map(v => (
        <button key={v.tag} type="button" onClick={() => onInsert(stageIndex, field, v.tag)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors font-mono"
          title={v.desc}>{v.tag}</button>
      ))}
    </div>
  )
}

function StageBadge({ type }) {
  if (type === 'programmatic') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-amber-800 bg-amber-900/30 text-amber-300 flex items-center gap-1"><Cpu size={10} /> Programmatic</span>
  }
  if (type === 'llm_parallel') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-cyan-800 bg-cyan-900/30 text-cyan-300 flex items-center gap-1"><Layers size={10} /> Per Segment</span>
  }
  if (type === 'llm_question') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-pink-800 bg-pink-900/30 text-pink-300 flex items-center gap-1"><MessageCircleQuestion size={10} /> Question</span>
  }
  return <span className="text-xs px-1.5 py-0.5 rounded border border-violet-800 bg-violet-900/30 text-violet-300 flex items-center gap-1"><Bot size={10} /> LLM</span>
}
