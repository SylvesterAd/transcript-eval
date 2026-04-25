import { useMemo, useState, useCallback } from 'react'
import styled, { keyframes, css } from 'styled-components'
import { Pause, Play, Square, AlertCircle, RefreshCw, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { selectTotals, selectCurrentItem, selectSpeedAndEta } from './progressState.js'
import { formatBytes } from '../../lib/buildManifest.js'

// Spec § State D (docs/specs/2026-04-23-envato-export-design.md).
// Renders:
//   · header (variant + "exporting")
//   · total progress bar with bytes + count overlay
//   · current-item card (filename, size, percent)
//   · speed + ETA
//   · pause / resume / cancel buttons
//   · per-item status table, scrollable (max-height 360)
//   · done/failed/remaining counters
//   · reconnect banner when port disconnected
//   · single-run-active blocker when mismatched
//
// Props come from ExportPage.jsx via useExportPort (see plan §Task 3).

const Wrap = styled.div`
  max-width: 780px;
  margin: 40px auto;
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

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
`

const Bar = styled.div`
  position: relative;
  height: 14px;
  border-radius: 6px;
  background: #e5e7eb;
  overflow: hidden;
  margin: 14px 0 6px;
`
const BarFill = styled.div`
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #2563eb, #3b82f6);
  border-radius: 6px 0 0 6px;
  transition: width 300ms ease-out;
  ${p => p.$running && css`animation: ${pulse} 1.8s infinite;`}
`
const BarLabel = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #4b5563;
  margin-bottom: 16px;
`

const CurrentCard = styled.div`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 14px;
  margin: 12px 0;
  font-size: 13px;
  color: #1f2937;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  display: flex;
  justify-content: space-between;
  gap: 12px;
`

const Controls = styled.div`
  display: flex;
  gap: 10px;
  margin: 16px 0 8px;
`

const BtnBase = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #1f2937;
  &:hover:not(:disabled) { background: #f3f4f6; }
  &:disabled { cursor: not-allowed; opacity: 0.6; }
`

const DangerBtn = styled(BtnBase)`
  border-color: #fca5a5;
  color: #991b1b;
  &:hover:not(:disabled) { background: #fef2f2; }
`

const SpeedRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 12px;
`

const Section = styled.div`
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
`

const SectionLabel = styled.div`
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
  margin-bottom: 8px;
`

const Table = styled.div`
  max-height: 360px;
  overflow: auto;
  border: 1px solid #f1f5f9;
  border-radius: 6px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
`

const TableHeader = styled.div`
  display: grid;
  grid-template-columns: 50px 1fr 80px 100px 80px 90px;
  padding: 6px 10px;
  background: #f9fafb;
  color: #6b7280;
  font-size: 11px;
  text-transform: uppercase;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 1;
`

const Row = styled.div`
  display: grid;
  grid-template-columns: 50px 1fr 80px 100px 80px 90px;
  padding: 5px 10px;
  border-bottom: 1px solid #f9fafb;
  align-items: center;
  &:last-child { border-bottom: none; }
  &:hover { background: #f9fafb; }
`

const PhaseBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: ${p => ({
    done: '#15803d',
    failed: '#b91c1c',
    downloading: '#1d4ed8',
    licensing: '#6d28d9',
    resolving: '#7c2d12',
    queued: '#6b7280',
  }[p.$phase] || '#6b7280')};
`

const Counters = styled.div`
  margin-top: 12px;
  font-size: 13px;
  color: #4b5563;
  display: flex;
  gap: 20px;
`
const CounterItem = styled.span`
  & strong { color: #1f2937; }
`

const Banner = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 14px;
`

const ErrorBanner = styled(Banner)`
  background: #fef2f2;
  border-color: #fca5a5;
  color: #991b1b;
`

// Phase → icon + glyph used in the per-item row.
function phaseGlyph(phase) {
  switch (phase) {
    case 'done':        return <span style={{ color: '#15803d' }}>&#10003;</span>            // ✓
    case 'failed':      return <span style={{ color: '#b91c1c' }}>&#10007;</span>            // ✗
    case 'downloading': return <Clock size={12} />
    case 'licensing':   return <RefreshCw size={12} />
    case 'resolving':   return <RefreshCw size={12} />
    default:            return <span style={{ color: '#9ca3af' }}>&middot;</span>
  }
}

function phaseLabel(phase) {
  return {
    queued: 'queued',
    resolving: 'resolving',
    licensing: 'licensing',
    downloading: 'downloading',
    done: 'done',
    failed: 'failed',
  }[phase] || phase || '—'
}

/**
 * @param {{
 *   variant: string,
 *   snapshot: object | null,
 *   portStatus: string,
 *   portError: string | null,
 *   pendingAction: { action: string, sentAt: number } | null,
 *   reconnect: () => void,
 *   sendControl: (action: 'pause'|'resume'|'cancel') => Promise<any>,
 *   mismatched: boolean,
 *   mismatchInfo: null | { actualExportId, actualRunState, actualPipelineId, actualVariants }
 * }} props
 */
export default function StateD_InProgress({
  variant, snapshot, portStatus, portError, pendingAction,
  reconnect, sendControl, mismatched, mismatchInfo,
}) {
  const totals = useMemo(() => selectTotals(snapshot), [snapshot])
  const current = useMemo(() => selectCurrentItem(snapshot), [snapshot])
  const { speedMbps, etaMin } = useMemo(() => selectSpeedAndEta(snapshot), [snapshot])
  const [controlErr, setControlErr] = useState(null)

  const runState = snapshot?.run_state || 'running'
  const isPaused = runState === 'paused' || pendingAction?.action === 'pause'
  const isCancelling = runState === 'cancelling' || pendingAction?.action === 'cancel'
  const canInteract = !isCancelling && portStatus !== 'disconnected' && portStatus !== 'failed'

  const handleControl = useCallback(async (action) => {
    setControlErr(null)
    try {
      await sendControl(action)
    } catch (e) {
      setControlErr(`${action} failed: ${e.message}`)
    }
  }, [sendControl])

  // Single-run mismatch blocker — if the extension's snapshot shows a
  // DIFFERENT run, we refuse to show the live progress for the wrong
  // run and offer a "cancel other run" CTA.
  if (mismatched && mismatchInfo) {
    const variantList = mismatchInfo.actualVariants.length
      ? mismatchInfo.actualVariants.join(', ')
      : 'unknown'
    return (
      <Wrap>
        <Card>
          <Header>Another export is in progress</Header>
          <SubHeader>
            The Export Helper is currently running another export
            (Variant {variantList} · run state: {mismatchInfo.actualRunState}).
            Only one export can run at a time per the extension's queue.
          </SubHeader>
          <ErrorBanner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Wait for the other export to finish, or cancel it here before
              starting a new one.
            </span>
          </ErrorBanner>
          <Controls>
            <DangerBtn
              type="button"
              onClick={() => handleControl('cancel')}
              disabled={!canInteract}
            >
              <Square size={14} /> Cancel other run
            </DangerBtn>
            <BtnBase type="button" onClick={reconnect}>
              <RefreshCw size={14} /> Refresh
            </BtnBase>
          </Controls>
          {controlErr && (
            <ErrorBanner>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{controlErr}</span>
            </ErrorBanner>
          )}
        </Card>
      </Wrap>
    )
  }

  // Loading state — Port connecting but no snapshot yet.
  if (!snapshot) {
    return (
      <Wrap>
        <Card>
          <Header>Exporting Variant {variant}</Header>
          <SubHeader>
            {portStatus === 'connecting' && 'Connecting to Export Helper…'}
            {portStatus === 'reconnecting' && 'Reconnecting to Export Helper…'}
            {portStatus === 'failed' && 'Could not connect.'}
            {portStatus === 'disconnected' && 'Disconnected.'}
            {portStatus === 'connected' && 'Waiting for first status update…'}
          </SubHeader>
          {(portStatus === 'failed' || portStatus === 'disconnected') && (
            <>
              <ErrorBanner>
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{portError || 'Unable to reach the Export Helper.'}</span>
              </ErrorBanner>
              <Controls>
                <BtnBase type="button" onClick={reconnect}>
                  <RefreshCw size={14} /> Retry
                </BtnBase>
              </Controls>
            </>
          )}
        </Card>
      </Wrap>
    )
  }

  const items = Array.isArray(snapshot.items) ? snapshot.items : []
  const pct = totals.bytesTotal > 0 ? Math.min(100, (totals.bytesDone / totals.bytesTotal) * 100) : 0

  return (
    <Wrap>
      <Card>
        <Header>Exporting Variant {variant}</Header>
        <SubHeader>
          Run state: {runState}
          {snapshot.target_folder ? ` · ${snapshot.target_folder}` : ''}
        </SubHeader>

        {(portStatus === 'reconnecting' || portStatus === 'disconnected') && (
          <Banner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              {portStatus === 'reconnecting'
                ? 'Disconnected from Export Helper. Reconnecting…'
                : 'Disconnected from Export Helper. '}
              {portStatus === 'disconnected' && (
                <button type="button" onClick={reconnect}
                  style={{ background: 'none', border: 'none', color: '#92400e', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}>
                  Retry now
                </button>
              )}
            </span>
          </Banner>
        )}

        <Bar>
          <BarFill style={{ width: `${pct}%` }} $running={runState === 'running'} />
        </Bar>
        <BarLabel>
          <span>{totals.done} / {totals.total} done</span>
          <span>{formatBytes(totals.bytesDone)} / {formatBytes(totals.bytesTotal)}</span>
        </BarLabel>

        {current && current.phase !== 'done' && current.phase !== 'failed' && (
          <CurrentCard>
            <span>current: {current.target_filename}</span>
            <span>
              {current.phase === 'downloading' && current.total_bytes > 0
                ? `${formatBytes(current.bytes_received)} / ${formatBytes(current.total_bytes)}`
                : phaseLabel(current.phase)}
            </span>
          </CurrentCard>
        )}

        <SpeedRow>
          <span>speed: {speedMbps > 0 ? `${speedMbps.toFixed(1)} Mbps` : '—'}</span>
          <span>ETA: {etaMin != null ? `${etaMin} min` : '—'}</span>
        </SpeedRow>

        <Controls>
          {isPaused ? (
            <BtnBase type="button" onClick={() => handleControl('resume')}
                     disabled={!canInteract || !!pendingAction}>
              <Play size={14} />
              {pendingAction?.action === 'resume' ? 'Resuming…' : 'Resume'}
            </BtnBase>
          ) : (
            <BtnBase type="button" onClick={() => handleControl('pause')}
                     disabled={!canInteract || !!pendingAction}>
              <Pause size={14} />
              {pendingAction?.action === 'pause' ? 'Pausing…' : 'Pause'}
            </BtnBase>
          )}
          <DangerBtn type="button" onClick={() => handleControl('cancel')}
                     disabled={!canInteract || isCancelling}>
            <Square size={14} />
            {isCancelling ? 'Cancelling…' : 'Cancel'}
          </DangerBtn>
        </Controls>

        {controlErr && (
          <ErrorBanner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{controlErr}</span>
          </ErrorBanner>
        )}

        <Section>
          <SectionLabel>Item status</SectionLabel>
          <Table>
            <TableHeader>
              <span>#</span>
              <span>Filename</span>
              <span>Source</span>
              <span>Phase</span>
              <span>Progress</span>
              <span>Speed</span>
            </TableHeader>
            {items.map(it => {
              const pctItem = it.total_bytes > 0 ? (it.bytes_received / it.total_bytes) * 100 : 0
              return (
                <Row key={`${it.source}|${it.source_item_id}`}>
                  <span>{String(it.seq).padStart(3, '0')}</span>
                  <span title={it.target_filename}
                    style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {it.target_filename}
                  </span>
                  <span>{it.source}</span>
                  <PhaseBadge $phase={it.phase}>
                    {phaseGlyph(it.phase)} {phaseLabel(it.phase)}
                  </PhaseBadge>
                  <span>
                    {it.phase === 'downloading' && it.total_bytes > 0
                      ? `${Math.round(pctItem)}%`
                      : it.phase === 'done'
                        ? formatBytes(it.bytes_received || 0)
                        : '—'}
                  </span>
                  <span>{it.phase === 'downloading' ? '…' : '—'}</span>
                </Row>
              )
            })}
          </Table>
        </Section>

        <Counters>
          <CounterItem><strong>{totals.done}</strong> ok</CounterItem>
          <CounterItem><strong>{totals.failed}</strong> failed</CounterItem>
          <CounterItem><strong>{totals.remaining}</strong> remaining</CounterItem>
        </Counters>
      </Card>
    </Wrap>
  )
}
