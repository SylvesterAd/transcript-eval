import styled from 'styled-components'
import { AlertCircle } from 'lucide-react'
import { getErrorLabel } from '../../lib/errorCodeLabels.js'

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
  // Props wired in Tasks 3–4; unused in Task 2 but already accepted
  // so ExportPage's prop-threading edit in Task 6 compiles:
  // eslint-disable-next-line no-unused-vars
  exportId,
  // eslint-disable-next-line no-unused-vars
  variantLabels,
  // eslint-disable-next-line no-unused-vars
  unifiedManifest,
  // eslint-disable-next-line no-unused-vars
  onRetryFailed,
}) {
  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const total = ok + fail
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

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

        {/* Action row lands in Tasks 3–5. */}
      </Card>
    </Wrap>
  )
}
