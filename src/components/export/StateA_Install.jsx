import { useState } from 'react'
import styled from 'styled-components'
import { Download, AlertCircle } from 'lucide-react'

// Spec § State A. Polls extension via the parent's useExportPreflight
// hook (parent passes `installed` derived from ping.value).
//
// Renders one of two surfaces:
//   - non-Chrome browser → "This feature requires Chrome" banner.
//   - Chrome, extension missing → install card (per spec mockup).
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

export default function StateA_Install({ variant, ping }) {
  const [browser] = useState(detectBrowser)

  // Chrome Web Store URL placeholder — Ext.11 fills in the real listing
  // URL. For Phase A we point at chrome://extensions with a "Load
  // unpacked" hint copy because there's no published store listing yet.
  const STORE_URL = 'https://chrome.google.com/webstore/'  // TODO Ext.11: replace with real listing

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

  return (
    <Wrap>
      <Card>
        <Title>Ready to export Variant {variant}</Title>
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
        <Footnote>
          After install, this page updates automatically.
          {ping.status === 'loading' ? ' Checking…' : ''}
          {ping.status === 'error' ? ` (probe error: ${ping.error})` : ''}
        </Footnote>
      </Card>
    </Wrap>
  )
}
