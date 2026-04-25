import { useState, useEffect } from 'react'
import styled from 'styled-components'
import { AlertCircle, RefreshCw, FileText, Download, MessageCircle } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'
import { useExportXmlKickoff, triggerXmlDownload } from '../../hooks/useExportXmlKickoff.js'

// State F: partial-failure UI. Renders when the extension's
// {type:"complete"} Port message reports fail_count > 0. Reads:
//   - `complete`         — the extension's {type:"complete"} payload
//                          (ok_count, fail_count, folder_path).
//   - `snapshot`         — useExportPort's final snapshot. We read
//                          snapshot.items[] to get the failed item
//                          list with per-item source_item_id + source
//                          + target_filename + error_code.
//   - `exportId`         — the completed run's export_id.
//   - `variantLabels`    — e.g. ['A', 'C'].
//   - `unifiedManifest`  — the manifest built at State C, threaded
//                          through ExportPage's reducer state. Used
//                          in Task 3 to rebuild a filtered manifest
//                          for retry; Task 4 passes it to the
//                          useExportXmlKickoff hook.
//   - `onRetryFailed`    — callback wired in Task 3.
//
// This task (Task 2) renders the header + failed-items list only.
// Tasks 3/4/5 add the action row.

const Wrap = styled.div`
  max-width: 640px;
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
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
  color: #b45309;
`

const Summary = styled.p`
  margin: 0 0 20px;
  color: #4b5563;
  font-size: 14px;
`

const SectionLabel = styled.div`
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 8px;
  letter-spacing: 0.02em;
`

const List = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0 0 20px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 6px;
`

const Row = styled.li`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid #fef3c7;
  font-size: 13px;
  &:last-child { border-bottom: 0; }
`

const Filename = styled.span`
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: #1f2937;
  flex-shrink: 0;
`

const SourceChip = styled.span`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  background: #e0f2fe;
  color: #075985;
  text-transform: uppercase;
  flex-shrink: 0;
`

const Reason = styled.span`
  color: #78350f;
  flex: 1;
`

const ActionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
`

