import db from '../db.js'

/**
 * AI-powered analysis of experiment runs.
 * Generates natural-language insights about what happened at each stage,
 * cross-video patterns, and suggestions for improvement.
 */

/**
 * Analyze a single run: what changed at each stage, what went well/badly.
 */
export async function analyzeRun(experimentRunId) {
  const run = db.prepare(`
    SELECT er.*, v.title AS video_title, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE er.id = ?
  `).get(experimentRunId)

  if (!run || run.status !== 'complete') return null

  const stages = db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(experimentRunId)

  const metrics = db.prepare(`
    SELECT m.*, rso.stage_index, rso.stage_name FROM metrics m
    JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
    WHERE rso.experiment_run_id = ? AND m.comparison_type = 'human_vs_current'
    ORDER BY rso.stage_index
  `).all(experimentRunId)

  const scoreBreakdown = run.score_breakdown_json ? JSON.parse(run.score_breakdown_json) : null

  // Build analysis without LLM — deterministic pattern-based analysis
  const stageAnalyses = stages.map((stage, i) => {
    const m = metrics.find(met => met.stage_index === i)
    return analyzeStageMetrics(stage, m, i, stages.length)
  })

  const overallAnalysis = analyzeOverallRun(run, metrics, scoreBreakdown)

  // Store stage-level analyses
  for (let i = 0; i < stageAnalyses.length; i++) {
    const existing = db.prepare(
      'SELECT id FROM analysis_records WHERE experiment_run_id = ? AND run_stage_output_id = ? AND analysis_type = ?'
    ).get(experimentRunId, stages[i].id, 'stage')

    if (existing) {
      db.prepare('UPDATE analysis_records SET content = ? WHERE id = ?')
        .run(stageAnalyses[i], existing.id)
    } else {
      db.prepare(
        'INSERT INTO analysis_records (experiment_run_id, run_stage_output_id, analysis_type, content) VALUES (?, ?, ?, ?)'
      ).run(experimentRunId, stages[i].id, 'stage', stageAnalyses[i])
    }
  }

  // Store cross-stage analysis
  const existingCross = db.prepare(
    'SELECT id FROM analysis_records WHERE experiment_run_id = ? AND analysis_type = ?'
  ).get(experimentRunId, 'cross_stage')

  if (existingCross) {
    db.prepare('UPDATE analysis_records SET content = ? WHERE id = ?')
      .run(overallAnalysis, existingCross.id)
  } else {
    db.prepare(
      'INSERT INTO analysis_records (experiment_run_id, analysis_type, content) VALUES (?, ?, ?)'
    ).run(experimentRunId, 'cross_stage', overallAnalysis)
  }

  return { stageAnalyses, overallAnalysis }
}

/**
 * Analyze an experiment across all videos — cross-video summary.
 */
