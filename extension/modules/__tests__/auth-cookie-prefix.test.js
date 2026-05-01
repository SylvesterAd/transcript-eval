// Regression: Envato versions the Elements session cookie
// (`elements.session.5`, `.6`, ...). Hardcoding `.5` made hasEnvatoSession
// return false whenever Envato bumped the suffix, even for fully signed-in
// users. The pure prefix matcher is exported separately so the rule is
// trivially testable without spinning up chrome.cookies.

import { describe, it, expect } from 'vitest'
import { isEnvatoElementsSessionCookie } from '../auth.js'

describe('isEnvatoElementsSessionCookie', () => {
  it('matches every numeric version suffix Envato has shipped', () => {
    expect(isEnvatoElementsSessionCookie('elements.session.5')).toBe(true)
    expect(isEnvatoElementsSessionCookie('elements.session.6')).toBe(true)
    expect(isEnvatoElementsSessionCookie('elements.session.42')).toBe(true)
  })

  it('matches future non-numeric suffixes (defensive against further renames)', () => {
    expect(isEnvatoElementsSessionCookie('elements.session.v2')).toBe(true)
    expect(isEnvatoElementsSessionCookie('elements.session.token')).toBe(true)
  })

  it('rejects unrelated cookies', () => {
    expect(isEnvatoElementsSessionCookie('envato_client_id')).toBe(false)
    expect(isEnvatoElementsSessionCookie('elements_session_5')).toBe(false)  // wrong separator
    expect(isEnvatoElementsSessionCookie('session.elements.5')).toBe(false)  // wrong order
    expect(isEnvatoElementsSessionCookie('')).toBe(false)
  })

  it('rejects non-string input safely (defensive — chrome.cookies sometimes returns odd shapes)', () => {
    expect(isEnvatoElementsSessionCookie(null)).toBe(false)
    expect(isEnvatoElementsSessionCookie(undefined)).toBe(false)
    expect(isEnvatoElementsSessionCookie(5)).toBe(false)
  })
})
