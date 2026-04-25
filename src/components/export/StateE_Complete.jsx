import styled from 'styled-components'
import { CheckCircle2, Download, FileText, AlertCircle } from 'lucide-react'
import { useExportXmlKickoff, triggerXmlDownload } from '../../hooks/useExportXmlKickoff.js'

// State E: export succeeded, zero failures, XMEML generation in
// progress or ready. Reads:
//   - `complete`          — the extension's {type:"complete"} payload
//                           (ok_count, folder_path). Always available
//                           when this component mounts.
//   - `exportId`          — the export row ID (from the FSM).
//   - `variantLabels`     — e.g. ['A', 'C'] for multi-variant exports.
//   - `unifiedManifest`   — built at State C and passed through the FSM.
//
// The useExportXmlKickoff hook does the heavy lifting: auto-kicks
// the 3-step write + generate + download flow on mount. This
// component renders the status + download buttons.

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
  margin: 0 0 12px;
  color: #15803d;
`

const Summary = styled.p`
  margin: 0 0 20px;
  color: #4b5563;
  font-size: 14px;
`

const Section = styled.div`
  margin: 16px 0;
`

const SectionLabel = styled.div`
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 8px;
  letter-spacing: 0.02em;
`

const Folder = styled.div`
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px 14px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #1f2937;
  word-break: break-all;
`

const Status = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #4b5563;
`

const DownloadBtn = styled.button`
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
  &:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
`

const RetryBtn = styled(DownloadBtn)`
  color: #b91c1c;
  border-color: #fca5a5;
  &:hover {
    background: #fef2f2;
    border-color: #ef4444;
  }
`

const ErrorBox = styled.div`
  padding: 10px 14px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 12px;
`

const Tutorial = styled.details`
  margin-top: 20px;
  font-size: 13px;
  color: #4b5563;
  summary {
    cursor: pointer;
    color: #2563eb;
    font-weight: 500;
  }
  p {
    margin: 8px 0 0;
    line-height: 1.5;
  }
`

export default function StateE_Complete({
  complete,
  exportId,
  variantLabels,
  unifiedManifest,
}) {
  const ok = complete?.ok_count ?? 0
  const folder = complete?.folder_path ?? '(unknown)'

  const kickoff = useExportXmlKickoff({
    exportId,
    variantLabels,
    unifiedManifest,
    complete,
  })

  const pluralClip = ok === 1 ? 'clip' : 'clips'
  const xmlByVariant = kickoff.xml_by_variant || {}
  const variantsReady = kickoff.status === 'ready' && Object.keys(xmlByVariant).length > 0

  function onDownloadAgain(label) {
    const xml = xmlByVariant[label]
    if (!xml) return
    triggerXmlDownload(`variant-${String(label).toLowerCase()}.xml`, xml)
  }

  return (
    <Wrap>
      <Card>
        <Header>
          <CheckCircle2 size={22} /> Export complete
        </Header>
        <Summary>
          {ok} {pluralClip} downloaded to your default downloads folder.
        </Summary>

        <Section>
          <SectionLabel>Folder</SectionLabel>
          <Folder>{folder}</Folder>
        </Section>

        <Section>
          <SectionLabel>Premiere XML</SectionLabel>
          {kickoff.status === 'posting-result' && (
            <Status><FileText size={16} /> Preparing XML&hellip;</Status>
          )}
          {kickoff.status === 'generating' && (
            <Status><FileText size={16} /> Generating XML&hellip;</Status>
          )}
          {kickoff.status === 'error' && (
            <>
              <ErrorBox>
                <strong>Couldn&rsquo;t generate XML.</strong>{' '}
                {kickoff.error || 'Unknown error.'} Your media files are
                safe on disk &mdash; retry below or open the folder manually.
              </ErrorBox>
              <RetryBtn type="button" onClick={kickoff.regenerate}>
                <AlertCircle size={14} /> Retry
              </RetryBtn>
            </>
          )}
          {variantsReady && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {variantLabels.map(label => xmlByVariant[label] ? (
                <DownloadBtn key={label} type="button" onClick={() => onDownloadAgain(label)}>
                  <Download size={14} /> Download variant-{String(label).toLowerCase()}.xml again
                </DownloadBtn>
              ) : null)}
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                XML files auto-downloaded to your default downloads folder.
                Click a button above to re-download if you cleared the browser queue.
              </div>
            </div>
          )}
          {kickoff.status === 'idle' && (
            <Status>Waiting for completion signal&hellip;</Status>
          )}
        </Section>

        <Tutorial>
          <summary>How to import in Premiere Pro</summary>
          <p>
            1. Move <code>variant-x.xml</code> into the same folder as your
            downloaded media (the folder above).
            2. In Premiere: File &rarr; Import &rarr; select the XML file.
            3. Premiere resolves the <code>file://./media/</code> paths
            relative to the XML&rsquo;s location.
          </p>
        </Tutorial>
      </Card>
    </Wrap>
  )
}