export async function analyzeExperiment(experimentId) {
  const runs = db.prepare(`
    SELECT er.*, v.title AS video_title
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    WHERE er.experiment_id = ? AND er.status = 'complete'
    ORDER BY er.video_id, er.run_number
  `).all(experimentId)

  if (runs.length === 0) return null

  // Group by video
  const byVideo = {}
  for (const r of runs) {
    if (!byVideo[r.video_id]) byVideo[r.video_id] = { title: r.video_title, runs: [] }
    byVideo[r.video_id].runs.push(r)
  }

  const scores = runs.map(r => r.total_score).filter(s => s !== null)
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null

  // Find best/worst videos
  const videoAvgs = Object.entries(byVideo).map(([vid, v]) => {
    const vScores = v.runs.map(r => r.total_score).filter(s => s !== null)
    return {
      video_id: vid,
      title: v.title,
      avg: vScores.length > 0 ? vScores.reduce((a, b) => a + b, 0) / vScores.length : null,
      runs: v.runs.length
    }
  }).filter(v => v.avg !== null).sort((a, b) => b.avg - a.avg)

  const best = videoAvgs[0]
  const worst = videoAvgs[videoAvgs.length - 1]

  // Score consistency
  const stddev = scores.length > 1
    ? Math.sqrt(scores.reduce((s, v) => s + (v - avgScore) ** 2, 0) / scores.length)
    : 0

  let analysis = `## Cross-Video Analysis\n\n`
  analysis += `**Overall**: ${runs.length} runs across ${Object.keys(byVideo).length} videos. `
  analysis += `Average score: **${avgScore !== null ? Math.round(avgScore * 100) + '%' : 'N/A'}**\n\n`

  if (stddev < 0.02) {
    analysis += `Score consistency is **excellent** (σ=${stddev.toFixed(4)}) — the strategy performs uniformly.\n\n`
  } else if (stddev < 0.05) {
    analysis += `Score consistency is **good** (σ=${stddev.toFixed(4)}) — minor variance between videos.\n\n`
  } else {
    analysis += `Score consistency is **poor** (σ=${stddev.toFixed(4)}) — performance varies significantly by video.\n\n`
  }

  if (best && worst && best.video_id !== worst.video_id) {
    analysis += `**Best**: ${best.title} (${Math.round(best.avg * 100)}%)\n`
    analysis += `**Worst**: ${worst.title} (${Math.round(worst.avg * 100)}%)\n\n`

    const gap = best.avg - worst.avg
    if (gap > 0.1) {
      analysis += `The ${Math.round(gap * 100)}pp gap suggests the strategy may struggle with certain content types. `
      analysis += `Consider analyzing what makes "${worst.title}" harder.\n\n`
    }
  }

  // Cost efficiency
  const totalCost = runs.reduce((s, r) => s + (r.total_cost || 0), 0)
  const avgRuntime = runs.reduce((s, r) => s + (r.total_runtime_ms || 0), 0) / runs.length
  analysis += `**Cost**: $${totalCost.toFixed(4)} total ($${(totalCost / runs.length).toFixed(4)}/run). `
  analysis += `**Avg runtime**: ${(avgRuntime / 1000).toFixed(1)}s\n`

  // Store analysis
  const existing = db.prepare(
    'SELECT id FROM analysis_records WHERE experiment_run_id IS NULL AND analysis_type = ? AND content LIKE ?'
  ).get('cross_video', `%experiment_id:${experimentId}%`)

  const taggedContent = `<!-- experiment_id:${experimentId} -->\n${analysis}`

  if (existing) {
    db.prepare('UPDATE analysis_records SET content = ? WHERE id = ?')
      .run(taggedContent, existing.id)
  } else {
    db.prepare(
      'INSERT INTO analysis_records (analysis_type, content) VALUES (?, ?)'
    ).run('cross_video', taggedContent)
  }

  return analysis
}

/**
 * Try to use LLM for deeper analysis if API key is available.
 * Falls back to deterministic analysis.
 */
