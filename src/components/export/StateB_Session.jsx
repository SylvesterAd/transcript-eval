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

const ContinueLink = styled.button`
  margin-top: 12px;
  background: none;
  border: none;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
  &:hover { color: #374151; }
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

export default function StateB_Session({ variant, envatoItemCount, onContinue }) {
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

        <SignInButton href="https://app.envato.com/sign-in" target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          Sign in to Envato
        </SignInButton>

        <Footnote>This page updates automatically after sign-in.</Footnote>

        {/* TODO Ext.4: remove this manual override once the extension's
            cookie watcher reliably reports envato_session === 'ok'.
            Today (Ext.1) the extension hard-codes 'missing', so without
            this escape hatch every user is stuck on State B forever. */}
        <ContinueLink type="button" onClick={onContinue}>
          I'm already signed in — continue
        </ContinueLink>
        <ManualWarning>
          We'll re-check your Envato session before the first download.
        </ManualWarning>
      </Card>
    </Wrap>
  )
}
