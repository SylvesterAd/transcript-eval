import { useState } from 'react'
import styled from 'styled-components'
import { Download, AlertCircle, RefreshCw } from 'lucide-react'

// Spec § State A. Polls extension via the parent's useExportPreflight
// hook (parent passes `installed` derived from ping.value).
//
// Renders one of three surfaces:
//   - non-Chrome browser → "This feature requires Chrome" banner.
//   - Chrome, extension missing → install card.
//   - Chrome, extension installed but older than bundled latest → update card.
//
// We detect Chrome via window.chrome?.runtime presence (the actual
// capability we need) + UA fallback for friendlier copy.

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

const Title = styled.h1`
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
`

const SubText = styled.p`
  font-size: 14px;
  color: #4b5563;
  margin: 8px 0 16px;
  line-height: 1.5;
`

const InstallButton = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #2563eb;
  color: #fff;
  border-radius: 8px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  margin: 8px 0;
  &:hover { background: #1d4ed8; }
`

const Banner = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  margin-bottom: 20px;
`

const Footnote = styled.p`
  font-size: 12px;
  color: #6b7280;
  margin: 12px 0 0;
`

const Diagnostics = styled.details`
  margin-top: 16px;
  font-size: 12px;
  color: #6b7280;
  > summary {
    cursor: pointer;
    user-select: none;
    color: #6b7280;
  }
  > div {
    margin-top: 8px;
    padding: 10px 12px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.6;
    word-break: break-all;
    color: #374151;
  }
`

function detectBrowser() {
  if (typeof navigator === 'undefined') return { isChromium: false, label: 'unknown' }
  const ua = navigator.userAgent.toLowerCase()
  // The capability check is what matters — we'll send chrome.runtime
  // messages either way; this is for UI copy only.
  const hasChromeRuntime = typeof chrome !== 'undefined' && !!chrome?.runtime?.sendMessage
  if (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('chromium/')) {
    return { isChromium: false, label: 'Safari', hasRuntime: hasChromeRuntime }
  }
  if (ua.includes('firefox/')) {
    return { isChromium: false, label: 'Firefox', hasRuntime: hasChromeRuntime }
  }
  return { isChromium: true, label: 'Chrome', hasRuntime: hasChromeRuntime }
}

export default function StateA_Install({ variant, ping, mode = 'install' }) {
  const [browser] = useState(detectBrowser)

  // Chrome Web Store listing for the Transcript Eval Export Helper extension.
  // Listing ID is the public Web Store identifier; the path /detail/<slug>/<id>
  // is canonical so the link survives slug renames.
  const STORE_URL = 'https://chromewebstore.google.com/detail/transcript-eval-export-he/mmpjebkpbikpmkmdafooadlclakjcdom'

  if (!browser.isChromium) {
    return (
      <Wrap>
        <Card>
          <Title>This feature requires Chrome</Title>
          <Banner>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Looks like you're on {browser.label}. The Export Helper extension is
              Chrome-only at launch. Safari and Firefox support is planned but not
              yet available.
            </span>
          </Banner>
          <SubText>Open this page in Chrome to continue.</SubText>
          <InstallButton href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
            <Download size={16} />
            Get Chrome
          </InstallButton>
        </Card>
      </Wrap>
    )
  }

  const isUpdate = mode === 'update'
  const detectedVersion = ping.value?.ext_version || null
  const latestVersion = ping.value?.latest_version || null
  const extId = ping.value?.ext_id || null
  const probeReason = ping.value?.reason || null
  const probeError = ping.value?.error || (ping.status === 'error' ? ping.error : null)

  return (
    <Wrap>
      <Card>
        <Title>
          {isUpdate
            ? `Update the Export Helper to continue`
            : `Ready to export Variant ${variant}`}
        </Title>
        {isUpdate ? (
          <>
            <SubText>
              Your Export Helper is on v{detectedVersion || '?'} but this page
              needs v{latestVersion || '?'} or newer.
            </SubText>
            <SubText>
              Open <code>chrome://extensions</code>, toggle <strong>Developer mode</strong> on,
              click <strong>Update</strong>, then return here. The page will continue automatically.
            </SubText>
            <InstallButton href={STORE_URL} target="_blank" rel="noreferrer">
              <RefreshCw size={16} />
              Open Chrome Web Store listing
            </InstallButton>
          </>
        ) : (
          <>
            <SubText>
              Install the Export Helper Chrome extension to continue.
            </SubText>
            <SubText>
              This extension downloads your licensed b-roll files into a folder
              using your own Envato subscription. Files never leave your computer.
            </SubText>
            <InstallButton href={STORE_URL} target="_blank" rel="noreferrer">
              <Download size={16} />
              Install from Chrome Web Store
            </InstallButton>
          </>
        )}
        <Footnote>
          {isUpdate ? 'After update, this page continues automatically.' : 'After install, this page updates automatically.'}
          {ping.status === 'loading' ? ' Checking…' : ''}
        </Footnote>
        <Diagnostics>
          <summary>Detection details</summary>
          <div>
            ping: {ping.status}{probeReason ? ` (${probeReason})` : ''}<br />
            extension id (expected): {extId || '(empty — VITE_EXTENSION_ID not set at build)'}<br />
            installed version: {detectedVersion || '—'}<br />
            latest known version: {latestVersion || '—'}<br />
            {probeError ? <>probe error: {probeError}<br /></> : null}
          </div>
        </Diagnostics>
      </Card>
    </Wrap>
  )
}