export async function analyzRunWithLLM(experimentRunId) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return analyzeRun(experimentRunId)
  }

  const run = db.prepare(`
    SELECT er.*, v.title AS video_title, e.name AS experiment_name
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    WHERE er.id = ?
  `).get(experimentRunId)

  if (!run || run.status !== 'complete') return null

  const stages = db.prepare(
    'SELECT stage_index, stage_name, model, tokens_in, tokens_out, runtime_ms FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(experimentRunId)

  const metrics = db.prepare(`
    SELECT m.similarity_percent, m.diff_percent, m.delta_vs_previous_stage, rso.stage_name
    FROM metrics m
    JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
    WHERE rso.experiment_run_id = ? AND m.comparison_type = 'human_vs_current'
    ORDER BY rso.stage_index
  `).all(experimentRunId)

  const scoreBreakdown = run.score_breakdown_json ? JSON.parse(run.score_breakdown_json) : null

  const prompt = `Analyze this transcript cleaning run. Be concise (3-5 bullet points).

Video: ${run.video_title}
Final Score: ${run.total_score ? Math.round(run.total_score * 100) + '%' : 'N/A'}
Score Breakdown: ${scoreBreakdown ? JSON.stringify(scoreBreakdown.weights) : 'N/A'}

Stages:
${metrics.map((m, i) => `- ${m.stage_name}: ${m.similarity_percent}% similarity, ${m.diff_percent}% diff${m.delta_vs_previous_stage !== null ? `, delta ${m.delta_vs_previous_stage}pp` : ''}`).join('\n')}

What worked well? What could be improved? Any patterns?`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    if (!res.ok) throw new Error(`API error ${res.status}`)

    const data = await res.json()
    const analysis = data.content?.[0]?.text || ''

    // Store LLM analysis
    const existing = db.prepare(
      'SELECT id FROM analysis_records WHERE experiment_run_id = ? AND analysis_type = ?'
    ).get(experimentRunId, 'cross_stage')

    if (existing) {
      db.prepare('UPDATE analysis_records SET content = ?, model_used = ? WHERE id = ?')
        .run(analysis, 'claude-haiku-4-5-20251001', existing.id)
    } else {
      db.prepare(
        'INSERT INTO analysis_records (experiment_run_id, analysis_type, content, model_used) VALUES (?, ?, ?, ?)'
      ).run(experimentRunId, 'cross_stage', analysis, 'claude-haiku-4-5-20251001')
    }

    return { overallAnalysis: analysis, llm: true }
  } catch {
    // Fallback to deterministic
    return analyzeRun(experimentRunId)
  }
}

/**
 * Custom analysis with user-defined prompt.
 * Auto-injects workflow context (stage prompts, metrics) into the prompt.
 * Optionally includes raw transcript and stage outputs.
 */