const RetryBtn = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #1a1a1a;
  font-size: 13px;
  cursor: pointer;
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  &:hover:not(:disabled) {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
`

const XmlBtn = styled(RetryBtn)``

const ReportBtn = styled(RetryBtn)`
  color: #6b7280;
`

const XmlPanel = styled.div`
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
  font-size: 13px;
  color: #4b5563;
`

const XmlErrorBox = styled.div`
  padding: 10px 14px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 6px;
  font-size: 13px;
  margin-top: 8px;
`

const XmlDownloadBtn = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #1a1a1a;
  font-size: 12px;
  cursor: pointer;
  margin-top: 8px;
  &:hover { background: #f3f4f6; }
`

// Child component — mounts ONLY when the user clicks "Generate XML
// anyway." Calling useExportXmlKickoff conditionally would violate
// React's rules-of-hooks; isolating it here keeps the hook's state
// scoped to the user's explicit opt-in.
//
// autoKick:false disables the hook's built-in auto-run (which is
// gated on fail_count===0 anyway — State F would never auto-kick —
// but we pass it explicitly for clarity). We fire regenerate() once
// on mount to kick the 3-step flow.
function XmlKickoffPanel({ exportId, variantLabels, unifiedManifest, complete }) {
  const kickoff = useExportXmlKickoff({
    exportId,
    variantLabels,
    unifiedManifest,
    complete,
    autoKick: false,
  })

  // Fire once on mount.
  useEffect(() => {
    kickoff.regenerate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const xmlByVariant = kickoff.xml_by_variant || {}
  const variantsReady = kickoff.status === 'ready' && Object.keys(xmlByVariant).length > 0

  function onDownloadAgain(label) {
    const xml = xmlByVariant[label]
    if (!xml) return
    triggerXmlDownload(`variant-${String(label).toLowerCase()}.xml`, xml)
  }

  return (
    <XmlPanel>
      <div>
        Missing clips will appear as offline (red) in Premiere. You can
        relink them manually later.
      </div>
      {kickoff.status === 'posting-result' && (
        <div style={{ marginTop: 8 }}><FileText size={14} /> Preparing XML&hellip;</div>
      )}
      {kickoff.status === 'generating' && (
        <div style={{ marginTop: 8 }}><FileText size={14} /> Generating XML&hellip;</div>
      )}
      {kickoff.status === 'error' && (
        <XmlErrorBox>
          <strong>Couldn&rsquo;t generate XML.</strong>{' '}
          {kickoff.error || 'Unknown error.'} Try again below.
          <div style={{ marginTop: 8 }}>
            <XmlDownloadBtn type="button" onClick={kickoff.regenerate}>
              <RefreshCw size={14} /> Retry generate
            </XmlDownloadBtn>
          </div>
        </XmlErrorBox>
      )}
      {variantsReady && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {variantLabels.map(label => xmlByVariant[label] ? (
            <XmlDownloadBtn key={label} type="button" onClick={() => onDownloadAgain(label)}>
              <Download size={14} /> Download variant-{String(label).toLowerCase()}.xml again
            </XmlDownloadBtn>
          ) : null)}
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            XML auto-downloaded to your default downloads folder.
          </div>
        </div>
      )}
    </XmlPanel>
  )
}

function FailedItemRow({ item }) {
  const label = getErrorLabel(item.error_code)
  return (
    <Row>
      <Filename>{item.target_filename || `item-${item.seq}`}</Filename>
      <SourceChip>{item.source || 'unknown'}</SourceChip>
      <Reason>{label}</Reason>
    </Row>
  )
}

export default function StateF_Partial({
  complete,
  snapshot,
  exportId,
  variantLabels,
  unifiedManifest,
  onRetryFailed,
}) {
  const [xmlPanelShown, setXmlPanelShown] = useState(false)

  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const total = ok + fail
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

  // Retry: collect source_item_ids of failed items and hand off to
  // the caller. ExportPage rebuilds the filtered manifest from its
  // authoritative state.unified_manifest.items (NOT from snapshot.items,
  // which is the Port's wire view and loses envato_item_url / placements).
  // See invariant #5 in the plan.
  function onRetryClick() {
    if (!onRetryFailed || failedItems.length === 0) return
    const failedIds = new Set(failedItems.map(it => it.source_item_id).filter(Boolean))
    onRetryFailed({ failedIds })
  }

  return (
    <Wrap>
      <Card>
        <Header>
          <AlertCircle size={22} /> Export partial
        </Header>
        <Summary>
          {ok} / {total} clip{total === 1 ? '' : 's'} downloaded · {fail} failed
        </Summary>

        <SectionLabel>Failed items</SectionLabel>
        {failedItems.length === 0 ? (
          <Summary>
            The extension reported {fail} failure{fail === 1 ? '' : 's'} but
            did not include a per-item list. This is rare — check the
            extension popup or try reloading the page.
          </Summary>
        ) : (
          <List>
            {failedItems.map(it => (
              <FailedItemRow key={it.source_item_id || it.seq} item={it} />
            ))}
          </List>
        )}

        <ActionRow>
          <RetryBtn
            type="button"
            onClick={onRetryClick}
            disabled={!onRetryFailed || failedItems.length === 0}
            title={!onRetryFailed ? 'Retry wiring unavailable — see devtools' : undefined}
          >
            <RefreshCw size={14} /> Retry failed items
          </RetryBtn>
          <XmlBtn
            type="button"
            onClick={() => setXmlPanelShown(true)}
            disabled={xmlPanelShown || !exportId || !unifiedManifest}
          >
            <FileText size={14} /> Generate XML anyway
          </XmlBtn>
          <ReportBtn
            type="button"
            disabled
            title="Coming in Ext.8 — will auto-attach a diagnostic bundle"
          >
            <MessageCircle size={14} /> Report issue
          </ReportBtn>
        </ActionRow>
        {xmlPanelShown && (
          <XmlKickoffPanel
            exportId={exportId}
            variantLabels={variantLabels || []}
            unifiedManifest={unifiedManifest}
            complete={complete}
          />
        )}
      </Card>
    </Wrap>
  )
}
