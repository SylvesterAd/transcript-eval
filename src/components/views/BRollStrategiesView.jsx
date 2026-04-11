import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, ChevronDown, ChevronRight, Trash2, Pencil, ArrowUp, ArrowDown, Copy, Cpu, Bot, Layers, MessageCircleQuestion } from 'lucide-react'
import { apiDelete, apiPost, apiPut, useApi } from '../../hooks/useApi.js'
import { updateFormatInSystem, updateSegmentRulesInSystem, updateFocusInSystem, stripSegmentRules } from '../../lib/promptPreview.js'

const MODELS = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'gpt-5.4', label: 'GPT 5.4' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4.6' },
]

const THINKING_LEVELS = ['OFF', 'LOW', 'MEDIUM', 'HIGH']

const STRATEGY_TYPES = [
  { id: 'hook_analysis', label: 'Video Hook Analysis' },
  { id: 'main_analysis', label: 'Video Main Analysis' },
  { id: 'plan', label: 'B-Roll Plan' },
  { id: 'alt_plan', label: 'Alternative B-Roll Plan' },
  { id: 'keywords', label: 'B-Roll Search Keywords' },
  { id: 'broll_search', label: 'B-Roll Video Search' },
]

const SEGMENT_PRESETS = {
  short: { label: 'Short (40-60s)', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 },
  medium: { label: 'Medium (60-100s)', minSeconds: 60, maxSeconds: 100, contextSeconds: 30 },
  long: { label: 'Long (100-130s)', minSeconds: 100, maxSeconds: 130, contextSeconds: 30 },
}

const TRANSCRIPT_SOURCES = [
  { id: 'raw', label: 'Raw Transcript' },
  { id: 'human_edited', label: 'Human Edited' },
  { id: 'rough_cut_output', label: 'Rough Cut Output (cleaned)' },
]

const TEMPLATE_VARS = [
  { tag: '{{transcript}}', desc: 'Current transcript (based on target + source)' },
  { tag: '{{examples_output}}', desc: 'Aggregated output from all example-targeted stages' },
  { tag: '{{llm_answer}}', desc: 'Output from most recent question stage' },
  { tag: '{{llm_answer_N}}', desc: 'Output from Nth question stage (e.g. {{llm_answer_1}})' },
  { tag: '{{stage_N_output}}', desc: 'Output from stage N (e.g. {{stage_1_output}})' },
  { tag: '{{segment_number}}', desc: 'Current segment #' },
  { tag: '{{total_segments}}', desc: 'Total segments' },
]

function kindLabel(kind) {
  return STRATEGY_TYPES.find(item => item.id === kind)?.label || kind
}

function kindBadge(kind) {
  if (kind === 'hook_analysis') return 'border-emerald-800 bg-emerald-900/30 text-emerald-300'
  if (kind === 'main_analysis') return 'border-sky-800 bg-sky-900/30 text-sky-300'
  if (kind === 'alt_plan') return 'border-violet-800 bg-violet-900/30 text-violet-300'
  return 'border-amber-800 bg-amber-900/30 text-amber-300'
}

function defaultModelForKind(kind) {
  return kind === 'plan' ? 'gpt-5.4' : 'gemini-3-flash-preview'
}

const LLM_STAGE_TYPES = ['video_llm', 'video_question', 'transcript_llm', 'transcript_parallel', 'transcript_question']
const QUESTION_TYPES = ['video_question', 'transcript_question']
const VIDEO_TYPES = ['video_llm', 'video_question']
const PARALLEL_TYPES = ['transcript_parallel']

const STAGE_TARGETS = [
  { id: 'examples', label: 'Reference Video', desc: 'Runs on each reference video uploaded by user' },
  { id: 'main_video', label: 'Main Video', desc: 'Runs on the video user uploaded for editing' },
  { id: 'text_only', label: 'Text Only', desc: 'Works on accumulated text/outputs' },
]

function isLLMStage(type) { return LLM_STAGE_TYPES.includes(type) }
function isQuestionStage(type) { return QUESTION_TYPES.includes(type) }
function isVideoStage(type) { return VIDEO_TYPES.includes(type) }
function isParallelStage(type) { return PARALLEL_TYPES.includes(type) }

