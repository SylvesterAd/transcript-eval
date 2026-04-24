import styled from 'styled-components'
import { CheckCircle2 } from 'lucide-react'

// Spec § State E. Phase B ships a PLACEHOLDER — the real UI (open
// folder button, XML download links, "How to import in Premiere"
// tutorial link) lives in the next webapp plan which also wires
// XMEML generation via WebApp.2.

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
  color: #15803d;
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

export default function StateE_Complete_Placeholder({ complete }) {
  const ok = complete?.ok_count ?? 0
  const folder = complete?.folder_path ?? '(none)'
  const xmls = Array.isArray(complete?.xml_paths) ? complete.xml_paths : []

  return (
    <Wrap>
      <Card>
        <StubBanner>
          WebApp.1 Phase C placeholder — full State E UI lands in the next
          plan (open-folder button, XML download links, Premiere import
          tutorial). This stub renders raw completion fields.
        </StubBanner>
        <Header>
          <CheckCircle2 size={22} /> Export complete
        </Header>
        <Detail>ok_count: {ok}</Detail>
        <Detail>folder: {folder}</Detail>
        <Detail>xml_paths: {xmls.length ? xmls.join('\n') : '(none)'}</Detail>
      </Card>
    </Wrap>
  )
}
