import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApi, apiPost, apiPut } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import { useRole } from '../../contexts/RoleContext.jsx'
import { Play, Loader2, CheckCircle, AlertCircle, RotateCcw, Search, Sparkles, Layers, Tag, Film, Star, ChevronDown, ChevronRight, Pencil, Upload, FileText, Check } from 'lucide-react'
import BRollEditor from './BRollEditor.jsx'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path) {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { headers })
}

function ytThumbnail(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : null
}

function formatDuration(sec) {
  if (!sec) return '--:--:--'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function BRollPanel({ groupId, videoId, sub, detail }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: strategies } = useApi('/broll/strategies')
  const { data: videoRunsData, loading: runsLoading, refetch: refetchRuns } = useApi(videoId ? `/broll/runs/video/${videoId}` : null)
  const { data: examples } = useApi(groupId ? `/broll/groups/${groupId}/examples` : null)
  const [runningType, setRunningType] = useState(null) // 'analysis' | 'plan' | null
  const [pipelineId, setPipelineId] = useState(null)
  const [pipelineIds, setPipelineIds] = useState([]) // multiple parallel analysis runs
  const [pipelineProgresses, setPipelineProgresses] = useState({}) // { pipelineId: progress }
  const [expandedCards, setExpandedCards] = useState({}) // { sourceId: true/false }
  const [selectedStrategies, setSelectedStrategies] = useState(new Set()) // selected strategy pipelineIds
  const [editingField, setEditingField] = useState(null) // { pipelineId, ci, bi, field, spIndex? }
  const [fieldValue, setFieldValue] = useState('')
  const [savingField, setSavingField] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)

  const { isAdmin } = useRole()
  const [resetPreview, setResetPreview] = useState(null)
  const [resetConfirming, setResetConfirming] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [resetError, setResetError] = useState(null)

  const analysisStrategy = (strategies || []).find(s => s.strategy_kind === 'main_analysis')
  const planStrategy = (strategies || []).find(s => s.strategy_kind === 'plan')
  const altPlanStrategy = (strategies || []).find(s => s.strategy_kind === 'alt_plan')
  const keywordsStrategy = (strategies || []).find(s => s.strategy_kind === 'keywords')
  const planPrepStrategy = (strategies || []).find(s => s.strategy_kind === 'plan_prep')
  const createStrategyKind = (strategies || []).find(s => s.strategy_kind === 'create_strategy')
  const createPlanStrategy = (strategies || []).find(s => s.strategy_kind === 'create_plan')
  const videoRuns = videoRunsData?.runs || []
  const activePipelines = videoRunsData?.activePipelines || []

  // Group runs by pipelineId
  const pipelineMap = {}
  for (const run of videoRuns) {
    try {
      const meta = JSON.parse(run.metadata_json || '{}')
      const pid = meta.pipelineId
      if (!pid) continue
      if (!pipelineMap[pid]) pipelineMap[pid] = { stages: [], status: 'complete', lastRunId: null }
      pipelineMap[pid].stages.push({ ...run, _meta: meta })
      if (run.status === 'failed') pipelineMap[pid].status = 'failed'
      // Track the last (highest stageIndex) run id for reference_run_id
      if (!pipelineMap[pid].lastRunId || (meta.stageIndex || 0) > (pipelineMap[pid].lastStageIndex || 0)) {
        pipelineMap[pid].lastRunId = run.id
        pipelineMap[pid].lastStageIndex = meta.stageIndex || 0
      }
    } catch {}
  }

  // Parse chapters, stats, and patterns per example video from analysis runs
  // pipelineId format: "{strategyId}-{videoId}-{ts}-ex{exampleVideoId}"
  const chaptersByExampleVideo = useMemo(() => {
    const map = {} // { exampleVideoId: { chapters, stats, patterns } }

    function parseOutput(text) {
      const jsonMatch = text?.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) { try { return JSON.parse(jsonMatch[1]) } catch {} }
      try { return JSON.parse(text) } catch {}
      return null
    }

    for (const run of videoRuns) {
      if (run.status !== 'complete' || !run.output_text) continue
      const meta = (() => { try { return JSON.parse(run.metadata_json || '{}') } catch { return {} } })()
      const exMatch = meta.pipelineId?.match(/-ex(\d+)$/)
      if (!exMatch) continue
      const exVid = Number(exMatch[1])
      if (!map[exVid]) map[exVid] = { chapters: [], stats: [], patterns: [] }

      if (meta.stageName === 'Analyze A-Roll + Chapters & Beats') {
        const parsed = parseOutput(run.output_text)
        if (parsed?.chapters) map[exVid].chapters = parsed.chapters
      }
      if (meta.stageName === 'Compute chapter stats') {
        const parsed = parseOutput(run.output_text)
        if (Array.isArray(parsed)) map[exVid].stats = parsed
      }
      if (meta.stageName === 'Pattern analysis' && meta.isSubRun) {
        const parsed = parseOutput(run.output_text)
        if (parsed) map[exVid].patterns.push({ subIndex: meta.subIndex, data: parsed })
      }
    }
    // Sort patterns by subIndex
    for (const v of Object.values(map)) {
      v.patterns.sort((a, b) => (a.subIndex || 0) - (b.subIndex || 0))
    }
    return map
  }, [videoRuns])

  // Parse main video chapter analysis (from plan or prep pipeline, no -ex suffix)
  const mainVideoChapters = useMemo(() => {
    function parseOutput(text) {
      const jsonMatch = text?.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) { try { return JSON.parse(jsonMatch[1]) } catch {} }
      try { return JSON.parse(text) } catch {}
      return null
    }
    // Search newest first
    const sorted = [...videoRuns].sort((a, b) => b.id - a.id)
    for (const run of sorted) {
      if (run.status !== 'complete' || !run.output_text) continue
      const meta = (() => { try { return JSON.parse(run.metadata_json || '{}') } catch { return {} } })()
      if (meta.pipelineId?.match(/-ex\d+$/)) continue // skip example videos
      if (!meta.stageName?.includes('Chapters & Beats') && !meta.stageName?.includes('Chapters')) continue
      const parsed = parseOutput(run.output_text)
      if (parsed?.chapters) return parsed
    }
    return null
  }, [videoRuns])

  // Check for completed analysis (strategy_id matches analysis strategy)
  const completedAnalysis = Object.values(pipelineMap).find(p =>
    p.status === 'complete' && p.stages.some(s => String(s.strategy_id) === String(analysisStrategy?.id))
  )
  const hasCompletedAnalysis = !!completedAnalysis
  const analysisRunId = completedAnalysis?.lastRunId

  // Check for completed plan
  const hasCompletedPlan = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === planStrategy?.id)
  )

  // Check for completed alt plan (runs as part of plan pipeline with alt_plan phase)
  const hasCompletedAltPlan = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'alt_plan' } catch { return false }
    })
  )

  // Check for completed keywords
  const hasCompletedKeywords = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'keywords' } catch { return false }
    })
  )

  // Check for completed keyword batch (new flow: kw-* pipelines)
  const hasCompletedBrollSearch = Object.entries(pipelineMap).some(([pid, p]) =>
    pid.startsWith('kw-') && p.status === 'complete'
  )

  // Find completed prep pipeline (strategy_kind === 'plan_prep')
  const completedPrepPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === planPrepStrategy?.id || String(s.strategy_id) === String(planPrepStrategy?.id))
  )
  const prepPipelineId = completedPrepPipeline?.[0] || null
  const hasCompletedPrep = !!completedPrepPipeline

  // Find completed analysis pipeline IDs
  const completedAnalysisPipelineIds = Object.entries(pipelineMap)
    .filter(([pid, p]) => p.status === 'complete' && p.stages.some(s => String(s.strategy_id) === String(analysisStrategy?.id)))
    .map(([pid]) => pid)

  // Check for completed strategies
  const hasCompletedStrategies = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { const m = JSON.parse(s.metadata_json || '{}'); return m.phase === 'create_strategy' || m.phase === 'create_combined_strategy' } catch { return false }
    })
  )

  // Find completed strategy pipeline IDs
  const completedStrategyPipelineIds = Object.entries(pipelineMap)
    .filter(([pid, p]) => p.status === 'complete' && (pid.startsWith('strat-') || pid.startsWith('cstrat-')))
    .map(([pid]) => pid)

  // Parse completed strategy variants with per-chapter outputs
  const strategyVariants = useMemo(() => {
    function parseOutput(text) {
      const jsonMatch = text?.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) { try { return JSON.parse(jsonMatch[1]) } catch {} }
      try { return JSON.parse(text) } catch {}
      return null
    }

    // Extract beat_strategies from parsed JSON output
    function extractBeatStrategies(parsed) {
      if (!parsed) return []
      const bs = parsed.beat_strategies || parsed.beatStrategies || []
      return bs.map(b => {
        const rf = b.reference_frequency || {}
        return {
          name: b.beat_name || b.name || '',
          emotion: b.beat_emotion || b.emotion || '',
          matched_reference_beat: b.matched_reference_beat || '',
          match_reason: b.match_reason || '',
          strategy_points: b.strategy_points || [],
          brollPerMin: rf.broll_per_minute ?? rf.per_minute ?? null,
          avgBrollDur: rf.broll_avg_duration ?? rf.broll_avg_duration_seconds ?? rf.avg_duration_seconds ?? null,
          gpPerMin: rf.gp_per_minute ?? null,
          beatDuration: rf.beat_duration_seconds ?? null,
        }
      })
    }

    // Merge enriched frequency data into strategyBeats (enriched parent has full frequency from reference analysis)
    function mergeEnrichedFrequency(strategyBeats, enrichedParsed) {
      if (!enrichedParsed) return
      const ebs = enrichedParsed.beat_strategies || enrichedParsed.beatStrategies || []
      for (const sb of strategyBeats) {
        const enriched = ebs.find(e => (e.beat_name || e.name || '').toLowerCase().trim() === sb.name.toLowerCase().trim())
        if (!enriched?.reference_frequency) continue
        const rf = enriched.reference_frequency
        if (sb.brollPerMin == null) sb.brollPerMin = rf.broll_per_minute ?? rf.per_minute ?? null
        if (sb.avgBrollDur == null) sb.avgBrollDur = rf.broll_avg_duration ?? rf.broll_avg_duration_seconds ?? rf.avg_duration_seconds ?? null
        if (sb.gpPerMin == null) sb.gpPerMin = rf.gp_per_minute ?? null
        if (sb.beatDuration == null) sb.beatDuration = rf.beat_duration_seconds ?? null
      }
    }

    const variants = []
    for (const [pid, pipeline] of Object.entries(pipelineMap)) {
      if (pipeline.status !== 'complete') continue
      const isCombined = pid.startsWith('cstrat-')
      const isStrategy = pid.startsWith('strat-')
      if (!isCombined && !isStrategy) continue

      // Find the analysis pipeline ID this strategy is based on
      let analysisPipelineId = null
      let exampleVideoId = null
      for (const stage of pipeline.stages) {
        try {
          const m = JSON.parse(stage.metadata_json || '{}')
          if (m.analysisPipelineId) analysisPipelineId = m.analysisPipelineId
          if (m.analysisPipelineIds) analysisPipelineId = m.analysisPipelineIds // combined uses array
        } catch {}
      }
      // Extract exampleVideoId from analysis pipeline ID (format: stratId-videoId-ts-ex{exVidId})
      if (analysisPipelineId && !isCombined) {
        const exMatch = String(analysisPipelineId).match(/-ex(\d+)$/)
        if (exMatch) exampleVideoId = Number(exMatch[1])
      }

      // Collect per-chapter sub-run outputs, merge with mainVideoChapters metadata
      const mainChapters = mainVideoChapters?.chapters || []
      const chapters = []
      const allSubRuns = pipeline.stages
        .filter(s => { try { return JSON.parse(s.metadata_json || '{}').isSubRun } catch { return false } })
      // Only keep sub-runs from the last (highest) stageIndex — earlier stages are intermediate
      const maxStageIndex = allSubRuns.reduce((max, s) => {
        try { return Math.max(max, JSON.parse(s.metadata_json || '{}').stageIndex ?? 0) } catch { return max }
      }, -1)
      const subRuns = allSubRuns
        .filter(s => { try { return (JSON.parse(s.metadata_json || '{}').stageIndex ?? 0) === maxStageIndex } catch { return false } })
        .sort((a, b) => {
          try { return (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0) } catch { return 0 }
        })
      for (const run of subRuns) {
        try {
          const meta = JSON.parse(run.metadata_json || '{}')
          const parsed = parseOutput(run.output_text)
          const idx = meta.subIndex ?? chapters.length
          const mainCh = mainChapters[idx] || null
          const strategyBeats = extractBeatStrategies(parsed)
          // Merge enriched frequency from the Enrich stage parent run (has full reference_frequency with all fields)
          const enrichParent = pipeline.stages.find(s => {
            try { const m = JSON.parse(s.metadata_json || '{}'); return !m.isSubRun && (m.stageName || '').includes('Enrich') } catch { return false }
          })
          if (enrichParent) {
            try {
              const enrichedAll = JSON.parse(enrichParent.output_text)
              const enrichedChapter = typeof enrichedAll[idx] === 'string' ? JSON.parse(enrichedAll[idx]) : enrichedAll[idx]
              if (enrichedChapter) mergeEnrichedFrequency(strategyBeats, enrichedChapter)
            } catch {}
          }
          chapters.push({
            index: idx,
            runId: run.id,
            label: meta.subLabel || `Chapter ${idx + 1}`,
            raw: run.output_text,
            parsed,
            // Merged from mainVideoChapters (overrides from strategy output take priority)
            name: mainCh?.name || meta.subLabel?.replace(/^Chapter\s+\d+:\s*/i, '') || '',
            description: parsed?.chapter_description_override || mainCh?.description || null,
            purpose: parsed?.chapter_purpose_override || mainCh?.purpose || null,
            start: mainCh?.start || mainCh?.start_tc || (mainCh?.start_seconds != null ? formatDuration(mainCh.start_seconds) : null),
            duration_seconds: (() => {
              function tcToSec(tc) { const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/); return m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) : null }
              if (mainCh?.end_seconds != null && mainCh?.start_seconds != null) return mainCh.end_seconds - mainCh.start_seconds
              const s = tcToSec(mainCh?.start || mainCh?.start_tc), e = tcToSec(mainCh?.end || mainCh?.end_tc)
              return (s != null && e != null) ? e - s : null
            })(),
            beats: mainCh?.beats || [],
            // B-roll stats: from strategy JSON frequency_targets, overridable
            brollPerMin: parsed?.broll_per_min_override ?? parsed?.frequency_targets?.broll?.target_per_minute ?? null,
            avgBrollDur: parsed?.avg_broll_dur_override ?? null,
            strategyBeats,
          })
        } catch {}
      }

      // Find the reference video source for attribution
      const refSource = exampleVideoId
        ? (examples || []).find(ex => {
            try { return JSON.parse(ex.meta_json || '{}').videoId === exampleVideoId } catch { return false }
          })
        : null

      variants.push({
        pipelineId: pid,
        isCombined,
        analysisPipelineId,
        exampleVideoId,
        refSource,
        chapters,
      })
    }

    // Sort: per-reference strategies first (alphabetical by pipeline ID), combined last
    variants.sort((a, b) => {
      if (a.isCombined && !b.isCombined) return 1
      if (!a.isCombined && b.isCombined) return -1
      return a.pipelineId.localeCompare(b.pipelineId)
    })

    // Assign variant labels — all get Variant A/B/C, combined included
    let letterIdx = 0
    for (const v of variants) {
      v.label = `Variant ${String.fromCharCode(65 + letterIdx)}`
      letterIdx++
      if (v.isCombined) {
        v.sublabel = 'Best matching beats from all references'
      } else {
        v.sublabel = v.refSource?.label || v.refSource?.video_title || `Reference ${letterIdx}`
      }
    }

    return variants
  }, [videoRuns, pipelineMap, examples, mainVideoChapters])

  // Parse completed plan variants with per-chapter placements
  const planVariants = useMemo(() => {
    function parseOutput(text) {
      const jsonMatch = text?.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) { try { return JSON.parse(jsonMatch[1]) } catch {} }
      try { return JSON.parse(text) } catch {}
      return null
    }

    const variants = []
    for (const [pid, pipeline] of Object.entries(pipelineMap)) {
      if (pipeline.status !== 'complete' || !pid.startsWith('plan-')) continue

      // Find which strategy this plan was based on
      let strategyPipelineId = null
      for (const stage of pipeline.stages) {
        try {
          const m = JSON.parse(stage.metadata_json || '{}')
          if (m.strategyPipelineId) { strategyPipelineId = m.strategyPipelineId; break }
        } catch {}
      }

      // Match to a strategy variant for label/attribution
      const stratVariant = strategyVariants.find(v => v.pipelineId === strategyPipelineId)

      // Get per-chapter sub-runs (last stageIndex only)
      const mainChapters = mainVideoChapters?.chapters || []
      const allSubRuns = pipeline.stages
        .filter(s => { try { return JSON.parse(s.metadata_json || '{}').isSubRun } catch { return false } })
      const maxStageIndex = allSubRuns.reduce((max, s) => {
        try { return Math.max(max, JSON.parse(s.metadata_json || '{}').stageIndex ?? 0) } catch { return max }
      }, -1)
      const subRuns = allSubRuns
        .filter(s => { try { return (JSON.parse(s.metadata_json || '{}').stageIndex ?? 0) === maxStageIndex } catch { return false } })
        .sort((a, b) => {
          try { return (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0) } catch { return 0 }
        })

      let totalPlacements = 0
      const categories = { broll: 0, graphic_package: 0, overlay_image: 0 }
      const chapters = []
      for (const run of subRuns) {
        try {
          const meta = JSON.parse(run.metadata_json || '{}')
          const parsed = parseOutput(run.output_text)
          const idx = meta.subIndex ?? chapters.length
          const mainCh = mainChapters[idx] || null
          const placements = parsed?.placements || []
          totalPlacements += placements.length
          for (const p of placements) { if (categories[p.category] != null) categories[p.category]++ }

          function tcToSec(tc) { const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/); return m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) : null }

          chapters.push({
            index: idx,
            runId: run.id,
            parsed,
            label: meta.subLabel || `Chapter ${idx + 1}`,
            name: mainCh?.name || meta.subLabel?.replace(/^Chapter\s+\d+:\s*/i, '') || '',
            description: mainCh?.description || null,
            purpose: mainCh?.purpose || null,
            start: mainCh?.start || mainCh?.start_tc || null,
            duration_seconds: (() => {
              const s = tcToSec(mainCh?.start), e = tcToSec(mainCh?.end)
              return (s != null && e != null) ? e - s : null
            })(),
            beats: mainCh?.beats || [],
            placements,
            placementCount: placements.length,
          })
        } catch {}
      }

      variants.push({
        pipelineId: pid,
        strategyPipelineId,
        stratVariant,
        chapters,
        totalPlacements,
        categories,
      })
    }

    // Assign labels matching strategy variant letters
    for (const v of variants) {
      if (v.stratVariant) {
        v.label = v.stratVariant.label
        v.isCombined = v.stratVariant.isCombined
        v.refSource = v.stratVariant.refSource
      } else {
        v.label = `Plan ${variants.indexOf(v) + 1}`
        v.isCombined = false
        v.refSource = null
      }
    }

    return variants
  }, [videoRuns, pipelineMap, strategyVariants, mainVideoChapters])

  // Check for completed plan (new style)
  const hasCompletedNewPlan = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'create_plan' } catch { return false }
    })
  )

  // Find new-style plan pipeline ID for keywords/search
  const completedNewPlanPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && pid.startsWith('plan-')
  )
  const newPlanPipelineId = completedNewPlanPipeline?.[0] || null

  const hasActivePipeline = activePipelines.length > 0
  const activeProgress = activePipelines[0] || null

  // If there are active pipelines on mount (started externally), track them
  useEffect(() => {
    if (!activePipelines.length || pipelineId || pipelineIds.length) return

    const running = activePipelines.filter(p => p.status === 'running')
    if (!running.length) return

    // Track ALL running pipelines (both example and main video)
    setPipelineIds(running.map(p => p.pipelineId))
    setRunningType(
      running.some(p => String(p.strategyId) === String(analysisStrategy?.id)) ? 'analysis'
      : running.some(p => p.phase === 'broll_search' || p.phase === 'gpu_search') ? 'search'
      : running.some(p => p.phase === 'keywords') ? 'search'
      : running.some(p => p.phase === 'create_strategy') ? 'strategy'
      : 'plan'
    )
    const initial = {}
    for (const p of running) initial[p.pipelineId] = p
    setPipelineProgresses(initial)
  }, [activePipelines, pipelineId, pipelineIds.length, analysisStrategy?.id])

  // Auto-refetch runs when active pipelines exist (picks up new completions without page reload)
  useEffect(() => {
    if (!hasActivePipeline) return
    const interval = setInterval(() => refetchRuns(true), 5000)
    return () => clearInterval(interval)
  }, [hasActivePipeline, refetchRuns])

  // Poll progress
  useEffect(() => {
    if (!pipelineId || !runningType) return
    const interval = setInterval(async () => {
      try {
        const res = await authFetch(`/broll/pipeline/${pipelineId}/progress`)
        const data = await res.json()
        setProgress(data)
        if (data.status === 'complete' || data.status === 'failed') {
          setRunningType(null)
          setPipelineId(null)
          if (data.status === 'failed') setError(data.error || 'Pipeline failed')
          refetchRuns()
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [pipelineId, runningType, refetchRuns])

  // Poll progress for parallel analysis runs
  useEffect(() => {
    if (!pipelineIds.length || !['analysis', 'strategy', 'plan', 'search'].includes(runningType)) return
    const interval = setInterval(async () => {
      try {
        const updates = {}
        for (const pid of pipelineIds) {
          const res = await authFetch(`/broll/pipeline/${pid}/progress`)
          updates[pid] = await res.json()
        }
        // Merge with previous state — preserve completed/failed when server returns 'unknown' (cleaned up from memory)
        let merged
        setPipelineProgresses(prev => {
          merged = { ...prev }
          for (const [pid, data] of Object.entries(updates)) {
            if (data.status === 'unknown' && (prev[pid]?.status === 'complete' || prev[pid]?.status === 'failed')) {
              continue // keep local completed/failed state
            }
            merged[pid] = data
          }
          return merged
        })

        const allDone = pipelineIds.every(pid => {
          const s = (merged || updates)[pid]?.status
          return s === 'complete' || s === 'failed'
        })
        if (allDone) {
          setRunningType(null)
          setPipelineIds([])
          const failed = pipelineIds.map(pid => (merged || updates)[pid]).filter(p => p?.status === 'failed')
          if (failed.length) setError(`${failed.length} analysis run(s) failed: ${failed.map(p => p.error).join('; ')}`)
          refetchRuns()
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [pipelineIds, runningType, refetchRuns])

  async function getLatestVersion(strategyId) {
    const res = await authFetch(`/broll/strategies/${strategyId}/versions`)
    const versions = await res.json()
    if (!versions?.[0]) throw new Error('No strategy version found')
    return versions[0]
  }

  async function handleRunAnalysis() {
    if (!videoId || !groupId) return
    setRunningType('analysis')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      const res = await apiPost('/broll/pipeline/run-all', {
        video_id: videoId,
        group_id: groupId,
      })
      // Track all pipeline IDs (prep + analyses)
      const allIds = [res.prepPipelineId, ...(res.analysisPipelineIds || [])].filter(Boolean)
      setPipelineIds(allIds)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function handleRunStrategies() {
    if (!prepPipelineId || !completedAnalysisPipelineIds.length || !videoId) return
    setRunningType('strategy')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      const res = await apiPost('/broll/pipeline/run-strategies', {
        prep_pipeline_id: prepPipelineId,
        analysis_pipeline_ids: completedAnalysisPipelineIds,
        video_id: videoId,
        group_id: groupId,
      })
      setPipelineIds(res.strategyPipelineIds || [])
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  // Find the completed plan pipeline ID (for resuming keywords/search - old style)
  const completedPlanPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === planStrategy?.id)
  )
  const planPipelineId = completedPlanPipeline?.[0] || null

  async function handleRunNewPlan() {
    const selected = [...selectedStrategies]
    if (!prepPipelineId || !selected.length || !videoId) return
    setRunningType('plan')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      // 1. Clean strategy outputs (strip reference-only fields) for each selected
      await Promise.all(selected.map(stratId =>
        apiPost('/broll/pipeline/clean-strategy', { strategy_pipeline_id: stratId })
      ))

      // 2. Fire plan for each selected strategy
      const planPipelineIds = []
      for (const stratId of selected) {
        const res = await apiPost('/broll/pipeline/run-plan', {
          prep_pipeline_id: prepPipelineId,
          strategy_pipeline_id: stratId,
          video_id: videoId,
          group_id: groupId,
        })
        if (res.planPipelineId) planPipelineIds.push(res.planPipelineId)
      }
      if (planPipelineIds.length) setPipelineIds(planPipelineIds)
      else if (planPipelineIds[0]) setPipelineId(planPipelineIds[0])
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function openResetModal() {
    setResetError(null)
    setResetPreview(null)
    setResetConfirming(true)
    try {
      const res = await authFetch(`/broll/groups/${groupId}/reset-searches/preview`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || 'Preview failed')
      }
      setResetPreview(await res.json())
    } catch (err) {
      setResetError(err.message)
    }
  }

  async function confirmReset() {
    setResetLoading(true)
    setResetError(null)
    try {
      const res = await apiPost(`/broll/groups/${groupId}/reset-searches`)
      setResetConfirming(false)
      setResetPreview(null)
      refetchRuns()
    } catch (err) {
      setResetError(err.message)
    } finally {
      setResetLoading(false)
    }
  }

  async function handleRunSearch() {
    // Collect all completed plan pipeline IDs
    const planPids = Object.entries(pipelineMap)
      .filter(([pid, p]) => p.status === 'complete' && pid.startsWith('plan-'))
      .map(([pid]) => pid)
    if (!planPids.length) return
    setRunningType('search')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      // Unified search: keywords + GPU search, interleaved across variants
      const res = await apiPost('/broll/pipeline/search-next-batch', {
        plan_pipeline_ids: planPids,
        batch_size: 10,
      })
      const batchPid = res.pipelineId

      // Poll until first GPU search completes, then navigate to editor
      const pollForFirstResult = async () => {
        if (!batchPid) return
        for (let i = 0; i < 120; i++) { // max ~6 min
          await new Promise(r => setTimeout(r, 3000))
          try {
            const prog = await authFetch(`/broll/pipeline/${batchPid}/progress`)
            const data = await prog.json()
            if (data.phase === 'gpu_search') {
              // Queue entries exist — navigate to editor so user can see them processing
              navigate(`/editor/${id}/brolls/edit`)
              return
            }
            if (data.status === 'complete') {
              navigate(`/editor/${id}/brolls/edit`)
              return
            }
            if (data.status === 'failed') {
              setError(`Search failed: ${data.error || 'Unknown error'}`)
              setRunningType(null)
              return
            }
          } catch {}
        }
        setError('Search timed out')
        setRunningType(null)
      }
      pollForFirstResult()
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  // Helpers for editing/deleting plan placements
  async function savePlacement(ch, placementIdx, updates) {
    if (!ch.runId || !ch.parsed) return
    setSavingField(true)
    try {
      const updated = JSON.parse(JSON.stringify(ch.parsed))
      const p = updated.placements?.[placementIdx]
      if (p) Object.assign(p, updates)
      const newOutput = '```json\n' + JSON.stringify(updated, null, 2) + '\n```'
      await apiPut(`/broll/runs/${ch.runId}/output`, { output_text: newOutput })
      refetchRuns()
    } catch (err) { console.error('[save-placement]', err) }
    finally { setSavingField(false); setEditingField(null); setFieldValue('') }
  }

  async function deletePlacement(ch, placementIdx) {
    if (!ch.runId || !ch.parsed) return
    setSavingField(true)
    try {
      const updated = JSON.parse(JSON.stringify(ch.parsed))
      updated.placements?.splice(placementIdx, 1)
      if (updated.total_placements != null) updated.total_placements = updated.placements.length
      const newOutput = '```json\n' + JSON.stringify(updated, null, 2) + '\n```'
      await apiPut(`/broll/runs/${ch.runId}/output`, { output_text: newOutput })
      refetchRuns()
    } catch (err) { console.error('[delete-placement]', err) }
    finally { setSavingField(false) }
  }

  function origIdx(ch, p) { return ch.placements.indexOf(p) }

  const isRunning = !!runningType

  // Determine the current stage based on completion
  const currentStageKey = hasCompletedBrollSearch ? 'search'
    : (hasCompletedNewPlan || hasCompletedPlan) ? 'plan'
    : hasCompletedStrategies ? 'strategy'
    : 'analysis'

  // URL-based sub-routing for brolls
  // Redirect bare /brolls to /brolls/strategy or /brolls/edit based on state
  useEffect(() => {
    if (runsLoading) return
    if (!sub) {
      if (hasCompletedBrollSearch && (newPlanPipelineId || planPipelineId)) {
        navigate(`/editor/${id}/brolls/edit`, { replace: true })
      } else {
        navigate(`/editor/${id}/brolls/strategy/${currentStageKey}`, { replace: true })
      }
    }
    // Redirect /brolls/strategy without a stage to analysis (first stage)
    if (sub === 'strategy' && !detail) {
      navigate(`/editor/${id}/brolls/strategy/analysis`, { replace: true })
    }
    // Redirect old numeric placement URLs (e.g. /brolls/5) to /brolls/edit/5
    if (sub && sub !== 'strategy' && sub !== 'edit' && !isNaN(Number(sub))) {
      navigate(`/editor/${id}/brolls/edit/${sub}`, { replace: true })
    }
    // When keywords are done, redirect search step to editor (only if plan exists)
    if (sub === 'strategy' && detail === 'search' && hasCompletedBrollSearch && (newPlanPipelineId || planPipelineId)) {
      navigate(`/editor/${id}/brolls/edit`, { replace: true })
    }
    // Redirect to correct step if URL points to a step that isn't reached yet (but not while running/searching)
    // Only redirect forward — allow viewing earlier completed stages
    if (sub === 'strategy' && detail && !runningType && !pipelineIds.length) {
      const stepOrder = ['analysis', 'strategy', 'plan', 'search']
      const currentIdx = stepOrder.indexOf(currentStageKey)
      const urlIdx = stepOrder.indexOf(detail)
      if (urlIdx > currentIdx) {
        navigate(`/editor/${id}/brolls/strategy/${currentStageKey}`, { replace: true })
      }
    }
  }, [sub, detail, runsLoading, hasCompletedBrollSearch, currentStageKey, id, navigate])

  const activeStage = detail || currentStageKey

  // Show loading screen while keywords are generating (before navigating to editor)
  if (runningType === 'search' && sub !== 'edit' && activeStage === 'search') {
    const progs = Object.values(pipelineProgresses)
    const completedCount = progs.filter(p => p.status === 'complete').length
    const totalVariants = progs.length || pipelineIds.length
    const stageName = progs.find(p => p.status === 'running')?.stageName || 'Preparing...'

    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <Loader2 size={32} className="text-[#cefc00] animate-spin mx-auto mb-4" />
          <h2 className="text-lg font-bold text-zinc-100 mb-2">Searching B-Roll</h2>
          <p className="text-zinc-500 text-sm mb-4">{stageName}</p>
          {totalVariants > 0 && (
            <div className="space-y-2">
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>{completedCount}/{totalVariants} variants</span>
              </div>
              <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden">
                <div className="h-full bg-[#cefc00] transition-all" style={{ width: `${Math.max(totalVariants ? (completedCount / totalVariants) * 100 : 0, 5)}%` }} />
              </div>
            </div>
          )}
          <p className="text-zinc-600 text-xs mt-4">Will open the editor once keywords for the first variant are ready</p>
        </div>
      </div>
    )
  }

  // Show B-Roll editor when sub === 'edit' (only if plan data exists)
  if (sub === 'edit') {
    if (runsLoading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="text-primary-fixed animate-spin" />
        </div>
      )
    }
    const editorPlanPid = newPlanPipelineId || planPipelineId
    if (!editorPlanPid) {
      // No plan data — redirect back to strategy pipeline
      navigate(`/editor/${id}/brolls/strategy/${currentStageKey}`, { replace: true })
      return null
    }
    const allPlanPipelineIds = Object.entries(pipelineMap)
      .filter(([pid, p]) => p.status === 'complete' && pid.startsWith('plan-'))
      .map(([pid]) => pid)
    return <BRollEditor groupId={groupId} videoId={videoId} planPipelineId={editorPlanPid} allPlanPipelineIds={allPlanPipelineIds} planVariants={planVariants} />
  }

  // Show loading while checking if steps are already complete (prevents flash of steps UI)
  if (runsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-primary-fixed animate-spin" />
      </div>
    )
  }

  const refVideos = examples || []

  // Pipeline step config
  const isAnalysisDone = hasCompletedAnalysis && hasCompletedPrep
  const isStrategyDone = hasCompletedStrategies && runningType !== 'strategy'
  const isPlanDone = hasCompletedNewPlan || hasCompletedPlan
  const kwPipelineId = newPlanPipelineId || planPipelineId

  const steps = [
    { key: 'analysis', label: 'Analyze & Prepare', icon: Search, done: isAnalysisDone, enabled: true, action: handleRunAnalysis, running: runningType === 'analysis' },
    { key: 'strategy', label: 'Generate Strategies', icon: Layers, done: isStrategyDone, enabled: isAnalysisDone, action: handleRunStrategies, running: runningType === 'strategy' },
    { key: 'plan', label: 'Generate Plan', icon: Sparkles, done: isPlanDone, enabled: isStrategyDone && selectedStrategies.size > 0, action: handleRunNewPlan, running: runningType === 'plan' },
    { key: 'search', label: 'Search B-Roll', icon: Film, done: hasCompletedBrollSearch, enabled: isPlanDone, action: handleRunSearch, running: runningType === 'search' },
  ]

  // CTA is the first incomplete actionable step (regardless of which page we're on)
  const currentStepIdx = steps.findIndex(s => s.key === activeStage)
  const ctaIndex = steps.findIndex(s => !s.done && !s.running && s.enabled)

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 pt-8 pb-12">
        {/* Pipeline Steps Bar */}
        <div className="flex items-center gap-1 mb-6 bg-zinc-900 rounded-xl p-2">
          {steps.map((step, i) => {
            const Icon = step.icon
            const isActive = step.running
            const isHere = step.key === activeStage
            const isCTA = i === ctaIndex && step.enabled && !step.done && !isRunning
            // Can only navigate to done steps or the current step
            const canNavigate = step.done || isHere
            return (
              <button
                key={step.key}
                onClick={isCTA ? () => { step.action(); navigate(`/editor/${id}/brolls/strategy/${step.key}`) } : canNavigate ? () => navigate(`/editor/${id}/brolls/strategy/${step.key}`) : undefined}
                disabled={!isCTA && !canNavigate && !isActive}
                className={`relative flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex-1 justify-center disabled:opacity-30 ${
                  isCTA
                    ? 'bg-[#cefc00] text-zinc-900 hover:bg-[#d8ff33] shadow-[0_0_16px_rgba(206,252,0,0.3)]'
                    : isActive
                    ? 'bg-zinc-800 text-[#cefc00]'
                    : isHere
                    ? 'text-[#cefc00] bg-zinc-800'
                    : step.done
                    ? 'text-white hover:bg-zinc-800'
                    : 'text-zinc-500'
                }`}
              >
                {isActive ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : step.done ? (
                  <CheckCircle size={12} />
                ) : (
                  <Icon size={12} />
                )}
                {step.label}
                {isCTA && <span className="ml-1">→</span>}
                {isHere && <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-[#cefc00] rounded-full" />}
              </button>
            )
          })}
        </div>

        {/* Section header */}
        <header className="mb-6">
          <div className="flex items-center gap-2 text-[#cefc00] mb-2">
            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>auto_awesome</span>
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">B-Roll Strategy</span>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-zinc-100">
            {activeStage === 'plan' && runningType === 'plan' ? 'Generating Plans...' : activeStage === 'plan' && planVariants.length ? 'B-Roll Plans' : activeStage === 'strategy' && runningType === 'strategy' ? 'Generating Strategies...' : activeStage === 'strategy' && hasCompletedStrategies ? 'Choose Your Strategy' : 'Reference & Main Video Analysis'}
          </h1>
          {activeStage === 'strategy' && hasCompletedStrategies && !isRunning && (
            <p className="text-zinc-500 text-sm mt-2">Select one or more strategies to use for plan generation. Each variant is based on a different reference video's style.</p>
          )}
          {activeStage === 'strategy' && runningType === 'strategy' && (
            <p className="text-zinc-500 text-sm mt-2">Creating B-Roll strategies from your reference videos. Each variant adapts a different reference's style to your video.</p>
          )}
          {activeStage === 'plan' && runningType === 'plan' && (
            <p className="text-zinc-500 text-sm mt-2">Creating B-Roll placement plans from your selected strategies.</p>
          )}
          {activeStage === 'plan' && planVariants.length > 0 && !isRunning && (
            <p className="text-zinc-500 text-sm mt-2">Generated B-Roll placement plans. Each plan corresponds to a strategy variant.</p>
          )}
        </header>

        {/* ═══ STRATEGY GENERATION PROGRESS ═══ */}
        {activeStage === 'strategy' && runningType === 'strategy' && pipelineIds.length > 0 && (
          <section className="space-y-4 mb-8">
            {pipelineIds.map((pid, idx) => {
              const prog = pipelineProgresses[pid]
              const isCombined = pid.startsWith('cstrat-')
              const label = isCombined ? 'Combined Strategy (Best of All)' : `Variant ${String.fromCharCode(65 + idx)}`
              const pct = prog?.totalStages > 0 ? Math.round((((prog.stageIndex || 0) + (prog.subTotal > 0 ? (prog.subDone || 0) / prog.subTotal : 0)) / prog.totalStages) * 100) : 0
              const isDone = prog?.status === 'complete'
              const isFailed = prog?.status === 'failed'
              const subLabel = prog?.subTotal ? `${prog.subLabel || ''} (${prog.subDone || 0}/${prog.subTotal})` : ''

              return (
                <div key={pid} className={`bg-zinc-900 rounded-xl p-5 border ${isDone ? 'border-[#cefc00]/20' : isFailed ? 'border-red-900/30' : 'border-zinc-800/50'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {isDone ? (
                        <span className="material-symbols-outlined text-[#cefc00] text-lg" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                      ) : isFailed ? (
                        <AlertCircle size={18} className="text-red-400" />
                      ) : (
                        <Loader2 size={18} className="text-[#cefc00] animate-spin" />
                      )}
                      <div>
                        <span className="text-sm font-bold text-zinc-100">{label}</span>
                        {prog?.strategyName && !isCombined && (
                          <span className="text-xs text-zinc-500 ml-2">({prog.strategyName})</span>
                        )}
                      </div>
                    </div>
                    <span className={`text-sm font-black ${isDone ? 'text-[#cefc00]' : isFailed ? 'text-red-400' : 'text-[#cefc00]'}`}>
                      {isDone ? 'Done' : isFailed ? 'Failed' : `${pct}%`}
                    </span>
                  </div>
                  {!isDone && !isFailed && (
                    <>
                      <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden mb-2">
                        <div className="h-full bg-[#cefc00] transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {prog?.stageName || 'Starting...'}
                        {subLabel ? ` — ${subLabel}` : ''}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {/* ═══ STRATEGY VARIANTS VIEW ═══ */}
        {activeStage === 'strategy' && hasCompletedStrategies && !isRunning && (
          <section className="space-y-6">

            {/* Strategy variant cards */}
            {strategyVariants.map((variant) => {
              const isSelected = selectedStrategies.has(variant.pipelineId)
              const isExpanded = !!expandedCards[`strat-${variant.pipelineId}`]
              const totalBeats = variant.chapters.reduce((sum, ch) => sum + (ch.strategyBeats?.length || ch.beats?.length || 0), 0)

              return (
                <div
                  key={variant.pipelineId}
                  className={`bg-zinc-900 rounded-xl overflow-hidden flex flex-col group transition-all border-2 ${
                    isSelected ? 'border-[#cefc00]/40 shadow-[0_0_24px_rgba(206,252,0,0.1)]' : 'border-transparent hover:border-zinc-700/50'
                  }`}
                >
                  {/* Card header — clickable to toggle selection */}
                  <div
                    className="flex items-start justify-between gap-4 p-5 pb-3 cursor-pointer"
                    onClick={() => setSelectedStrategies(prev => {
                      const next = new Set(prev)
                      if (next.has(variant.pipelineId)) next.delete(variant.pipelineId)
                      else next.add(variant.pipelineId)
                      return next
                    })}
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      {/* Selection checkbox */}
                      <button
                        className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                          isSelected
                            ? 'bg-[#cefc00] border-[#cefc00]'
                            : 'border-zinc-600 hover:border-zinc-400'
                        }`}
                      >
                        {isSelected && <Check size={12} className="text-zinc-900" strokeWidth={3} />}
                      </button>

                      <div className="flex-1 min-w-0">
                        <p className="text-base font-bold text-zinc-100 truncate flex items-center gap-2">
                          {variant.label}
                          {variant.isCombined && <span className="text-[9px] px-2 py-0.5 rounded bg-[#cefc00]/10 text-[#cefc00] font-bold uppercase tracking-wide">Recommended</span>}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          {variant.isCombined ? (
                            <>
                              <span className="material-symbols-outlined text-[#cefc00] shrink-0" style={{ fontSize: '13px' }}>merge</span>
                              <span className="text-[11px] text-[#cefc00]/80 font-medium">Combined from all references</span>
                            </>
                          ) : variant.refSource ? (
                            <span className="text-[11px] text-zinc-400 flex items-center gap-2">
                              Based on: <span className="text-zinc-300">{variant.refSource.label || variant.refSource.video_title || 'Reference'}</span>
                              <span className="text-zinc-700">·</span>
                              <span className="flex items-center gap-1">
                                {variant.refSource.is_favorite && <Star size={9} className="text-[#cefc00] fill-[#cefc00]" />}
                                <span className={`text-[10px] font-bold uppercase tracking-wider ${variant.refSource.is_favorite ? 'text-[#cefc00]' : 'text-zinc-600'}`}>
                                  {variant.refSource.is_favorite ? 'Primary' : 'Alternative'}
                                </span>
                              </span>
                            </span>
                          ) : (
                            <span className="text-[11px] text-zinc-500">{variant.chapters.length} chapters</span>
                          )}
                        </div>
                        {isSelected && (
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[9px] px-2 py-0.5 rounded bg-[#cefc00]/10 text-[#cefc00] font-bold uppercase tracking-wide flex items-center gap-1">
                              <Check size={8} strokeWidth={3} /> Selected
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                  </div>

                  {/* Chapters & strategy content — mirrors analysis view */}
                  <div className="px-5 pb-5 flex flex-col justify-between">
                    <div>
                      <h3 className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-2">
                        Chapters ({variant.chapters.length}) · {totalBeats} beats
                      </h3>

                      {(() => {
                        // Save a single field edit to DB
                        async function saveField(ch, bi, field, value, spIndex) {
                          if (!ch.runId || !ch.parsed) return
                          setSavingField(true)
                          try {
                            const updated = JSON.parse(JSON.stringify(ch.parsed))
                            const bs = updated.beat_strategies || updated.beatStrategies || []
                            const sbIdx = bs.findIndex(s => s.beat_name?.toLowerCase().trim() === ch.beats?.[bi]?.name?.toLowerCase().trim())
                            const target = bs[sbIdx >= 0 ? sbIdx : bi]
                            if (bi === -1) {
                              // Chapter-level field
                              if (field === 'ch_description') updated.chapter_description_override = value
                              if (field === 'ch_purpose') updated.chapter_purpose_override = value
                              if (field === 'ch_broll_per_min') updated.broll_per_min_override = value
                              if (field === 'ch_avg_broll_dur') updated.avg_broll_dur_override = value
                            } else if (target) {
                              if (field === 'emotion') target.beat_emotion = value
                              if (field === 'description') target.beat_description = value
                              if (field === 'purpose') target.beat_purpose = value
                              if (field === 'sp' && spIndex != null) target.strategy_points[spIndex] = value
                              if (['beat_broll_per_min', 'beat_avg_broll_dur', 'beat_gp_per_min', 'beat_duration'].includes(field)) {
                                // Ensure all displayed frequency values are persisted (enriched data may not be in sub-run yet)
                                const displayBeat = ch.strategyBeats?.find(s => s.name?.toLowerCase().trim() === target?.beat_name?.toLowerCase().trim()) || ch.strategyBeats?.[bi]
                                if (!target.reference_frequency) target.reference_frequency = {}
                                const rf = target.reference_frequency
                                if (rf.broll_per_minute == null && displayBeat?.brollPerMin != null) rf.broll_per_minute = displayBeat.brollPerMin
                                if (rf.broll_avg_duration_seconds == null && displayBeat?.avgBrollDur != null) rf.broll_avg_duration_seconds = displayBeat.avgBrollDur
                                if (rf.gp_per_minute == null && displayBeat?.gpPerMin != null) rf.gp_per_minute = displayBeat.gpPerMin
                                if (rf.beat_duration_seconds == null && displayBeat?.beatDuration != null) rf.beat_duration_seconds = displayBeat.beatDuration
                                // Apply the user's edit
                                if (field === 'beat_broll_per_min') rf.broll_per_minute = value === '' ? null : Number(value)
                                if (field === 'beat_avg_broll_dur') rf.broll_avg_duration_seconds = value === '' ? null : Number(value)
                                if (field === 'beat_gp_per_min') rf.gp_per_minute = value === '' ? null : Number(value)
                                if (field === 'beat_duration') rf.beat_duration_seconds = value === '' ? null : Number(value)
                              }
                            }
                            const newOutput = '```json\n' + JSON.stringify(updated, null, 2) + '\n```'
                            await apiPut(`/broll/runs/${ch.runId}/output`, { output_text: newOutput })
                            refetchRuns()
                          } catch (err) {
                            console.error('[save-field] Error:', err)
                          } finally {
                            setSavingField(false)
                            setEditingField(null)
                            setFieldValue('')
                          }
                        }

                        function isEditing(ci, bi, field, spIndex) {
                          const e = editingField
                          return e && e.pipelineId === variant.pipelineId && e.ci === ci && e.bi === bi && e.field === field && (spIndex == null || e.spIndex === spIndex)
                        }

                        function startEdit(ci, bi, field, currentValue, spIndex) {
                          setEditingField({ pipelineId: variant.pipelineId, ci, bi, field, spIndex })
                          setFieldValue(currentValue || '')
                        }

                        const renderChapter = (ch, ci) => {
                          return (
                            <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                              {/* Chapter header */}
                              <div className="flex items-start justify-between gap-3 mb-2">
                                <p className="text-zinc-200 font-bold text-xs">
                                  {ch.name || ch.label} {ch.start && <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start}</span>}
                                </p>
                              </div>

                              {/* Chapter description — editable */}
                              {ch.description && (isEditing(ci, -1, 'ch_description') ? (
                                <div className="mt-0.5 mb-1">
                                  <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 min-h-[36px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                  <div className="flex gap-1.5 mt-1">
                                    <button onClick={() => saveField(ch, -1, 'ch_description', fieldValue)} disabled={savingField} className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                    <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-zinc-400 text-xs leading-relaxed">
                                  <span className="material-symbols-outlined text-[#cefc00] align-middle mr-1" style={{ fontSize: '12px' }}>description</span>
                                  {ch.description}
                                  <button onClick={() => startEdit(ci, -1, 'ch_description', ch.description)} className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle"><Pencil size={9} /></button>
                                </p>
                              ))}

                              {/* Chapter purpose — editable */}
                              {ch.purpose && (isEditing(ci, -1, 'ch_purpose') ? (
                                <div className="mt-0.5 mb-2">
                                  <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 min-h-[36px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                  <div className="flex gap-1.5 mt-1">
                                    <button onClick={() => saveField(ch, -1, 'ch_purpose', fieldValue)} disabled={savingField} className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                    <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-zinc-500 text-[11px] italic leading-relaxed mb-2">
                                  <span className="material-symbols-outlined text-[#cefc00] align-middle mr-1 not-italic" style={{ fontSize: '11px' }}>target</span>
                                  {ch.purpose}
                                  <button onClick={() => startEdit(ci, -1, 'ch_purpose', ch.purpose)} className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle not-italic"><Pencil size={9} /></button>
                                </p>
                              ))}

                              {/* Beats — with per-beat edit */}
                              {ch.beats?.length > 0 && (
                                <div className="mt-2 space-y-2.5">
                                  <p className="text-[9px] text-[#c180ff] font-bold uppercase">Beats ({ch.beats.length})</p>
                                  {ch.beats.map((beat, bi) => {
                                    const sb = ch.strategyBeats?.find(s =>
                                      s.name?.toLowerCase().trim() === beat.name?.toLowerCase().trim()
                                    ) || ch.strategyBeats?.[bi]
                                    const hasSb = sb && (sb.matched_reference_beat || sb.strategy_points?.length)
                                    return (
                                      <div key={bi} className={`border-l-2 pl-3 ${hasSb ? 'border-[#c180ff]/40' : 'border-zinc-800'}`}>
                                        {/* Beat name + duration + frequency */}
                                        <div className="flex items-start justify-between gap-2">
                                          <p className="text-zinc-300 text-[11px] font-medium">
                                            {beat.name} <span className="font-mono text-zinc-600 font-normal text-[10px]">{beat.start || beat.start_tc || (beat.start_seconds != null ? formatDuration(beat.start_seconds) : '')}</span>
                                            {sb?.beatDuration != null && (
                                              <span className="font-mono text-zinc-500 font-normal text-[10px] ml-1">({sb.beatDuration}s)</span>
                                            )}
                                          </p>
                                          {sb && (sb.brollPerMin != null || sb.avgBrollDur != null || sb.gpPerMin != null) && (
                                            <div className="flex gap-2 shrink-0">
                                              {(() => {
                                                const freqFields = [
                                                  { key: 'beat_broll_per_min', label: 'avg. b-roll / min', value: sb.brollPerMin, color: 'text-[#cefc00]', format: v => v },
                                                  { key: 'beat_avg_broll_dur', label: 'avg. duration', value: sb.avgBrollDur, color: 'text-zinc-300', format: v => `${v}s` },
                                                ]
                                                return freqFields.map(f => f.value != null && (
                                                  isEditing(ci, bi, f.key) ? (
                                                    <div key={f.key}>
                                                      <input value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-12 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300 text-right focus:ring-1 focus:ring-[#cefc00]/30 outline-none" autoFocus />
                                                      <div className="flex gap-0.5 mt-0.5 justify-end">
                                                        <button onClick={() => saveField(ch, bi, f.key, fieldValue)} disabled={savingField} className="px-1 py-0.5 bg-[#cefc00] text-zinc-900 text-[7px] font-bold rounded">{savingField ? '..' : 'OK'}</button>
                                                        <button onClick={() => setEditingField(null)} className="px-1 py-0.5 text-zinc-500 text-[7px] font-bold hover:text-zinc-300">X</button>
                                                      </div>
                                                    </div>
                                                  ) : (
                                                    <div key={f.key} className="text-right cursor-pointer group/freq" onClick={() => startEdit(ci, bi, f.key, f.value ?? '')}>
                                                      <p className="text-[8px] text-zinc-600 uppercase">{f.label}</p>
                                                      <p className={`text-[10px] font-mono ${f.color} flex items-center justify-end gap-0.5`}>
                                                        {f.format(f.value)}
                                                        <span className="text-zinc-700 group-hover/freq:text-zinc-400"><Pencil size={7} /></span>
                                                      </p>
                                                    </div>
                                                  )
                                                ))
                                              })()}
                                            </div>
                                          )}
                                        </div>

                                        {/* Description — editable */}
                                        {beat.description && (isEditing(ci, bi, 'description') ? (
                                          <div className="mt-0.5">
                                            <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 min-h-[36px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                            <div className="flex gap-1.5 mt-1">
                                              <button onClick={() => saveField(ch, bi, 'description', fieldValue)} disabled={savingField} className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                              <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                            </div>
                                          </div>
                                        ) : (
                                          <p className="text-zinc-500 text-[11px] leading-relaxed">
                                            <span className="material-symbols-outlined text-[#cefc00] align-middle mr-1" style={{ fontSize: '11px' }}>description</span>
                                            {beat.description}
                                            {sb && <button onClick={() => startEdit(ci, bi, 'description', beat.description)} className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle"><Pencil size={9} /></button>}
                                          </p>
                                        ))}

                                        {/* Purpose — editable */}
                                        {beat.purpose && (isEditing(ci, bi, 'purpose') ? (
                                          <div className="mt-0.5">
                                            <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 min-h-[36px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                            <div className="flex gap-1.5 mt-1">
                                              <button onClick={() => saveField(ch, bi, 'purpose', fieldValue)} disabled={savingField} className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                              <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                            </div>
                                          </div>
                                        ) : (
                                          <p className="text-zinc-500 text-[11px] italic leading-relaxed">
                                            <span className="material-symbols-outlined text-[#cefc00] align-middle mr-1 not-italic" style={{ fontSize: '11px' }}>target</span>
                                            {beat.purpose}
                                            {sb && <button onClick={() => startEdit(ci, bi, 'purpose', beat.purpose)} className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle not-italic"><Pencil size={9} /></button>}
                                          </p>
                                        ))}

                                        {/* Emotion — editable */}
                                        {(sb?.emotion || beat.emotion) && (isEditing(ci, bi, 'emotion') ? (
                                          <div className="mt-0.5">
                                            <input value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 focus:ring-1 focus:ring-[#cefc00]/30 outline-none" />
                                            <div className="flex gap-1.5 mt-1">
                                              <button onClick={() => saveField(ch, bi, 'emotion', fieldValue)} disabled={savingField} className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                              <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                            </div>
                                          </div>
                                        ) : (
                                          <p className="text-zinc-500 text-[11px] leading-relaxed">
                                            <span className="material-symbols-outlined text-[#c180ff] align-middle mr-1" style={{ fontSize: '11px' }}>mood</span>
                                            {sb?.emotion || beat.emotion}
                                            {sb && <button onClick={() => startEdit(ci, bi, 'emotion', sb?.emotion || beat.emotion)} className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle"><Pencil size={9} /></button>}
                                          </p>
                                        ))}

                                        {/* Strategy points — each editable separately */}
                                        {sb?.strategy_points?.length > 0 && (
                                          <ul className="mt-1 space-y-0.5">
                                            {sb.strategy_points.map((sp, si) => {
                                              const spText = typeof sp === 'string' ? sp : sp.what || JSON.stringify(sp)
                                              return isEditing(ci, bi, 'sp', si) ? (
                                                <li key={si} className="mt-1">
                                                  <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 min-h-[60px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                                  <div className="flex gap-1.5 mt-1">
                                                    <button onClick={() => saveField(ch, bi, 'sp', fieldValue, si)} disabled={savingField} className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                                    <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                                  </div>
                                                </li>
                                              ) : (
                                                <li key={si} className="text-zinc-400 text-[11px] leading-relaxed">
                                                  <span className="text-[#cefc00]/50 mr-1">-</span>
                                                  {spText}
                                                  <button onClick={() => startEdit(ci, bi, 'sp', spText, si)} className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle"><Pencil size={9} /></button>
                                                </li>
                                              )
                                            })}
                                          </ul>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        }

                        return isExpanded ? (
                          <div className="space-y-3">
                            {variant.chapters.map(renderChapter)}
                          </div>
                        ) : (
                          <div className="relative">
                            <div className="space-y-3 max-h-[120px] overflow-hidden">
                              {variant.chapters.map(renderChapter)}
                            </div>
                            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none" />
                          </div>
                        )
                      })()}

                      <button
                        onClick={() => setExpandedCards(prev => ({ ...prev, [`strat-${variant.pipelineId}`]: !prev[`strat-${variant.pipelineId}`] }))}
                        className="w-full flex items-center justify-center gap-1.5 mt-2 py-1.5 text-[10px] text-zinc-500 font-bold uppercase tracking-wider hover:text-zinc-300 transition-colors"
                      >
                        {isExpanded ? 'Collapse' : 'Expand to edit'}
                        <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>

                  </div>
                </div>
              )
            })}

            {/* Manual creation card */}
            <div className="bg-zinc-900 rounded-xl overflow-hidden flex flex-col group transition-all border-2 border-transparent hover:border-zinc-700/50">
              <div className="flex items-start justify-between gap-4 p-5 pb-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {/* Empty checkbox slot for alignment */}
                  <div className="mt-0.5 w-5 h-5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold text-zinc-100 truncate">Manual Creation</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="material-symbols-outlined text-zinc-400 shrink-0" style={{ fontSize: '13px' }}>upload_file</span>
                      <span className="text-[11px] text-zinc-500">Upload your own strategy document</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[9px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-bold uppercase tracking-wide">Custom</span>
                    </div>
                  </div>
                </div>
                <div className="w-[120px] h-[84px] rounded-lg overflow-hidden shrink-0 bg-zinc-950 flex items-center justify-center">
                  <span className="material-symbols-outlined text-zinc-700 text-3xl">edit_document</span>
                </div>
              </div>

              <div className="px-5 pb-5">
                <div
                  onClick={() => document.getElementById('manual-strategy-file')?.click()}
                  className="rounded-lg p-6 bg-zinc-950/50 border-2 border-dashed border-zinc-800 flex flex-col items-center justify-center gap-3 hover:bg-zinc-950 hover:border-zinc-700 transition-colors cursor-pointer group/drop min-h-[100px]"
                >
                  <span className="material-symbols-outlined text-[#cefc00]/50 group-hover/drop:text-[#cefc00]/70 transition-colors text-3xl">upload_file</span>
                  <div className="text-center">
                    <span className="text-xs font-medium text-zinc-400 group-hover/drop:text-zinc-300 block">Click to upload</span>
                    <span className="text-[10px] text-zinc-600 mt-0.5 block">.docx, .txt, or spreadsheet</span>
                  </div>
                  <input
                    id="manual-strategy-file"
                    type="file"
                    accept=".docx,.txt,.csv,.xlsx,.xls"
                    className="hidden"
                    onChange={(e) => {
                      // TODO: handle manual strategy file upload
                      const file = e.target.files?.[0]
                      if (file) console.log('[manual-strategy] File selected:', file.name)
                      e.target.value = ''
                    }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Progress card — single run */}
        {isRunning && progress && !pipelineIds.length && (() => {
          const pct = progress.totalStages > 0 ? Math.round(((progress.stageIndex + (progress.subTotal > 0 ? (progress.subDone || 0) / progress.subTotal : 0)) / progress.totalStages) * 100) : 0
          return (
            <div className="bg-zinc-900 rounded-xl p-5 mb-8 border border-zinc-800/50">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="text-[#cefc00] animate-spin" />
                  <span className="text-sm text-zinc-200 font-semibold">{progress.stageName || 'Processing...'}</span>
                </div>
                <span className="text-sm font-black text-[#cefc00]">{pct}%</span>
              </div>
              <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden mb-2">
                <div className="h-full bg-[#cefc00] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10px] text-zinc-500 font-mono">
                Stage {(progress.stageIndex || 0) + 1} of {progress.totalStages}
                {progress.subTotal ? ` — ${progress.subLabel || ''} (${progress.subDone || 0}/${progress.subTotal})` : ''}
                {progress.gpuStage ? ` · GPU: ${progress.gpuStage}${progress.gpuStatus ? ` (${progress.gpuStatus})` : ''}` : ''}
              </div>
            </div>
          )
        })()}

        {/* Error */}
        {error && !isRunning && (
          <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-4 flex items-start gap-2 mb-8">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm text-red-300">{error}</div>
          </div>
        )}

        {/* ═══ PLAN GENERATION PROGRESS ═══ */}
        {activeStage === 'plan' && runningType === 'plan' && pipelineIds.length > 0 && (
          <section className="space-y-4 mb-8">
            {pipelineIds.map((pid, idx) => {
              const prog = pipelineProgresses[pid]
              const isCombined = pid.includes('cstrat-') || prog?.strategyName?.toLowerCase().includes('combined')
              const label = isCombined ? 'Combined Plan (Best of All)' : `Plan ${String.fromCharCode(65 + idx)}`
              const pct = prog?.totalStages > 0 ? Math.round((((prog.stageIndex || 0) + (prog.subTotal > 0 ? (prog.subDone || 0) / prog.subTotal : 0)) / prog.totalStages) * 100) : 0
              const isDone = prog?.status === 'complete'
              const isFailed = prog?.status === 'failed'
              const subLabel = prog?.subTotal ? `${prog.subLabel || ''} (${prog.subDone || 0}/${prog.subTotal})` : ''

              return (
                <div key={pid} className={`bg-zinc-900 rounded-xl p-5 border ${isDone ? 'border-[#cefc00]/20' : isFailed ? 'border-red-900/30' : 'border-zinc-800/50'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {isDone ? (
                        <span className="material-symbols-outlined text-[#cefc00] text-lg" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                      ) : isFailed ? (
                        <AlertCircle size={18} className="text-red-400" />
                      ) : (
                        <Loader2 size={18} className="text-[#cefc00] animate-spin" />
                      )}
                      <div>
                        <span className="text-sm font-bold text-zinc-100">{label}</span>
                        {prog?.strategyName && (
                          <span className="text-xs text-zinc-500 ml-2">({prog.strategyName})</span>
                        )}
                      </div>
                    </div>
                    <span className={`text-sm font-black ${isDone ? 'text-[#cefc00]' : isFailed ? 'text-red-400' : 'text-[#cefc00]'}`}>
                      {isDone ? 'Done' : isFailed ? 'Failed' : `${pct}%`}
                    </span>
                  </div>
                  {!isDone && !isFailed && (
                    <>
                      <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden mb-2">
                        <div className="h-full bg-[#cefc00] transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {prog?.stageName || 'Starting...'}
                        {subLabel ? ` — ${subLabel}` : ''}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {/* ═══ PLAN VARIANTS VIEW ═══ */}
        {activeStage === 'plan' && planVariants.length > 0 && !isRunning && (
          <section className="space-y-6">
            {planVariants.map((plan) => {
              const isExpanded = !!expandedCards[`plan-${plan.pipelineId}`]

              return (
                <div key={plan.pipelineId} className="bg-zinc-900 rounded-xl overflow-hidden flex flex-col transition-all border-2 border-transparent hover:border-zinc-700/50">
                  {/* Plan card header */}
                  <div className="p-5 pb-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold text-zinc-100 truncate flex items-center gap-2">
                        {plan.label}
                        {plan.isCombined && <span className="text-[9px] px-2 py-0.5 rounded bg-[#cefc00]/10 text-[#cefc00] font-bold uppercase tracking-wide">Recommended</span>}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        {plan.isCombined ? (
                          <>
                            <span className="material-symbols-outlined text-[#cefc00] shrink-0" style={{ fontSize: '13px' }}>merge</span>
                            <span className="text-[11px] text-[#cefc00]/80 font-medium">Combined from all references</span>
                          </>
                        ) : plan.refSource ? (
                          <span className="text-[11px] text-zinc-400 flex items-center gap-2">
                            Based on: <span className="text-zinc-300">{plan.refSource.label || plan.refSource.video_title || 'Reference'}</span>
                            <span className="text-zinc-700">·</span>
                            <span className="flex items-center gap-1">
                              {plan.refSource.is_favorite && <Star size={9} className="text-[#cefc00] fill-[#cefc00]" />}
                              <span className={`text-[10px] font-bold uppercase tracking-wider ${plan.refSource.is_favorite ? 'text-[#cefc00]' : 'text-zinc-600'}`}>
                                {plan.refSource.is_favorite ? 'Primary' : 'Alternative'}
                              </span>
                            </span>
                          </span>
                        ) : null}
                      </div>
                      {/* Stats badges */}
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-[9px] px-2 py-0.5 rounded bg-[#cefc00]/10 text-[#cefc00] font-bold uppercase tracking-wide">
                          {plan.totalPlacements} placements
                        </span>
                        {plan.categories.broll > 0 && (
                          <span className="text-[9px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-bold uppercase tracking-wide">
                            {plan.categories.broll} B-Roll
                          </span>
                        )}
                        {plan.categories.graphic_package > 0 && (
                          <span className="text-[9px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-bold uppercase tracking-wide">
                            {plan.categories.graphic_package} Graphic
                          </span>
                        )}
                        {plan.categories.overlay_image > 0 && (
                          <span className="text-[9px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-bold uppercase tracking-wide">
                            {plan.categories.overlay_image} Overlay
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Chapters with placements — 3-level expandable */}
                  <div className="px-5 pb-5">
                    <h3 className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-2">
                      Chapters ({plan.chapters.length}) · {plan.totalPlacements} placements
                    </h3>

                    {/* Level 1: card-level expand shows chapters list */}
                    {isExpanded ? (
                      <div className="space-y-3">
                        {plan.chapters.map((ch, ci) => {
                          const chKey = `plan-ch-${plan.pipelineId}-${ci}`
                          const chExpanded = !!expandedCards[chKey]

                          // Group placements by beat
                          const beats = ch.beats || []
                          function tcToSec(tc) { const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/); return m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) : null }
                          const beatGroups = beats.map((beat, bi) => {
                            const beatStart = tcToSec(beat.start) ?? 0
                            const beatEnd = tcToSec(beat.end) ?? (beats[bi + 1] ? tcToSec(beats[bi + 1].start) : Infinity)
                            const matched = ch.placements.filter(p => {
                              const ps = typeof p.start === 'number' ? p.start : (tcToSec(p.start) ?? p.start_seconds ?? 0)
                              return ps >= beatStart && ps < beatEnd
                            })
                            return { beat, placements: matched }
                          })
                          const matchedSet = new Set(beatGroups.flatMap(g => g.placements))
                          const unmatched = ch.placements.filter(p => !matchedSet.has(p))

                          return (
                            <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                              {/* Chapter header — clickable to expand */}
                              <div className="flex items-start justify-between gap-3 mb-2">
                                <button
                                  onClick={() => setExpandedCards(prev => ({ ...prev, [chKey]: !prev[chKey] }))}
                                  className="flex items-center gap-1.5 text-left"
                                >
                                  <ChevronRight size={12} className={`text-zinc-600 transition-transform shrink-0 ${chExpanded ? 'rotate-90' : ''}`} />
                                  <p className="text-zinc-200 font-bold text-xs">
                                    {ch.name || ch.label} {ch.start && <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start}</span>}
                                  </p>
                                </button>
                                <div className="flex gap-3 shrink-0">
                                  <div className="text-right">
                                    <p className="text-[9px] text-zinc-600 uppercase">Placements</p>
                                    <p className="text-xs font-mono text-[#cefc00]">{ch.placementCount}</p>
                                  </div>
                                  {ch.duration_seconds && (
                                    <div className="text-right">
                                      <p className="text-[9px] text-zinc-600 uppercase">/min</p>
                                      <p className="text-xs font-mono text-zinc-300">{(ch.placementCount / (ch.duration_seconds / 60)).toFixed(1)}</p>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Chapter description + purpose — always visible */}
                              {ch.description && (
                                <p className="text-zinc-400 text-xs leading-relaxed flex items-start gap-1.5">
                                  <span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '12px', marginTop: '2px' }}>description</span>
                                  {ch.description}
                                </p>
                              )}
                              {ch.purpose && (
                                <p className="text-zinc-500 text-[11px] italic mb-2 flex items-start gap-1.5">
                                  <span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>
                                  {ch.purpose}
                                </p>
                              )}

                              {/* Beats summary — always visible */}
                              {beats.length > 0 && (
                                <p className="text-[9px] text-[#c180ff] font-bold uppercase mt-1 mb-1">Beats ({beats.length})</p>
                              )}
                              {!chExpanded && beats.length > 0 && (<>
                                <div className="relative">
                                  <div className="space-y-1.5 max-h-[100px] overflow-hidden">
                                    {beatGroups.filter(g => g.placements.length).map((g, gi) => (
                                      <div key={gi}>
                                        <p className="text-[10px] flex items-center gap-1.5">
                                          <span className="text-[#c180ff]/50">·</span>
                                          <span className="text-zinc-400 font-medium">{g.beat.name}</span>
                                          <span className="text-zinc-600">{g.beat.start}</span>
                                          <span className="text-zinc-600">·</span>
                                          <span className="font-mono text-zinc-500">{g.placements.length} placements</span>
                                        </p>
                                        {gi === 0 && g.placements.slice(0, 2).map((p, pi) => (
                                          <p key={pi} className="text-zinc-600 text-[10px] truncate pl-4 mt-0.5">
                                            <span className={`inline-block text-[8px] font-bold uppercase px-0.5 rounded mr-1 ${
                                              p.category === 'broll' ? 'bg-sky-900/30 text-sky-400'
                                              : p.category === 'graphic_package' ? 'bg-purple-900/30 text-purple-400'
                                              : 'bg-amber-900/30 text-amber-400'
                                            }`}>{p.category === 'broll' ? 'B' : p.category === 'graphic_package' ? 'G' : 'O'}</span>
                                            {p.description?.slice(0, 70)}{(p.description?.length || 0) > 70 ? '...' : ''}
                                          </p>
                                        ))}
                                      </div>
                                    ))}
                                  </div>
                                  <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-zinc-950/80 to-transparent pointer-events-none" />
                                </div>
                                <button
                                  onClick={() => setExpandedCards(prev => ({ ...prev, [chKey]: true }))}
                                  className="w-full flex items-center justify-center gap-1.5 mt-1 py-1 text-[10px] text-zinc-500 font-bold uppercase tracking-wider hover:text-zinc-300 transition-colors"
                                >
                                  Expand to edit
                                  <ChevronDown size={12} />
                                </button>
                              </>)}

                              {/* Level 2: chapter-level expand shows beats with placements */}
                              {chExpanded && (
                                <div className="mt-2 space-y-2">
                                  {beatGroups.map((group, gi) => {
                                    if (!group.placements.length) return null
                                    return (
                                      <div key={gi}>
                                        <p className="text-[9px] text-[#c180ff] font-bold uppercase mb-1 flex items-center justify-between">
                                          <span>{group.beat.name} <span className="text-zinc-600 font-normal">{group.beat.start}</span></span>
                                          <span className="text-zinc-500 font-mono">{group.placements.length}</span>
                                        </p>
                                        <div className="space-y-1.5">
                                          {group.placements.map((p, pi) => {
                                            const pIdx = origIdx(ch, p)
                                            const editKey = `plan-p-${plan.pipelineId}-${ci}-${pIdx}`
                                            const isEditingDesc = editingField?.pipelineId === plan.pipelineId && editingField?.field === editKey + '-desc'
                                            return (
                                              <div key={pi} className="border-l-2 border-zinc-800 pl-3 py-1 group/pl">
                                                <div className="flex items-center gap-2 text-[11px]">
                                                  <span className="font-mono text-zinc-600 text-[9px]">#{pIdx + 1}</span>
                                                  <span className={`inline-block text-[9px] font-bold uppercase px-1 py-0 rounded ${
                                                    p.category === 'broll' ? 'bg-sky-900/40 text-sky-300'
                                                    : p.category === 'graphic_package' ? 'bg-purple-900/40 text-purple-300'
                                                    : 'bg-amber-900/40 text-amber-300'
                                                  }`}>{p.category === 'broll' ? 'B-Roll' : p.category === 'graphic_package' ? 'Graphic' : 'Overlay'}</span>
                                                  <span className="text-zinc-300">{p.start || p.start_tc}–{p.end || p.end_tc}</span>
                                                  <button onClick={() => { if (confirm('Delete this placement?')) deletePlacement(ch, pIdx) }}
                                                    className="p-0.5 text-red-500/70 hover:text-red-400 shrink-0 transition-all" title="Delete placement">
                                                    <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>delete</span>
                                                  </button>
                                                </div>
                                                {/* Description — editable */}
                                                {isEditingDesc ? (
                                                  <div className="mt-0.5">
                                                    <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)}
                                                      className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 min-h-[36px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                                    <div className="flex gap-1.5 mt-1">
                                                      <button onClick={() => savePlacement(ch, pIdx, { description: fieldValue })} disabled={savingField}
                                                        className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                                      <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                                    </div>
                                                  </div>
                                                ) : (
                                                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                                                    <span className="material-symbols-outlined text-[#cefc00] align-middle mr-1" style={{ fontSize: '11px' }}>videocam</span>
                                                    {p.description}
                                                    <button onClick={() => { setEditingField({ pipelineId: plan.pipelineId, field: editKey + '-desc' }); setFieldValue(p.description || '') }}
                                                      className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle"><Pencil size={9} /></button>
                                                  </p>
                                                )}
                                                {p.audio_anchor && (
                                                  <p className="text-zinc-600 text-[10px] italic flex items-start gap-1">
                                                    <span className="material-symbols-outlined shrink-0 leading-none" style={{ fontSize: '10px', marginTop: '2px' }}>mic</span>
                                                    "{p.audio_anchor}"
                                                  </p>
                                                )}
                                                {/* Style — editable */}
                                                {p.style && (() => {
                                                  const styleEditKey = editKey + '-style'
                                                  const isEditingStyle = editingField?.pipelineId === plan.pipelineId && editingField?.field === styleEditKey
                                                  return isEditingStyle ? (
                                                    <div className="mt-1 space-y-1 bg-zinc-900/60 rounded-md p-2">
                                                      <div className="flex gap-2">
                                                        <div className="flex-1">
                                                          <label className="text-[8px] text-zinc-600 uppercase">Colors</label>
                                                          <input value={fieldValue?.colors ?? ''} onChange={(e) => setFieldValue(prev => ({ ...prev, colors: e.target.value }))}
                                                            className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 focus:ring-1 focus:ring-[#cefc00]/30 outline-none" />
                                                        </div>
                                                        <div className="flex-1">
                                                          <label className="text-[8px] text-zinc-600 uppercase">Temperature</label>
                                                          <input value={fieldValue?.temperature ?? ''} onChange={(e) => setFieldValue(prev => ({ ...prev, temperature: e.target.value }))}
                                                            className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 focus:ring-1 focus:ring-[#cefc00]/30 outline-none" />
                                                        </div>
                                                        <div className="flex-1">
                                                          <label className="text-[8px] text-zinc-600 uppercase">Motion</label>
                                                          <input value={fieldValue?.motion ?? ''} onChange={(e) => setFieldValue(prev => ({ ...prev, motion: e.target.value }))}
                                                            className="w-full bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 focus:ring-1 focus:ring-[#cefc00]/30 outline-none" />
                                                        </div>
                                                      </div>
                                                      <div className="flex gap-1.5">
                                                        <button onClick={() => savePlacement(ch, pIdx, { style: fieldValue })} disabled={savingField}
                                                          className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                                        <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                                      </div>
                                                    </div>
                                                  ) : (
                                                    <div className="flex flex-wrap items-center gap-2 mt-0.5">
                                                      {p.style.colors && <span className="text-zinc-600 text-[10px] flex items-center gap-0.5"><span className="material-symbols-outlined" style={{ fontSize: '10px' }}>palette</span>{p.style.colors}</span>}
                                                      {p.style.temperature && <span className="text-zinc-600 text-[10px] flex items-center gap-0.5"><span className="material-symbols-outlined" style={{ fontSize: '10px' }}>thermostat</span>{p.style.temperature}</span>}
                                                      {p.style.motion && <span className="text-zinc-600 text-[10px] flex items-center gap-0.5"><span className="material-symbols-outlined" style={{ fontSize: '10px' }}>animation</span>{p.style.motion}</span>}
                                                      <button onClick={() => { setEditingField({ pipelineId: plan.pipelineId, field: styleEditKey }); setFieldValue({ colors: p.style.colors || '', temperature: p.style.temperature || '', motion: p.style.motion || '' }) }}
                                                        className="inline-flex p-0.5 text-zinc-700 hover:text-zinc-400"><Pencil size={8} /></button>
                                                    </div>
                                                  )
                                                })()}
                                              </div>
                                            )
                                          })}
                                        </div>
                                      </div>
                                    )
                                  })}
                                  {unmatched.length > 0 && (
                                    <div>
                                      <p className="text-[9px] text-zinc-500 font-bold uppercase mb-1 flex items-center justify-between">
                                        <span>Other</span>
                                        <span className="font-mono">{unmatched.length}</span>
                                      </p>
                                      <div className="space-y-1.5">
                                        {unmatched.map((p, pi) => {
                                          const pIdx = origIdx(ch, p)
                                          const editKey = `plan-p-${plan.pipelineId}-${ci}-${pIdx}`
                                          const isEditingDesc = editingField?.pipelineId === plan.pipelineId && editingField?.field === editKey + '-desc'
                                          return (
                                            <div key={pi} className="border-l-2 border-zinc-800 pl-3 py-1 group/pl">
                                              <div className="flex items-start justify-between gap-1">
                                                <p className="text-zinc-300 text-[11px]">
                                                  <span className={`inline-block text-[9px] font-bold uppercase px-1 py-0 rounded mr-1.5 ${
                                                    p.category === 'broll' ? 'bg-sky-900/40 text-sky-300'
                                                    : p.category === 'graphic_package' ? 'bg-purple-900/40 text-purple-300'
                                                    : 'bg-amber-900/40 text-amber-300'
                                                  }`}>{p.category === 'broll' ? 'B-Roll' : p.category === 'graphic_package' ? 'Graphic' : 'Overlay'}</span>
                                                  {p.start || p.start_tc}–{p.end || p.end_tc}
                                                </p>
                                                <button onClick={() => { if (confirm('Delete this placement?')) deletePlacement(ch, pIdx) }}
                                                  className="p-0.5 text-zinc-700 hover:text-red-400 shrink-0 opacity-0 group-hover/pl:opacity-100 transition-all" title="Delete placement">
                                                  <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>close</span>
                                                </button>
                                              </div>
                                              {isEditingDesc ? (
                                                <div className="mt-0.5">
                                                  <textarea value={fieldValue} onChange={(e) => setFieldValue(e.target.value)}
                                                    className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 min-h-[36px] focus:ring-1 focus:ring-[#cefc00]/30 outline-none resize-y" />
                                                  <div className="flex gap-1.5 mt-1">
                                                    <button onClick={() => savePlacement(ch, pIdx, { description: fieldValue })} disabled={savingField}
                                                      className="px-2 py-0.5 bg-[#cefc00] text-zinc-900 text-[9px] font-bold uppercase rounded">{savingField ? '...' : 'Save'}</button>
                                                    <button onClick={() => setEditingField(null)} className="px-2 py-0.5 text-zinc-500 text-[9px] font-bold uppercase hover:text-zinc-300">Cancel</button>
                                                  </div>
                                                </div>
                                              ) : (
                                                <p className="text-zinc-400 text-[11px] leading-relaxed">
                                                  <span className="material-symbols-outlined text-[#cefc00] align-middle mr-1" style={{ fontSize: '11px' }}>videocam</span>
                                                  {p.description}
                                                  <button onClick={() => { setEditingField({ pipelineId: plan.pipelineId, field: editKey + '-desc' }); setFieldValue(p.description || '') }}
                                                    className="inline-flex ml-1 p-0.5 text-zinc-700 hover:text-zinc-400 align-middle"><Pencil size={9} /></button>
                                                </p>
                                              )}
                                              {p.style && (
                                                <div className="flex flex-wrap items-center gap-2 mt-0.5">
                                                  {p.style.colors && <span className="text-zinc-600 text-[10px] flex items-center gap-0.5"><span className="material-symbols-outlined" style={{ fontSize: '10px' }}>palette</span>{p.style.colors}</span>}
                                                  {p.style.temperature && <span className="text-zinc-600 text-[10px] flex items-center gap-0.5"><span className="material-symbols-outlined" style={{ fontSize: '10px' }}>thermostat</span>{p.style.temperature}</span>}
                                                  {p.style.motion && <span className="text-zinc-600 text-[10px] flex items-center gap-0.5"><span className="material-symbols-outlined" style={{ fontSize: '10px' }}>animation</span>{p.style.motion}</span>}
                                                </div>
                                              )}
                                            </div>
                                          )
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="relative">
                        <div className="max-h-[160px] overflow-hidden">
                          {plan.chapters.slice(0, 1).map((ch, ci) => {
                            const beats = ch.beats || []
                            function tcToSec(tc) { const m = String(tc).match(/\[?(\d{1,2}):(\d{2}):(\d{2})\]?/); return m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) : null }
                            const beatGroups = beats.map((beat, bi) => {
                              const beatStart = tcToSec(beat.start) ?? 0
                              const beatEnd = tcToSec(beat.end) ?? (beats[bi + 1] ? tcToSec(beats[bi + 1].start) : Infinity)
                              const matched = ch.placements.filter(p => {
                                const ps = typeof p.start === 'number' ? p.start : (tcToSec(p.start) ?? p.start_seconds ?? 0)
                                return ps >= beatStart && ps < beatEnd
                              })
                              return { beat, placements: matched }
                            })
                            return (
                              <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                                <div className="flex items-start justify-between gap-3 mb-1">
                                  <p className="text-zinc-200 font-bold text-xs">
                                    {ch.name || ch.label} {ch.start && <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start}</span>}
                                  </p>
                                  <span className="text-[10px] font-mono text-zinc-500 shrink-0">{ch.placementCount} placements</span>
                                </div>
                                {ch.description && (
                                  <p className="text-zinc-400 text-xs leading-relaxed flex items-start gap-1.5">
                                    <span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '12px', marginTop: '2px' }}>description</span>
                                    {ch.description}
                                  </p>
                                )}
                                {ch.purpose && (
                                  <p className="text-zinc-500 text-[11px] italic flex items-start gap-1.5">
                                    <span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>
                                    {ch.purpose}
                                  </p>
                                )}
                                {beats.length > 0 && (
                                  <div className="mt-1.5 space-y-1">
                                    <p className="text-[9px] text-[#c180ff] font-bold uppercase">Beats ({beats.length})</p>
                                    {beatGroups.filter(g => g.placements.length).slice(0, 1).map((g, gi) => (
                                      <p key={gi} className="text-zinc-500 text-[10px] truncate flex items-center gap-1.5">
                                        <span className="text-[#c180ff]/50">·</span>
                                        <span className="text-zinc-400">{g.beat.name}</span>
                                        <span className="text-zinc-600">{g.beat.start}</span>
                                        <span className="text-zinc-600">·</span>
                                        <span className="font-mono text-zinc-500">{g.placements.length} placements</span>
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none" />
                      </div>
                    )}
                    <button
                      onClick={() => setExpandedCards(prev => ({ ...prev, [`plan-${plan.pipelineId}`]: !prev[`plan-${plan.pipelineId}`] }))}
                      className="w-full flex items-center justify-center gap-1.5 mt-2 py-1.5 text-[10px] text-zinc-500 font-bold uppercase tracking-wider hover:text-zinc-300 transition-colors"
                    >
                      {isExpanded ? 'Collapse' : 'Expand to edit'}
                      <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>

                  </div>
                </div>
              )
            })}
            {isAdmin && activeStage === 'plan' && (hasCompletedBrollSearch || Object.keys(pipelineMap).some(pid => pid.startsWith('kw-') || pid.startsWith('bs-'))) && (
              <div className="mt-6 flex justify-end">
                <button
                  onClick={openResetModal}
                  className="text-xs text-red-400 hover:text-red-300 underline underline-offset-2"
                >
                  Admin: Reset B-Roll Searches
                </button>
              </div>
            )}
          </section>
        )}

        {/* ═══ ANALYSIS VIEW (shown when not on strategy step or strategies not yet done) ═══ */}
        {(activeStage !== 'strategy' || (!hasCompletedStrategies && runningType !== 'strategy')) && (activeStage !== 'plan' || (!planVariants.length && runningType !== 'plan')) && (<>

        {/* Reference Video Cards — only show when analysis is running or complete */}
        <section className="space-y-6">
          {refVideos.length === 0 && (
            <div className="bg-zinc-900 rounded-xl p-12 text-center border border-zinc-800/30">
              <span className="material-symbols-outlined text-4xl text-zinc-700 mb-3 block">video_library</span>
              <p className="text-zinc-500 text-sm">No reference videos added yet.</p>
              <p className="text-zinc-600 text-xs mt-1">Add reference videos in the project setup to analyze their b-roll patterns.</p>
            </div>
          )}

          {/* Pre-analysis prompt — show when we have references but analysis hasn't started */}
          {refVideos.length > 0 && !hasCompletedAnalysis && !isRunning && (
            <div className="flex flex-col items-center justify-center py-20">
              <span className="material-symbols-outlined text-zinc-700 text-4xl mb-3">analytics</span>
              <p className="text-zinc-600 text-xs">Click <button onClick={handleRunAnalysis} className="text-[#cefc00] font-bold hover:underline cursor-pointer">Analyze & Prepare</button> to start</p>
            </div>
          )}

          {refVideos.map((source, sourceIdx) => {
            const thumb = ytThumbnail(source.source_url)
            const duration = source.duration_seconds
            const isReady = source.status === 'ready'
            const isFav = source.is_favorite

            // Per-source analysis status — match by exampleVideoId from pipeline progress
            const sourceVideoId = (() => { try { return JSON.parse(source.meta_json || '{}').videoId } catch { return null } })()
            const sourceProgress = Object.values(pipelineProgresses).find(p => p.exampleVideoId === sourceVideoId)
              || (pipelineIds[sourceIdx] ? pipelineProgresses[pipelineIds[sourceIdx]] : null)
            // Per-source completion: check if THIS source has chapters data OR its pipeline is complete
            const sourceHasData = !!chaptersByExampleVideo[sourceVideoId]?.chapters?.length
            const sourceAnalysisDone = sourceProgress?.status === 'complete' || sourceHasData
            const sourceAnalysisRunning = sourceProgress && sourceProgress.status === 'running'
            const sourceAnalysisPct = sourceProgress?.totalStages > 0
              ? Math.round(((sourceProgress.stageIndex || sourceProgress.completedStages || 0) / sourceProgress.totalStages) * 100)
              : 0

            // Hide cards before analysis starts
            if (!sourceAnalysisDone && !sourceAnalysisRunning && !isRunning) return null

            return (
              <div key={source.id} className="bg-zinc-900 rounded-xl overflow-hidden flex flex-col group transition-all">
                {/* Card header — title left, thumbnail right */}
                <div className="flex items-start justify-between gap-4 p-5 pb-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold text-zinc-100 truncate">{source.label || source.video_title || 'Reference Video'}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="font-mono text-[11px] text-zinc-400">{formatDuration(duration)}</span>
                      <span className="text-zinc-700">·</span>
                      <span className="text-[11px] text-zinc-500">{source.source_url ? 'YouTube' : 'Upload'}</span>
                      <span className="text-zinc-700">·</span>
                      <div className="flex items-center gap-1">
                        {isFav && <Star size={9} className="text-[#cefc00] fill-[#cefc00]" />}
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${isFav ? 'text-[#cefc00]' : 'text-zinc-600'}`}>
                          {isFav ? 'Primary' : 'Alt Reference'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <a href={source.source_url || '#'} target="_blank" rel="noopener noreferrer" className="w-[120px] h-[84px] rounded-lg overflow-hidden shrink-0 bg-zinc-950 relative group/thumb cursor-pointer">
                    {thumb ? (
                      <img src={thumb} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="material-symbols-outlined text-zinc-800 text-2xl">smart_display</span>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity">
                      <Play size={20} className="text-white fill-white" />
                    </div>
                  </a>
                </div>

                {/* Details */}
                <div className="px-5 pb-5 flex flex-col justify-between">
                  <div>

                    {/* Chapters & Beats with stats and patterns — collapsible with fade */}
                    {(() => {
                      const analysis = chaptersByExampleVideo[sourceVideoId]
                      if (!analysis?.chapters?.length) return null
                      const { stats, patterns } = analysis
                      const isExpanded = !!expandedCards[source.id]
                      const totalBeats = analysis.chapters.reduce((sum, ch) => sum + (ch.beats?.length || 0), 0)

                      const renderChapter = (ch, ci) => {
                        const chStats = stats?.find(s => s.chapter_name === ch.name) || stats?.[ci]
                        const chPattern = patterns?.[ci]?.data
                        const brollPerMin = chStats?.broll?.count && chStats?.duration_seconds
                          ? (chStats.broll.count / (chStats.duration_seconds / 60)).toFixed(1)
                          : null
                        return (
                          <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                            <div className="flex items-start justify-between gap-3 mb-2">
                              <p className="text-zinc-200 font-bold text-xs">
                                {ch.name} <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start || ch.start_tc || (ch.start_seconds != null ? formatDuration(ch.start_seconds) : '')}</span>
                              </p>
                              {chStats?.broll && (
                                <div className="flex gap-3 shrink-0">
                                  {brollPerMin && (
                                    <div className="text-right">
                                      <p className="text-[9px] text-zinc-600 uppercase">B-rolls</p>
                                      <p className="text-xs font-mono text-[#cefc00]">{brollPerMin}/min</p>
                                    </div>
                                  )}
                                  {chStats.broll.avg_duration_seconds && (
                                    <div className="text-right">
                                      <p className="text-[9px] text-zinc-600 uppercase">Avg dur.</p>
                                      <p className="text-xs font-mono text-zinc-300">{chStats.broll.avg_duration_seconds}s</p>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            {ch.description && <p className="text-zinc-400 text-xs leading-relaxed flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '12px', marginTop: '2px' }}>description</span>{ch.description}</p>}
                            {ch.purpose && <p className="text-zinc-500 text-[11px] italic mb-2 flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>{ch.purpose}</p>}
                            {ch.beats?.length > 0 && (
                              <div className="mt-2 space-y-2.5">
                                <p className="text-[9px] text-[#c180ff] font-bold uppercase">Beats ({ch.beats.length})</p>
                                {ch.beats.map((beat, bi) => {
                                  const beatStrategy = chPattern?.beat_strategies?.find(bs =>
                                    bs.beat_name?.toLowerCase() === beat.name?.toLowerCase()
                                  )
                                  const emotion = beatStrategy?.beat_emotion || beat.emotion
                                  return (
                                    <div key={bi} className="border-l-2 border-zinc-800 pl-3">
                                      <p className="text-zinc-300 text-[11px] font-medium">
                                        {beat.name} <span className="font-mono text-zinc-600 font-normal text-[10px]">{beat.start || beat.start_tc || (beat.start_seconds != null ? formatDuration(beat.start_seconds) : '')}</span>
                                      </p>
                                      {beat.description && <p className="text-zinc-500 text-[11px] leading-relaxed flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>description</span>{beat.description}</p>}
                                      {beat.purpose && <p className="text-zinc-500 text-[11px] italic flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>{beat.purpose}</p>}
                                      {emotion && <p className="text-zinc-500 text-[11px] flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>mood</span>{emotion}</p>}
                                      {beatStrategy?.strategy_points?.length > 0 && (
                                        <ul className="mt-1 space-y-0.5">
                                          {beatStrategy.strategy_points.map((sp, si) => (
                                            <li key={si} className="text-zinc-400 text-[11px] leading-relaxed flex gap-1.5">
                                              <span className="text-[#cefc00]/50 shrink-0 mt-0.5">-</span>
                                              <span>{sp}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      }

                      return (
                        <div>
                          <h3 className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-2">
                            Chapters ({analysis.chapters.length}) · {totalBeats} beats
                          </h3>
                          {isExpanded ? (
                            <div className="space-y-3">
                              {analysis.chapters.map(renderChapter)}
                            </div>
                          ) : (
                            <div className="relative">
                              <div className="space-y-3 max-h-[120px] overflow-hidden">
                                {analysis.chapters.map(renderChapter)}
                              </div>
                              <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none" />
                            </div>
                          )}
                          <button
                            onClick={() => setExpandedCards(prev => ({ ...prev, [source.id]: !prev[source.id] }))}
                            className="w-full flex items-center justify-center gap-1.5 mt-2 py-1.5 text-[10px] text-zinc-500 font-bold uppercase tracking-wider hover:text-zinc-300 transition-colors"
                          >
                            {isExpanded ? 'Collapse' : `Show all ${analysis.chapters.length} chapters`}
                            <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      )
                    })()}

                  </div>

                  {/* Progress bar — show when running OR not yet fully complete */}
                  {(sourceAnalysisRunning || (!sourceAnalysisDone && isRunning)) && (
                    <div className="mt-5">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] text-zinc-500 font-bold uppercase">Analysis Status</span>
                        <span className="text-[10px] font-bold text-[#cefc00]">
                          {sourceAnalysisRunning ? `${sourceAnalysisPct}% PROCESSING` : 'PROCESSING'}
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden">
                        <div className="h-full bg-[#cefc00] transition-all" style={{ width: `${Math.max(sourceAnalysisRunning ? sourceAnalysisPct : 50, 5)}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </section>

        {/* Main Video Chapter Analysis */}
        {(() => {
          // Find active main video pipeline (no -ex suffix, not analysis strategy)
          const mainPipeline = Object.values(pipelineProgresses).find(p =>
            p.status === 'running' && !p.exampleVideoId && String(p.strategyId) !== String(analysisStrategy?.id)
          )
          const mainDone = !!mainVideoChapters
          const mainRunning = !!mainPipeline
          const mainPct = mainPipeline?.totalStages > 0
            ? Math.round(((mainPipeline.stageIndex || mainPipeline.completedStages || 0) / mainPipeline.totalStages) * 100)
            : 0

          // Show when: running, done, OR analysis is in progress (prep might be running)
          if (!mainDone && !mainRunning && !isRunning) return null

          const mainExpanded = !!expandedCards['main-video']
          return (
            <section className="mt-10">
              <div className="flex items-center gap-2 text-[#cefc00] mb-3">
                <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>movie</span>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Main Video</span>
              </div>

              <div className="bg-zinc-900 rounded-xl p-5">
                {/* Progress bar — only show when not complete */}
                {!mainDone && (
                  <div className="mb-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase">
                        {mainRunning ? mainPipeline.stageName || 'Analyzing...' : 'Analysis Status'}
                      </span>
                      <span className="text-[10px] font-bold text-[#cefc00]">
                        {`${mainPct}% PROCESSING`}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden">
                      <div className="h-full bg-[#cefc00] transition-all" style={{ width: `${Math.max(mainPct, 3)}%` }} />
                    </div>
                    {mainRunning && mainPipeline.subTotal && (
                      <div className="text-[10px] text-zinc-500 font-mono mt-1">
                        {mainPipeline.subLabel || ''} ({mainPipeline.subDone || 0}/{mainPipeline.subTotal})
                      </div>
                    )}
                  </div>
                )}

                {mainVideoChapters ? (() => {
                  const totalBeats = mainVideoChapters.chapters.reduce((sum, ch) => sum + (ch.beats?.length || 0), 0)
                  return (
                    <>
                      {mainVideoChapters.video_format && (
                        <div className="mb-4 flex items-center gap-2">
                          <span className="text-[9px] font-bold uppercase px-2 py-1 rounded bg-[#cefc00]/10 text-[#cefc00]">
                            {mainVideoChapters.video_format === 'voice_over' ? 'Voice-Over' : 'Talking Head'}
                          </span>
                          {mainVideoChapters.total_duration_seconds && (
                            <span className="text-[10px] text-zinc-500 font-mono">{formatDuration(mainVideoChapters.total_duration_seconds)}</span>
                          )}
                        </div>
                      )}

                      <h3 className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-2">
                        Chapters ({mainVideoChapters.chapters.length}) · {totalBeats} beats
                      </h3>

                      {mainExpanded ? (
                        <div className="space-y-3">
                          {mainVideoChapters.chapters.map((ch, ci) => (
                            <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-3 mb-1">
                                <p className="text-zinc-200 font-bold text-xs">
                                  {ch.name} <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start || ch.start_tc || (ch.start_seconds != null ? formatDuration(ch.start_seconds) : '')}</span>
                                </p>
                                {ch.content_type && (
                                  <span className="text-[9px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">{ch.content_type}</span>
                                )}
                              </div>
                              {ch.description && <p className="text-zinc-400 text-xs leading-relaxed flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '12px', marginTop: '2px' }}>description</span>{ch.description}</p>}
                              {ch.purpose && <p className="text-zinc-500 text-[11px] italic mb-2 flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>{ch.purpose}</p>}
                              {ch.beats?.length > 0 && (
                                <div className="mt-2 space-y-2">
                                  <p className="text-[9px] text-[#c180ff] font-bold uppercase">Beats ({ch.beats.length})</p>
                                  {ch.beats.map((beat, bi) => (
                                    <div key={bi} className="border-l-2 border-zinc-800 pl-3">
                                      <p className="text-zinc-300 text-[11px] font-medium">
                                        {beat.name} <span className="font-mono text-zinc-600 font-normal text-[10px]">{beat.start || beat.start_tc || (beat.start_seconds != null ? formatDuration(beat.start_seconds) : '')}</span>
                                      </p>
                                      {beat.description && <p className="text-zinc-500 text-[11px] leading-relaxed flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>description</span>{beat.description}</p>}
                                      {beat.purpose && <p className="text-zinc-500 text-[11px] italic flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>{beat.purpose}</p>}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="relative">
                          <div className="space-y-3 max-h-[120px] overflow-hidden">
                            {mainVideoChapters.chapters.map((ch, ci) => (
                              <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                                <div className="flex items-start justify-between gap-3 mb-1">
                                  <p className="text-zinc-200 font-bold text-xs">
                                    {ch.name} <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start || ch.start_tc || (ch.start_seconds != null ? formatDuration(ch.start_seconds) : '')}</span>
                                  </p>
                                  {ch.content_type && (
                                    <span className="text-[9px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">{ch.content_type}</span>
                                  )}
                                </div>
                                {ch.description && <p className="text-zinc-400 text-xs leading-relaxed flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '12px', marginTop: '2px' }}>description</span>{ch.description}</p>}
                              </div>
                            ))}
                          </div>
                          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none" />
                        </div>
                      )}

                      <button
                        onClick={() => setExpandedCards(prev => ({ ...prev, 'main-video': !prev['main-video'] }))}
                        className="w-full flex items-center justify-center gap-1.5 mt-2 py-1.5 text-[10px] text-zinc-500 font-bold uppercase tracking-wider hover:text-zinc-300 transition-colors"
                      >
                        {mainExpanded ? 'Collapse' : `Show all ${mainVideoChapters.chapters.length} chapters`}
                        <ChevronDown size={14} className={`transition-transform ${mainExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </>
                  )
                })() : (
                  <div className="text-center py-6 text-zinc-500 text-sm">
                    <Loader2 size={20} className="text-[#cefc00] animate-spin mx-auto mb-2" />
                    Analyzing main video...
                  </div>
                )}
              </div>
            </section>
          )
        })()}

        </>)}
      </div>
      {resetConfirming && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-6">
          <div className="max-w-md w-full rounded-xl overflow-hidden shadow-2xl shadow-black/60 border border-outline-variant/20 p-6" style={{ background: 'rgba(25, 25, 28, 0.85)', backdropFilter: 'blur(20px)' }}>
            <h2 className="text-lg font-bold text-zinc-100 mb-3">Reset B-Roll Searches?</h2>
            {!resetPreview && !resetError && (
              <p className="text-sm text-zinc-400">Loading preview…</p>
            )}
            {resetError && (
              <p className="text-sm text-red-400 mb-4">{resetError}</p>
            )}
            {resetPreview && (
              <div className="text-sm text-zinc-300 space-y-2 mb-4">
                <p>This will delete:</p>
                <ul className="list-disc ml-5 text-zinc-400 text-xs">
                  <li>{resetPreview.searches.total} b-roll search rows ({Object.entries(resetPreview.searches.byStatus || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})</li>
                  <li>{resetPreview.kwRuns} keyword pipeline runs</li>
                  <li>{resetPreview.bsRuns} legacy b-roll search runs</li>
                  <li>Abort {resetPreview.activePipelines.length} active in-memory pipelines</li>
                </ul>
                <p className="text-xs text-zinc-500 mt-2">Plans, strategies, analysis, and reference data are NOT touched.</p>
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setResetConfirming(false); setResetPreview(null); setResetError(null) }}
                disabled={resetLoading}
                className="px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmReset}
                disabled={resetLoading || !resetPreview}
                className="px-3 py-1.5 text-xs bg-red-500/80 hover:bg-red-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
              >
                {resetLoading && <Loader2 size={12} className="animate-spin" />}
                {resetLoading ? 'Resetting…' : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