export async function analyzeRunCustom(experimentRunId, { systemPrompt, userPrompt, model, includeRawTranscript, includeStageOutputs }) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY
  if (!apiKey) throw new Error('No API key configured for analysis')

  const run = db.prepare(`
    SELECT er.*, v.title AS video_title, e.name AS experiment_name,
      s.name AS strategy_name, sv.version_number, sv.stages_json
    FROM experiment_runs er
    JOIN videos v ON v.id = er.video_id
    JOIN experiments e ON e.id = er.experiment_id
    JOIN strategy_versions sv ON sv.id = e.strategy_version_id
    JOIN strategies s ON s.id = sv.strategy_id
    WHERE er.id = ?
  `).get(experimentRunId)

  if (!run || run.status !== 'complete') return null

  const stageOutputs = db.prepare(
    'SELECT * FROM run_stage_outputs WHERE experiment_run_id = ? ORDER BY stage_index'
  ).all(experimentRunId)

  const metrics = db.prepare(`
    SELECT m.*, rso.stage_index, rso.stage_name FROM metrics m
    JOIN run_stage_outputs rso ON rso.id = m.run_stage_output_id
    WHERE rso.experiment_run_id = ? AND m.comparison_type = 'human_vs_current'
    ORDER BY rso.stage_index
  `).all(experimentRunId)

  const flowStages = JSON.parse(run.stages_json || '[]')

  // Build workflow context (prompts without transcript content)
  let workflowContext = `## Workflow: ${run.strategy_name} v${run.version_number}\n`
  workflowContext += `Video: ${run.video_title}\n`
  workflowContext += `Final Score: ${run.total_score ? Math.round(run.total_score * 100) + '%' : 'N/A'}\n\n`

  for (let i = 0; i < flowStages.length; i++) {
    const fs = flowStages[i]
    const m = metrics.find(met => met.stage_index === i)
    const so = stageOutputs[i]

    workflowContext += `### Stage ${i + 1}: ${fs.name} (${fs.type})\n`
    if (fs.model) workflowContext += `Model: ${fs.model}\n`
    if (fs.system_instruction) workflowContext += `System Prompt: ${fs.system_instruction}\n`
    if (fs.prompt) workflowContext += `User Prompt Template: ${fs.prompt}\n`
    if (m) workflowContext += `Result: ${m.similarity_percent}% similarity, ${m.diff_percent}% diff${m.delta_vs_previous_stage !== null ? `, delta ${m.delta_vs_previous_stage}pp` : ''}\n`
    if (so) workflowContext += `Tokens: ${so.tokens_in + so.tokens_out}, Cost: $${(so.cost || 0).toFixed(4)}, Runtime: ${((so.runtime_ms || 0) / 1000).toFixed(1)}s\n`
    workflowContext += '\n'
  }

  // Build the final prompt with replacements
  let finalPrompt = userPrompt
    .replace(/\{\{workflow\}\}/g, workflowContext)
    .replace(/<workflow><\/workflow>/g, workflowContext)

  if (includeRawTranscript) {
    const rawTranscript = db.prepare("SELECT content FROM transcripts WHERE video_id = ? AND type = 'raw'").get(run.video_id)
    if (rawTranscript) {
      finalPrompt = finalPrompt
        .replace(/\{\{raw_transcript\}\}/g, rawTranscript.content)
        .replace(/<raw_transcript><\/raw_transcript>/g, rawTranscript.content)
    }
  }

  if (includeStageOutputs) {
    let outputsText = ''
    for (const so of stageOutputs) {
      outputsText += `--- Stage ${so.stage_index + 1}: ${so.stage_name} Output ---\n`
      outputsText += so.output_text?.slice(0, 10000) + '\n\n'
    }
    finalPrompt = finalPrompt
      .replace(/\{\{stage_outputs\}\}/g, outputsText)
      .replace(/<stage_outputs><\/stage_outputs>/g, outputsText)
  }

  // Call LLM
  let analysisText = ''
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (anthropicKey && (model.startsWith('claude') || !process.env.OPENAI_API_KEY)) {
    const actualModel = model.startsWith('claude') ? model : 'claude-haiku-4-5-20251001'
    const body = {
      model: actualModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: finalPrompt }],
    }
    if (systemPrompt) body.system = systemPrompt

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    analysisText = data.content?.[0]?.text || ''
  } else {
    throw new Error('No supported API key for analysis model')
  }

  // Store
  const existing = db.prepare(
    'SELECT id FROM analysis_records WHERE experiment_run_id = ? AND analysis_type = ?'
  ).get(experimentRunId, 'cross_stage')

  if (existing) {
    db.prepare('UPDATE analysis_records SET content = ?, model_used = ? WHERE id = ?')
      .run(analysisText, model, existing.id)
  } else {
    db.prepare(
      'INSERT INTO analysis_records (experiment_run_id, analysis_type, content, model_used) VALUES (?, ?, ?, ?)'
    ).run(experimentRunId, 'cross_stage', analysisText, model)
  }

  return { overallAnalysis: analysisText, llm: true, model }
}

// --- Deterministic analysis helpers ---

function analyzeStageMetrics(stage, metrics, stageIndex, totalStages) {
  const parts = []
  parts.push(`**${stage.stage_name}** (Stage ${stageIndex + 1}/${totalStages})`)

  if (!metrics) {
    parts.push('No metrics available for this stage.')
    return parts.join('\n')
  }

  // Similarity assessment
  const sim = metrics.similarity_percent
  if (sim >= 90) parts.push(`Excellent similarity (${sim}%) — very close to human edit.`)
  else if (sim >= 75) parts.push(`Good similarity (${sim}%) — captures most human edits.`)
  else if (sim >= 60) parts.push(`Moderate similarity (${sim}%) — significant divergence from human edit.`)
  else parts.push(`Low similarity (${sim}%) — substantially different from human edit.`)

  // Delta assessment
  if (metrics.delta_vs_previous_stage !== null) {
    const d = metrics.delta_vs_previous_stage
    if (d < -2) parts.push(`Improved ${Math.abs(d)}pp over previous stage — this stage is helping.`)
    else if (d > 2) parts.push(`Degraded ${d}pp vs previous stage — this stage may be counterproductive.`)
    else parts.push(`Minimal change (${d > 0 ? '+' : ''}${d}pp) vs previous stage.`)
  }

  // Cost/performance
  if (stage.runtime_ms) {
    parts.push(`Runtime: ${(stage.runtime_ms / 1000).toFixed(1)}s, ${(stage.tokens_in || 0) + (stage.tokens_out || 0)} tokens.`)
  }

  return parts.join('\n')
}

