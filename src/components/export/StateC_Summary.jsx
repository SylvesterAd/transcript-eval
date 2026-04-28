import { useMemo, useState } from 'react'
import styled from 'styled-components'
import { CheckCircle2, FolderOpen, Play } from 'lucide-react'
import { buildManifest, formatBytes, estimateTimeRange } from '../../lib/buildManifest.js'

// Spec § State C. Manifest summary + Start Export.
//
// Inputs the parent passes:
//   variant            — display label for the active plan (e.g. "Variant A")
//   manifestResp       — { pipeline_id, items, totals }
//   additionalManifests— { planPipelineId: manifestResp } map for multi-variant checkbox
//   ping               — preflight ping value (for installed/version display)
//   diskValue          — { quota, usage, available } or { available:null }
//   onStart            — callback({ unifiedManifest, options }) → triggers POST /api/exports + sendExport
//   onChangeFolder     — callback (Phase A: shows "coming soon" alert)
//   onTogglePlan       — callback(planPipelineId, on/off) for the multi-variant checkbox
//   otherPlans         — [{plan_pipeline_id, label}] — other completed plans in this group

const Wrap = styled.div`
  max-width: 720px;
  margin: 60px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1a1a1a;
`

const Card = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px 32px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
`

const Header = styled.h1`
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 4px;
`
const SubHeader = styled.p`
  font-size: 13px;
  color: #6b7280;
  margin: 0 0 16px;
`

const CheckRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  font-size: 14px;
  & .icon-ok { color: #16a34a; }
`

const Section = styled.div`
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #f1f5f9;
`

const SectionLabel = styled.div`
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
  margin-bottom: 8px;
`

const SourceRow = styled.div`
  display: grid;
  grid-template-columns: 80px 80px 1fr;
  font-size: 14px;
  padding: 4px 0;
`

const FolderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 13px;
  color: #1f2937;
  background: #f9fafb;
  padding: 8px 12px;
  border-radius: 6px;