function allowedTargets(type) {
  if (type === 'programmatic') return ['text_only']
  if (isVideoStage(type)) return ['examples', 'main_video']
  return ['examples', 'main_video', 'text_only']
}

function defaultTarget(type) {
  if (type === 'programmatic') return 'text_only'
  if (isVideoStage(type)) return 'main_video'
  return 'main_video'
}

function targetBadgeStyle(target) {
  if (target === 'examples') return 'border-orange-800 bg-orange-900/30 text-orange-300'
  if (target === 'main_video') return 'border-blue-800 bg-blue-900/30 text-blue-300'
  return 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
}

function createStageTemplate(type = 'transcript_llm', strategyKind = 'hook_analysis') {
  if (type === 'programmatic') {
    return {
      name: '',
      type: 'programmatic',
      target: 'text_only',
      action: strategyKind === 'plan' ? 'segment_by_chapters' : 'segment',
      actionParams: strategyKind === 'plan'
        ? { contextSeconds: 0 }
        : { preset: 'short', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 },
      description: '',
    }
  }

  const isVideo = type === 'video_llm' || type === 'video_question'
  return {
    name: '',
    type,
    target: defaultTarget(type),
    prompt: '',
    system_instruction: '',
    model: isVideo ? 'gemini-3-flash-preview' : defaultModelForKind(strategyKind),
    params: { temperature: strategyKind === 'plan' ? 0.3 : 0.2, thinking_level: 'LOW' },
  }
}

function parseStages(stagesJson, strategyKind) {
  try {
    const parsed = JSON.parse(stagesJson || '[]')
    return Array.isArray(parsed) && parsed.length ? parsed : [createStageTemplate('video_llm', strategyKind)]
  } catch {
    return [createStageTemplate('video_llm', strategyKind)]
  }
}

function normalizeStrategy(strategy) {
  return {
    name: strategy?.name || '',
    description: strategy?.description || '',
    strategy_kind: strategy?.strategy_kind || 'hook_analysis',
    hook_strategy_id: strategy?.hook_strategy_id || '',
    main_strategy_id: strategy?.main_strategy_id || '',
  }
}