function analyzeOverallRun(run, metrics, scoreBreakdown) {
  const parts = []
  parts.push(`## Run Analysis: ${run.video_title}`)
  parts.push(`**Final Score**: ${run.total_score ? Math.round(run.total_score * 100) + '%' : 'N/A'}`)
  parts.push('')

  if (scoreBreakdown) {
    // Identify strongest/weakest components
    const components = [
      { name: 'Human Match', score: scoreBreakdown.similarity?.humanVsCurrent?.similarityPercent ?? (scoreBreakdown.breakdown?.humanMatch != null ? scoreBreakdown.breakdown.humanMatch * 100 : null), weight: 50 },
      { name: 'Correct Removals', score: scoreBreakdown.deletions ? (scoreBreakdown.deletions.correct / Math.max(1, scoreBreakdown.deletions.correct + scoreBreakdown.deletions.missed)) * 100 : null, weight: 20 },
      { name: 'Timecodes', score: scoreBreakdown.timecodes?.score ? scoreBreakdown.timecodes.score * 100 : null, weight: 10 },
      { name: 'Pauses', score: scoreBreakdown.pauses?.score ? scoreBreakdown.pauses.score * 100 : null, weight: 5 },
    ].filter(c => c.score !== null)

    if (components.length > 0) {
      const sorted = [...components].sort((a, b) => b.score - a.score)
      parts.push(`**Strongest**: ${sorted[0].name} (${Math.round(sorted[0].score)}%)`)
      if (sorted.length > 1) {
        parts.push(`**Weakest**: ${sorted[sorted.length - 1].name} (${Math.round(sorted[sorted.length - 1].score)}%)`)
      }
      parts.push('')
    }

    // Deletion analysis
    if (scoreBreakdown.deletions) {
      const d = scoreBreakdown.deletions
      parts.push(`**Deletions**: ${d.correct} correct, ${d.missed} missed, ${d.wrong} wrong`)
      if (d.missed > d.correct) {
        parts.push('⚠ More deletions missed than caught — the strategy is too conservative.')
      } else if (d.wrong > d.correct * 0.3) {
        parts.push('⚠ High rate of wrong deletions — the strategy is too aggressive.')
      }
      parts.push('')
    }
  }

  // Stage progression
  if (metrics.length > 1) {
    const improving = metrics.filter(m => m.delta_vs_previous_stage !== null && m.delta_vs_previous_stage < -1)
    const degrading = metrics.filter(m => m.delta_vs_previous_stage !== null && m.delta_vs_previous_stage > 1)

    if (improving.length > 0) {
      parts.push(`**${improving.length}** stage(s) improved similarity vs previous.`)
    }
    if (degrading.length > 0) {
      parts.push(`**${degrading.length}** stage(s) degraded similarity — consider removing or revising.`)
    }
  }

  // Runtime/cost
  if (run.total_runtime_ms) {
    parts.push(`\n**Runtime**: ${(run.total_runtime_ms / 1000).toFixed(1)}s total`)
  }
  if (run.total_cost) {
    parts.push(`**Cost**: $${run.total_cost.toFixed(4)}`)
  }

  return parts.join('\n')
}