`

const ChangeFolderBtn = styled.button`
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
  &:hover { background: #f3f4f6; }
`

const Checkbox = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 10px 0;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  & input { margin-top: 3px; }
  & .desc {
    font-size: 12px;
    color: #6b7280;
    margin-top: 2px;
  }
`

const Estimate = styled.p`
  font-size: 13px;
  color: #6b7280;
  margin: 16px 0 0;
`

const StartButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 20px;
  &:hover { background: #1d4ed8; }
  &:disabled { background: #9ca3af; cursor: not-allowed; }
`

export default function StateC_Summary({
  variant, manifestResp, additionalManifests, ping, diskValue,
  onStart, onChangeFolder, onTogglePlan, otherPlans = [],
  targetFolderOverride,
}) {
  const [forceRedownload, setForceRedownload] = useState(false)
  const [includeExtras, setIncludeExtras] = useState({})  // {planPipelineId: true}
  const [starting, setStarting] = useState(false)

  // Build the unified manifest from the current selection.
  const unified = useMemo(() => {
    const responses = [manifestResp]
    for (const [id, on] of Object.entries(includeExtras)) {
      if (on && additionalManifests[id]) responses.push(additionalManifests[id])
    }
    return buildManifest({ manifests: responses, options: { force_redownload: forceRedownload } })
  }, [manifestResp, additionalManifests, includeExtras, forceRedownload])

  const totalBytes = unified.totals.est_size_bytes
  const sources = unified.totals.by_source
  const variantLabels = unified.variants.length ? unified.variants.join(', ') : variant

  // Folder slug derives from the plan pipeline id's video segment + the
  // variant letter. plan_pipeline_id format is `plan-<videoId>-<ts>`;
  // variant labels look like "Variant A". Falls back to the raw id when
  // the patterns don't match (defensive).
  const planMatch = String(manifestResp?.pipeline_id || '').match(/^plan-(\d+)-/)
  const folderRoot = planMatch ? planMatch[1] : (manifestResp?.pipeline_id || '')
  const variantLetter = String(variant || '').replace(/^Variant\s+/i, '').toLowerCase() || 'a'

  // Default folder per spec § "Multi-variant exports" (multi: -all suffix).
  // User-edited override (via "Change folder") wins when present.
  const defaultFolder = unified.variants.length > 1
    ? `~/Downloads/transcript-eval/export-${folderRoot}-all/`
    : `~/Downloads/transcript-eval/export-${folderRoot}-${variantLetter}/`
  const folderName = targetFolderOverride || defaultFolder

  const diskAvailable = diskValue?.available ?? null
  const diskOk = diskAvailable == null ? 'unknown' : (diskAvailable > totalBytes * 1.1 ? 'ok' : 'warn')

  async function handleStart() {
    if (starting) return
    setStarting(true)
    try {
      await onStart({
        unifiedManifest: unified,
        options: { force_redownload: forceRedownload },
        targetFolder: folderName,
      })
    } finally {
      // Parent transitions us out of state_c on success; only release
      // local lock here on failure (parent re-throws in that case).
      setStarting(false)
    }
  }

  return (
    <Wrap>
      <Card>
        <Header>{variantLabels} · {unified.totals.count} clips · ~{formatBytes(totalBytes)}</Header>
        <SubHeader>Pre-flight checks complete.</SubHeader>

        <CheckRow><CheckCircle2 size={16} className="icon-ok" /> Export Helper installed{ping?.ext_version ? ` (v${ping.ext_version})` : ''}</CheckRow>
        <CheckRow><CheckCircle2 size={16} className="icon-ok" /> Envato session detected</CheckRow>
        <CheckRow>
          <CheckCircle2 size={16} className="icon-ok" />
          {diskOk === 'ok' && `Disk space available (${formatBytes(diskAvailable)} free)`}
          {diskOk === 'warn' && `⚠ Low disk space (${formatBytes(diskAvailable)} free)`}
          {diskOk === 'unknown' && 'Disk space could not be checked'}
        </CheckRow>

        <Section>
          <SectionLabel>Sources</SectionLabel>
          {sources.envato > 0 && (
            <SourceRow><span>Envato</span><span>{sources.envato} clips</span><span>(your subscription)</span></SourceRow>
          )}
          {sources.pexels > 0 && (
            <SourceRow><span>Pexels</span><span>{sources.pexels} clips</span><span>(free)</span></SourceRow>
          )}
          {sources.freepik > 0 && (
            <SourceRow><span>Freepik</span><span>{sources.freepik} clips</span><span>(transcript-eval account)</span></SourceRow>
          )}
        </Section>

        <Section>
          <SectionLabel>Target folder</SectionLabel>
          <FolderRow>
            <FolderOpen size={16} />
            <span>{folderName}</span>
            <ChangeFolderBtn type="button" onClick={onChangeFolder}>Change folder</ChangeFolderBtn>
          </FolderRow>
        </Section>

        {otherPlans.length > 0 && (
          <Section>
            <SectionLabel>Multi-variant export</SectionLabel>
            {otherPlans.map(p => (
              <Checkbox key={p.plan_pipeline_id}>
                <input
                  type="checkbox"
                  checked={!!includeExtras[p.plan_pipeline_id]}
                  onChange={(e) => {
                    setIncludeExtras(prev => ({ ...prev, [p.plan_pipeline_id]: e.target.checked }))
                    onTogglePlan(p.plan_pipeline_id, e.target.checked)
                  }}
                />
                <span>
                  Also export {p.label}
                  <div className="desc">Shares the media folder, adds 1 more XML file.</div>
                </span>
              </Checkbox>
            ))}
          </Section>
        )}

        <Section>
          <SectionLabel>Options</SectionLabel>
          <Checkbox>
            <input
              type="checkbox"
              checked={forceRedownload}
              onChange={e => setForceRedownload(e.target.checked)}
            />
            <span>
              Re-download files already on disk
              <div className="desc">
                Default off: skip clips already downloaded in this folder
                to protect your Envato fair-use counter.
              </div>
            </span>
          </Checkbox>
        </Section>

        <Estimate>Estimated time: {estimateTimeRange(totalBytes)} at typical home internet.</Estimate>

        <StartButton type="button" onClick={handleStart} disabled={starting || unified.totals.count === 0}>
          <Play size={16} />
          {starting ? 'Starting…' : 'Start Export'}
        </StartButton>
      </Card>
    </Wrap>
  )
}
