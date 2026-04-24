import styled from 'styled-components'
import { AlertCircle } from 'lucide-react'

// Spec § State F. Phase B ships a PLACEHOLDER — the real UI
// (per-failure diagnostics, "Retry failed items" / "Generate XML
// anyway" / "Report issue" controls + diagnostic bundle) lives in
// the next webapp plan.

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

const StubBanner = styled.div`
  background: #eff6ff;
  border: 1px dashed #93c5fd;
  color: #1e3a8a;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 16px;
`

const Header = styled.h1`
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px;
  color: #b45309;
`

const Detail = styled.pre`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #1f2937;
  white-space: pre-wrap;
  overflow-x: auto;
  margin: 6px 0;
`

export default function StateF_Partial_Placeholder({ complete, snapshot }) {
  const ok = complete?.ok_count ?? 0
  const fail = complete?.fail_count ?? 0
  const folder = complete?.folder_path ?? '(none)'
  const failedItems = Array.isArray(snapshot?.items)
    ? snapshot.items.filter(it => it.phase === 'failed')
    : []

  return (
    <Wrap>
      <Card>
        <StubBanner>
          WebApp.1 Phase C placeholder — full State F UI lands in the next
          plan (per-failure diagnostics, retry / generate-anyway / report-
          issue controls, diagnostic bundle). This stub renders raw
          failure fields.
        </StubBanner>
        <Header>
          <AlertCircle size={22} /> Export partial — {fail} item{fail === 1 ? '' : 's'} failed
        </Header>
        <Detail>ok_count: {ok}</Detail>
        <Detail>fail_count: {fail}</Detail>
        <Detail>folder: {folder}</Detail>
        <Detail>
          failed items:
          {'\n'}
          {failedItems.length
            ? failedItems.map(it => `  · ${it.target_filename} — ${it.error_code || 'unknown'}`).join('\n')
            : '  (extension did not report failed item list)'}
        </Detail>
      </Card>
    </Wrap>
  )
}