export default function BRollStrategiesView() {
  const { data: strategies, loading, error, refetch } = useApi('/broll/strategies')
  const [showCreate, setShowCreate] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    const id = searchParams.get('id')
    if (id && strategies?.length) setExpandedId(Number(id))
  }, [searchParams, strategies])

  useEffect(() => {
    if (expandedId) {
      setSearchParams({ id: String(expandedId) }, { replace: true })
    } else {
      setSearchParams({}, { replace: true })
    }
  }, [expandedId, setSearchParams])

  const sortedStrategies = useMemo(() => {
    const order = { hook_analysis: 0, main_analysis: 1, plan: 2 }
    return [...(strategies || [])].sort((a, b) => {
      const byType = (order[a.strategy_kind] ?? 99) - (order[b.strategy_kind] ?? 99)
      if (byType !== 0) return byType
      return a.name.localeCompare(b.name)
    })
  }, [strategies])

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">B-Roll Strategies</h2>
          <p className="text-sm text-zinc-500">Analyze video content (not just transcript) to plan B-Roll, PIP, and overlay visuals.</p>
        </div>
        <button
          onClick={() => setShowCreate(current => !current)}
          className="flex items-center gap-1 text-sm bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded transition-colors"
        >
          <Plus size={14} />
          Add New Strategy
        </button>
      </div>

      {showCreate && (
        <CreateStrategyForm
          strategies={sortedStrategies}
          onCreated={async () => { setShowCreate(false); await refetch() }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {error ? (
        <div className="text-sm text-red-400">Failed to load strategies: {error}</div>
      ) : !sortedStrategies.length ? (
        <div className="text-sm text-zinc-500">No B-roll strategies yet.</div>
      ) : (
        <div className="space-y-3">
          {sortedStrategies.map(strategy => (
            <StrategyCard
              key={strategy.id}
              strategy={strategy}
              strategies={sortedStrategies}
              expanded={expandedId === strategy.id}
              onToggle={() => setExpandedId(expandedId === strategy.id ? null : strategy.id)}
              onRefetch={refetch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StrategyCard({ strategy, strategies, expanded, onToggle, onRefetch }) {
  const { data: versions, refetch: refetchVersions } = useApi(expanded ? `/broll/strategies/${strategy.id}/versions` : null, [expanded, strategy.id])
  const [editing, setEditing] = useState(false)

  const latestVersion = versions?.[0] || null
  const stages = parseStages(latestVersion?.stages_json, strategy.strategy_kind)
  const hookStrategy = strategies.find(item => item.id === strategy.hook_strategy_id)
  const mainStrategy = strategies.find(item => item.id === strategy.main_strategy_id)

  async function handleDelete(event) {
    event.stopPropagation()
    if (!confirm(`Delete B-roll strategy "${strategy.name}"?`)) return
    await apiDelete(`/broll/strategies/${strategy.id}`)
    await onRefetch()
  }

  async function handleNewVersion(event) {
    event.stopPropagation()
    await apiPost(`/broll/strategies/${strategy.id}/versions`, {
      name: `Version ${Date.now()}`,
      notes: latestVersion?.notes || '',
      stages_json: latestVersion?.stages_json || '[]',
    })
    setEditing(true)
    await refetchVersions()
    await onRefetch()
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <div className="p-4 flex items-center justify-between cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {expanded ? <ChevronDown size={16} className="text-zinc-500 shrink-0" /> : <ChevronRight size={16} className="text-zinc-500 shrink-0" />}
          <span className={`text-[11px] px-2 py-1 rounded border uppercase tracking-wide ${kindBadge(strategy.strategy_kind)}`}>
            {kindLabel(strategy.strategy_kind)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{strategy.name}</div>
            <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{strategy.version_count || 0} version{String(strategy.version_count) === '1' ? '' : 's'}</span>
              {strategy.description && <span>· {strategy.description}</span>}
              {strategy.strategy_kind === 'plan' && (hookStrategy || mainStrategy) && (
                <span>· uses {hookStrategy?.name || 'no hook'} + {mainStrategy?.name || 'no main'}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0" onClick={event => event.stopPropagation()}>
          <button onClick={handleNewVersion} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
            <Layers size={12} /> New Version
          </button>
          <button onClick={() => setEditing(current => !current)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
            <Pencil size={12} /> {editing ? 'Close' : 'Edit'}
          </button>
          <button onClick={handleDelete} className="text-zinc-600 hover:text-red-400 p-1 transition-colors">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {editing ? (
            <StrategyEditor
              strategy={strategy}
              strategies={strategies}
              version={latestVersion}
              onSaved={async () => { setEditing(false); await refetchVersions(); await onRefetch() }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              {strategy.strategy_kind === 'plan' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <InfoCard label="Hook Strategy" value={hookStrategy?.name || 'Not selected'} />
                  <InfoCard label="Main Strategy" value={mainStrategy?.name || 'Not selected'} />
                </div>
              )}
              <StagePipeline stages={stages} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function CreateStrategyForm({ strategies, onCreated, onCancel }) {
  const [strategy, setStrategy] = useState({ name: '', description: '', strategy_kind: 'hook_analysis', hook_strategy_id: '', main_strategy_id: '' })
  const [stages, setStages] = useState([createStageTemplate('llm', 'hook_analysis')])
  const [creating, setCreating] = useState(false)
  const stageOps = makeStageOps(stages, setStages, strategy.strategy_kind)

  function insertTemplate(stageIndex, field, template) {
    const textarea = document.querySelector(`[data-stage="new-${stageIndex}"][data-field="${field}"]`)
    const stage = stages[stageIndex]
    const currentValue = stage[field] || ''
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = currentValue.slice(0, start) + template + currentValue.slice(end)
      stageOps.updateStage(stageIndex, 'field_replace', { field, value: newValue })
      setTimeout(() => { textarea.focus(); textarea.setSelectionRange(start + template.length, start + template.length) }, 0)
    } else {
      stageOps.updateStage(stageIndex, 'field_replace', { field, value: currentValue + template })
    }
  }

  function updateStrategyKind(nextKind) {
    setStrategy(current => ({ ...current, strategy_kind: nextKind, hook_strategy_id: nextKind === 'plan' ? current.hook_strategy_id : '', main_strategy_id: nextKind === 'plan' ? current.main_strategy_id : '' }))
    setStages([createStageTemplate('llm', nextKind)])
  }

  async function handleCreate(event) {
    event.preventDefault()
    if (!strategy.name.trim()) return
    setCreating(true)
    try {
      const created = await apiPost('/broll/strategies', {
        name: strategy.name.trim(),
        description: strategy.description.trim(),
        strategy_kind: strategy.strategy_kind,
        hook_strategy_id: strategy.strategy_kind === 'plan' ? Number(strategy.hook_strategy_id) || null : null,
        main_strategy_id: strategy.strategy_kind === 'plan' ? Number(strategy.main_strategy_id) || null : null,
      })
      await apiPost(`/broll/strategies/${created.id}/versions`, {
        name: 'Version 1',
        notes: `${kindLabel(strategy.strategy_kind)} flow`,
        stages_json: JSON.stringify(stages),
      })
      await onCreated()
    } catch (error) {
      alert(error.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <form onSubmit={handleCreate} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">New B-Roll Strategy</div>
        <button type="button" onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
      <StrategyMetaFields strategy={strategy} setStrategy={setStrategy} allStrategies={strategies} onTypeChange={updateStrategyKind} />
      <div className="text-xs text-zinc-500 uppercase tracking-wide">Pipeline Stages</div>
      <StageList stages={stages} stageOps={stageOps} dataPrefix="new-" insertTemplate={insertTemplate} />
      <div className="flex items-center justify-between">
        <StageActionButtons stageOps={stageOps} />
        <button type="submit" disabled={creating || !strategy.name.trim()} className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors">
          {creating ? 'Creating...' : 'Create Strategy'}
        </button>
      </div>
    </form>
  )
}

function StrategyEditor({ strategy, strategies, version, onSaved, onCancel }) {
  const [draft, setDraft] = useState(normalizeStrategy(strategy))
  const [stages, setStages] = useState(parseStages(version?.stages_json, strategy.strategy_kind))
  const [saving, setSaving] = useState(false)
  const stageOps = makeStageOps(stages, setStages, draft.strategy_kind)

  function insertTemplate(stageIndex, field, template) {
    const textarea = document.querySelector(`[data-stage="edit-${stageIndex}"][data-field="${field}"]`)
    const stage = stages[stageIndex]
    const currentValue = stage[field] || ''
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = currentValue.slice(0, start) + template + currentValue.slice(end)
      stageOps.updateStage(stageIndex, 'field_replace', { field, value: newValue })
      setTimeout(() => { textarea.focus(); textarea.setSelectionRange(start + template.length, start + template.length) }, 0)
    } else {
      stageOps.updateStage(stageIndex, 'field_replace', { field, value: currentValue + template })
    }
  }

  async function handleSave(event) {
    event.preventDefault()
    if (!version) return
    setSaving(true)
    try {
      await apiPut(`/broll/strategies/${strategy.id}`, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        hook_strategy_id: draft.strategy_kind === 'plan' ? Number(draft.hook_strategy_id) || null : null,
        main_strategy_id: draft.strategy_kind === 'plan' ? Number(draft.main_strategy_id) || null : null,
      })
      await apiPut(`/broll/strategies/${strategy.id}/versions/${version.id}`, {
        name: version.name,
        notes: version.notes || '',
        stages_json: JSON.stringify(stages),
      })
      await onSaved()
    } catch (error) {
      alert(error.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500 uppercase tracking-wide">Edit Strategy</div>
        <button type="button" onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
      </div>
      <StrategyMetaFields strategy={draft} setStrategy={setDraft} allStrategies={strategies} typeLocked />
      <div className="text-xs text-zinc-500 uppercase tracking-wide">Pipeline Stages</div>
      <StageList stages={stages} stageOps={stageOps} dataPrefix="edit-" insertTemplate={insertTemplate} />
      <div className="flex items-center justify-between">
        <StageActionButtons stageOps={stageOps} />
        <button type="submit" disabled={saving} className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function StrategyMetaFields({ strategy, setStrategy, allStrategies, onTypeChange, typeLocked = false }) {
  const hookStrategies = allStrategies.filter(item => item.strategy_kind === 'hook_analysis' && item.id !== strategy.id)
  const mainStrategies = allStrategies.filter(item => item.strategy_kind === 'main_analysis' && item.id !== strategy.id)
  function update(field, value) { setStrategy(current => ({ ...current, [field]: value })) }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Field label="Strategy Type">
        <select value={strategy.strategy_kind} onChange={event => { if (!typeLocked) onTypeChange?.(event.target.value) }} disabled={typeLocked} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none disabled:opacity-60">
          {STRATEGY_TYPES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </Field>
      <Field label="Strategy Name">
        <input value={strategy.name} onChange={event => update('name', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none" />
      </Field>
      <Field label="Description">
        <input value={strategy.description} onChange={event => update('description', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none" />
      </Field>
      {strategy.strategy_kind === 'plan' && (
        <>
          <Field label="Hook Strategy Used For Plan">
            <select value={strategy.hook_strategy_id || ''} onChange={event => update('hook_strategy_id', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none">
              <option value="">Select Hook Analysis strategy</option>
              {hookStrategies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
          <Field label="Main Strategy Used For Plan">
            <select value={strategy.main_strategy_id || ''} onChange={event => update('main_strategy_id', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none">
              <option value="">Select Main Analysis strategy</option>
              {mainStrategies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
        </>
      )}
    </div>
  )
}

function StageActionButtons({ stageOps }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <button type="button" onClick={() => stageOps.addStage('video_llm')} className="flex items-center gap-1 text-xs text-emerald-500/70 hover:text-emerald-400 transition-colors"><Plus size={12} /> Video Analysis</button>
      <button type="button" onClick={() => stageOps.addStage('video_question')} className="flex items-center gap-1 text-xs text-emerald-500/70 hover:text-emerald-400 transition-colors"><Plus size={12} /> Video Question</button>
      <button type="button" onClick={() => stageOps.addStage('transcript_llm')} className="flex items-center gap-1 text-xs text-sky-500/70 hover:text-sky-400 transition-colors"><Plus size={12} /> Transcript Analysis</button>
      <button type="button" onClick={() => stageOps.addStage('transcript_question')} className="flex items-center gap-1 text-xs text-pink-500/70 hover:text-pink-400 transition-colors"><Plus size={12} /> Transcript Question</button>
      <button type="button" onClick={() => stageOps.addStage('programmatic')} className="flex items-center gap-1 text-xs text-amber-500/70 hover:text-amber-400 transition-colors"><Plus size={12} /> Programmatic</button>
    </div>
  )
}

function StagePipeline({ stages }) {
  return (
    <div className="space-y-3">
      {stages.map((stage, index) => (
        <div key={index} className="bg-zinc-800/50 rounded p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300">Stage {index + 1}</span>
            <StageBadge type={stage.type} />
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${targetBadgeStyle(stage.target || defaultTarget(stage.type))}`}>
              {STAGE_TARGETS.find(t => t.id === (stage.target || defaultTarget(stage.type)))?.label}
            </span>
            <span className="text-sm font-medium">{stage.name || `Stage ${index + 1}`}</span>
          </div>
          {stage.type === 'programmatic' ? (
            <div className="text-xs text-zinc-400">{programmaticSummary(stage)}</div>
          ) : (
            <>
              {stage.description && <div className="text-xs text-zinc-400">{stage.description}</div>}
              <div className="text-xs text-zinc-500">{MODELS.find(model => model.id === stage.model)?.label || stage.model}</div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function makeStageOps(stages, setStages, strategyKind) {
  function addStage(type = 'transcript_llm') { setStages(prev => [...prev, createStageTemplate(type, strategyKind)]) }
  function insertStage(atIndex, type = 'transcript_llm') { setStages(prev => { const next = [...prev]; next.splice(atIndex, 0, createStageTemplate(type, strategyKind)); return next }) }
  function removeStage(index) { setStages(prev => prev.filter((_, i) => i !== index)) }
  function moveStage(from, to) { if (to < 0 || to >= stages.length) return; setStages(prev => { const next = [...prev]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next }) }
  function updateStage(index, field, value) {
    if (field === 'field_replace') { setStages(prev => { const next = [...prev]; next[index] = { ...next[index], [value.field]: value.value }; return next }); return }
    setStages(prev => { const next = [...prev]; next[index] = { ...next[index], [field]: value }; return next })
  }
  function updateParams(index, paramKey, paramValue) { setStages(prev => { const next = [...prev]; next[index] = { ...next[index], params: { ...next[index].params, [paramKey]: paramValue } }; return next }) }
  function duplicateStage(index) { setStages(prev => { const copy = { ...prev[index], name: `${prev[index].name || `Stage ${index + 1}`} (copy)` }; const next = [...prev]; next.splice(index + 1, 0, copy); return next }) }
  function changeType(index, newType) {
    setStages(prev => {
      const next = [...prev]; const current = next[index]
      if (newType === 'programmatic') { next[index] = { ...createStageTemplate('programmatic', strategyKind), name: current.name } }
      else {
        let systemInstruction = current.system_instruction || ''
        if (isParallelStage(newType)) systemInstruction = updateSegmentRulesInSystem(systemInstruction, current.output_mode)
        else if (isParallelStage(current.type)) systemInstruction = stripSegmentRules(systemInstruction)
        const template = createStageTemplate(newType, strategyKind)
        // Reset target if current target isn't allowed for new type
        const currentTarget = current.target || defaultTarget(current.type)
        const newTarget = allowedTargets(newType).includes(currentTarget) ? currentTarget : defaultTarget(newType)
        next[index] = { ...template, name: current.name, target: newTarget, prompt: current.prompt || '', system_instruction: systemInstruction, model: isVideoStage(newType) ? 'gemini-3-flash-preview' : (current.model || template.model), params: current.params || template.params, output_mode: isQuestionStage(newType) ? undefined : current.output_mode }
      }
      return next
    })
  }
  return { addStage, insertStage, removeStage, moveStage, updateStage, updateParams, duplicateStage, changeType }
}

function StageList({ stages, stageOps, dataPrefix, insertTemplate }) {
  const { insertStage, removeStage, moveStage, updateStage, updateParams, duplicateStage, changeType } = stageOps

  return (
    <div>
      {stages.map((stage, index) => (
        <div key={index}>
          {index > 0 && (
            <div className="flex items-center gap-2 py-2">
              <div className="flex-1 border-t border-zinc-700/50" />
              <button type="button" onClick={() => insertStage(index)} className="text-xs text-zinc-500 hover:text-white hover:bg-zinc-700 border border-dashed border-zinc-600 rounded px-3 py-1 transition-colors">+ Insert stage</button>
              <div className="flex-1 border-t border-zinc-700/50" />
            </div>
          )}
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded">Stage {index + 1}</span>
                <StageBadge type={stage.type} />
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${targetBadgeStyle(stage.target || defaultTarget(stage.type))}`}>
                  {STAGE_TARGETS.find(t => t.id === (stage.target || defaultTarget(stage.type)))?.label || stage.target}
                </span>
                <input value={stage.name || ''} onChange={event => updateStage(index, 'name', event.target.value)} className="bg-transparent border border-transparent hover:border-zinc-700 focus:border-zinc-600 focus:bg-zinc-800 text-sm font-medium focus:outline-none rounded px-1.5 py-0.5 -ml-1.5 transition-colors" placeholder="Stage name" />
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => moveStage(index, index - 1)} disabled={index === 0} className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 p-0.5"><ArrowUp size={12} /></button>
                <button type="button" onClick={() => moveStage(index, index + 1)} disabled={index === stages.length - 1} className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 p-0.5"><ArrowDown size={12} /></button>
                <button type="button" onClick={() => duplicateStage(index)} className="text-zinc-600 hover:text-zinc-300 p-0.5"><Copy size={12} /></button>
                {stages.length > 1 && <button type="button" onClick={() => removeStage(index)} className="text-zinc-600 hover:text-red-400 p-0.5"><Trash2 size={12} /></button>}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Type</label>
                <select value={stage.type || 'transcript_llm'} onChange={event => changeType(index, event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                  <optgroup label="Video (sends video to LLM)">
                    <option value="video_llm">Video Analysis</option>
                    <option value="video_question">Video Question</option>
                  </optgroup>
                  <optgroup label="Transcript (text-based)">
                    <option value="transcript_llm">Transcript Analysis</option>
                    <option value="transcript_parallel">Transcript Per Segment</option>
                    <option value="transcript_question">Transcript Question</option>
                  </optgroup>
                  <optgroup label="Processing">
                    <option value="programmatic">Programmatic</option>
                  </optgroup>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Target</label>
                <select
                  value={stage.target || defaultTarget(stage.type)}
                  onChange={event => updateStage(index, 'target', event.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none"
                >
                  {allowedTargets(stage.type).map(tid => {
                    const t = STAGE_TARGETS.find(s => s.id === tid)
                    return <option key={tid} value={tid}>{t?.label || tid}</option>
                  })}
                </select>
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {(stage.target || defaultTarget(stage.type)) === 'examples' && 'Runs on each reference video uploaded by user'}
                  {(stage.target || defaultTarget(stage.type)) === 'main_video' && 'Runs on the project video'}
                  {(stage.target || defaultTarget(stage.type)) === 'text_only' && 'Works on accumulated text'}
                </div>
              </div>
              {isLLMStage(stage.type) && (
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Model {isVideoStage(stage.type) && <span className="text-amber-500">(Gemini only)</span>}</label>
                  <select value={stage.model} onChange={event => updateStage(index, 'model', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                    {isVideoStage(stage.type)
                      ? MODELS.filter(m => m.id.startsWith('gemini')).map(model => <option key={model.id} value={model.id}>{model.label}</option>)
                      : MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)
                    }
                  </select>
                </div>
              )}
            </div>

            {isLLMStage(stage.type) && (
              <>
                {isVideoStage(stage.type) && (
                  <div className="text-xs text-amber-500/80 bg-amber-500/5 border border-amber-800/30 rounded px-3 py-1.5">
                    This stage uploads the actual video file to Gemini for visual analysis.
                  </div>
                )}
                <div className={`grid ${isQuestionStage(stage.type) ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Temperature: {stage.params?.temperature ?? 1}</label>
                    <input type="range" min="0" max="2" step="0.1" value={stage.params?.temperature ?? 1} onChange={event => updateParams(index, 'temperature', Number(event.target.value))} className="w-full accent-zinc-400" />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Thinking</label>
                    <select value={stage.params?.thinking_level || 'OFF'} onChange={event => updateParams(index, 'thinking_level', event.target.value === 'OFF' ? undefined : event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                      {THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
                    </select>
                  </div>
                  {!isQuestionStage(stage.type) && (
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Output Mode</label>
                      <select value={stage.output_mode || ''} onChange={event => {
                        const nextMode = event.target.value || undefined
                        updateStage(index, 'output_mode', nextMode)
                        let systemInstruction = updateFormatInSystem(stage.system_instruction, nextMode)
                        if (isParallelStage(stage.type)) systemInstruction = updateSegmentRulesInSystem(systemInstruction, nextMode)
                        updateStage(index, 'system_instruction', systemInstruction)
                      }} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                        <option value="">None</option>
                        <option value="deletion">Deletion</option>
                        <option value="keep_only">Keep Only</option>
                        <option value="identify">Identify</option>
                      </select>
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-zinc-500">System Prompt</label>
                    <TemplateButtons stageIndex={index} field="system_instruction" onInsert={insertTemplate} />
                  </div>
                  <textarea data-stage={`${dataPrefix}${index}`} data-field="system_instruction" value={stage.system_instruction} onChange={event => updateStage(index, 'system_instruction', event.target.value)} className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-zinc-600" rows={Math.max(6, Math.min(24, (stage.system_instruction || '').split('\n').length + 1))} placeholder={isVideoStage(stage.type) ? 'System instruction for video analysis' : 'System instruction for transcript analysis'} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-zinc-500">User Prompt</label>
                    <TemplateButtons stageIndex={index} field="prompt" onInsert={insertTemplate} />
                  </div>
                  <textarea data-stage={`${dataPrefix}${index}`} data-field="prompt" value={stage.prompt} onChange={event => updateStage(index, 'prompt', event.target.value)} className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-zinc-600" rows={Math.max(5, Math.min(20, (stage.prompt || '').split('\n').length + 1))} placeholder={isVideoStage(stage.type) ? 'What to analyze in the video' : 'What to analyze in the transcript'} />
                </div>
              </>
            )}

            {stage.type === 'programmatic' && (
              <>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Action</label>
                  <select value={stage.action || 'segment'} onChange={event => {
                    const action = event.target.value
                    updateStage(index, 'action', action)
                    if (action === 'segment') updateStage(index, 'actionParams', { preset: 'short', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 })
                    else if (action === 'segment_by_chapters') updateStage(index, 'actionParams', { contextSeconds: 0 })
                    else updateStage(index, 'actionParams', {})
                  }} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                    <option value="segment">Segment by Time</option>
                    <option value="segment_by_chapters">Segment by Chapters</option>
                    <option value="reassemble">Reassemble Segments</option>
                    <option value="trim_before">Trim Before Time</option>
                    <option value="trim_ranges">Cut Ranges</option>
                  </select>
                </div>
                {stage.action === 'segment' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Segment Size</label>
                      <select value={stage.actionParams?.preset || 'short'} onChange={event => { const p = SEGMENT_PRESETS[event.target.value]; updateStage(index, 'actionParams', { ...stage.actionParams, preset: event.target.value, minSeconds: p.minSeconds, maxSeconds: p.maxSeconds }) }} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none">
                        {Object.entries(SEGMENT_PRESETS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Context Sec</label>
                      <input type="number" value={stage.actionParams?.contextSeconds ?? 30} onChange={event => updateStage(index, 'actionParams', { ...stage.actionParams, contextSeconds: Number(event.target.value) })} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none" />
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Description</label>
                  <input value={stage.description || ''} onChange={event => updateStage(index, 'description', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none" placeholder="What this step does" />
                </div>
              </>
            )}

            {isLLMStage(stage.type) && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Description</label>
                <input value={stage.description || ''} onChange={event => updateStage(index, 'description', event.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none" placeholder="What this stage does" />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function programmaticSummary(stage) {
  if (stage.action === 'segment') return `Segment by time (${SEGMENT_PRESETS[stage.actionParams?.preset || 'short']?.label || 'custom'})`
  if (stage.action === 'segment_by_chapters') return 'Segment by chapters'
  if (stage.action === 'reassemble') return 'Reassemble segments'
  if (stage.action === 'trim_before') return 'Trim before a detected point'
  if (stage.action === 'trim_ranges') return 'Cut ranges'
  return stage.description || 'Processing step'
}

function TemplateButtons({ stageIndex, field, onInsert }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {TEMPLATE_VARS.map(variable => (
        <button key={variable.tag} type="button" onClick={() => onInsert(stageIndex, field, variable.tag)} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors font-mono" title={variable.desc}>
          {variable.tag}
        </button>
      ))}
    </div>
  )
}

function StageBadge({ type }) {
  if (type === 'programmatic') return <span className="text-xs px-1.5 py-0.5 rounded border border-amber-800 bg-amber-900/30 text-amber-300 flex items-center gap-1"><Cpu size={10} /> Programmatic</span>
  if (type === 'video_llm') return <span className="text-xs px-1.5 py-0.5 rounded border border-emerald-800 bg-emerald-900/30 text-emerald-300 flex items-center gap-1"><Bot size={10} /> Video Analysis</span>
  if (type === 'video_question') return <span className="text-xs px-1.5 py-0.5 rounded border border-emerald-800 bg-emerald-900/30 text-emerald-300 flex items-center gap-1"><MessageCircleQuestion size={10} /> Video Question</span>
  if (type === 'transcript_parallel') return <span className="text-xs px-1.5 py-0.5 rounded border border-sky-800 bg-sky-900/30 text-sky-300 flex items-center gap-1"><Layers size={10} /> Transcript Per Segment</span>
  if (type === 'transcript_question') return <span className="text-xs px-1.5 py-0.5 rounded border border-pink-800 bg-pink-900/30 text-pink-300 flex items-center gap-1"><MessageCircleQuestion size={10} /> Transcript Question</span>
  return <span className="text-xs px-1.5 py-0.5 rounded border border-sky-800 bg-sky-900/30 text-sky-300 flex items-center gap-1"><Bot size={10} /> Transcript Analysis</span>
}

function Field({ label, children }) {
  return <label className="block space-y-1.5"><div className="text-xs text-zinc-500 uppercase tracking-wide">{label}</div>{children}</label>
}

function InfoCard({ label, value }) {
  return <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3"><div className="text-xs text-zinc-500 mb-1">{label}</div><div className="text-sm">{value}</div></div>
}
