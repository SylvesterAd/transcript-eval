import styled from 'styled-components'
import { CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'

// Spec § State B. Render in two cases:
//   1. Manifest contains Envato items AND extension's envato_session !== 'ok'.
//   2. Skipped entirely if no Envato items in manifest.
//
// IMPORTANT: Ext.1 always reports envato_session: 'missing' because the
// cookie watcher lands in Ext.4. Until then, this state is OPTIMISTIC:
// we render the warning + sign-in CTA but offer a manual "I'm signed
// in, continue" override so users aren't blocked. Once Ext.4 ships,
// hide the manual override (see TODO comment below).

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
  margin: 0 0 16px;
`

const Row = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 6px 0;
  font-size: 14px;
  color: #1f2937;
  & .icon-ok { color: #16a34a; }
  & .icon-warn { color: #d97706; }
`

const Detail = styled.p`
  font-size: 13px;
  color: #4b5563;
  margin: 4px 0 0 24px;
  line-height: 1.5;
`

const SignInButton = styled.a`
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
  margin: 16px 0 8px;
  &:hover { background: #1d4ed8; }
`

const ContinueButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 10px 16px;
  background: #fff;
  color: #1f2937;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  &:hover { background: #f9fafb; border-color: #9ca3af; }
`

const ManualWarning = styled.p`
  font-size: 11px;
  color: #9ca3af;
  margin: 4px 0 0;
  line-height: 1.4;
`

const Footnote = styled.p`
  font-size: 12px;
  color: #6b7280;
  margin: 16px 0 0;
`

const Diagnostics = styled.details`
  margin-top: 16px;
  font-size: 12px;
  color: #6b7280;
  > summary { cursor: pointer; user-select: none; }
  > div {
    margin-top: 8px;
    padding: 10px 12px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.6;
    color: #374151;
  }
`

export default function StateB_Session({ variant, envatoItemCount, ping, onContinue }) {
  const detail = ping?.value?.envato_session_detail || null
  const sessionRaw = ping?.value?.envato_session || (ping?.status === 'loading' ? '(checking…)' : '(no ping yet)')
  return (
    <Wrap>
      <Card>
        <Title>Ready to export Variant {variant}</Title>

        <Row>
          <CheckCircle2 size={16} className="icon-ok" />
          <span>Export Helper installed</span>
        </Row>

        <Row>
          <AlertCircle size={16} className="icon-warn" />
          <span>Sign in to Envato to continue</span>
        </Row>
        <Detail>
          Your b-roll includes {envatoItemCount} Envato clip{envatoItemCount === 1 ? '' : 's'}.
          Sign in to license and download them.
        </Detail>

        <SignInButton href="https://elements.envato.com/sign-in" target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          Sign in to Envato
        </SignInButton>

        <Footnote>This page re-checks every 2 seconds and continues automatically once we see your session.</Footnote>

        <ContinueButton type="button" onClick={onContinue}>
          I'm already signed in — continue anyway
        </ContinueButton>
        <ManualWarning>
          Use this if the page doesn't auto-detect your sign-in. We'll skip
          the cookie check and try the download — if your session really
          is missing, individual items will fail in the next step where
          you can retry them.
        </ManualWarning>

        <Diagnostics>
          <summary>Why doesn't it detect my sign-in?</summary>
          <div>
            ping status: {ping?.status || '(unknown)'}<br />
            envato_session: {sessionRaw}<br />
            detail: {detail || '—'}<br />
            {detail === 'cookies_missing' && (
              <>
                The extension can't see <code>envato_client_id</code> + <code>elements.session.&lt;N&gt;</code> cookies on
                <code> .envato.com</code>. Make sure you signed in to <code>elements.envato.com</code> (not just app.envato.com),
                and that the extension has the <code>cookies</code> permission for <code>https://elements.envato.com/*</code>.<br />
              </>
            )}
            {detail === 'cookies_present' && (
              <>Cookies look present to the extension — if you're still on this page, the page may have stale state. Try refreshing.</>
            )}
          </div>
        </Diagnostics>
      </Card>
    </Wrap>
  )
}
