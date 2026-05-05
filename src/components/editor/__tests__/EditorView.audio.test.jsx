import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import RoughCutPreview from '../RoughCutPreview.jsx'
import { EditorContext } from '../EditorView.jsx'

afterEach(cleanup)

function withCtx(state, mediaType = 'video') {
  return (
    <MemoryRouter>
      <EditorContext.Provider value={{
        state,
        videoRefs: { current: {} },
        totalDuration: 60,
        mediaType,
      }}>
        <RoughCutPreview />
      </EditorContext.Provider>
    </MemoryRouter>
  )
}

describe('RoughCutPreview audio mode', () => {
  it('renders "No video — audio only" placeholder when mediaType=audio', () => {
    render(withCtx({
      tracks: [],
      roughCutTrackMode: 'main',
      cuts: [],
      segmentVideoOverrides: {},
      currentTime: 0,
    }, 'audio'))
    // jest-dom is not installed; getByText throws on miss, so reaching here confirms presence.
    expect(screen.getByText(/no video.*audio only/i)).toBeTruthy()
  })
  it('does not render the placeholder for video mediaType', () => {
    render(withCtx({
      tracks: [{ id: 'v-1', type: 'video', offset: 0, duration: 10, videoId: 1 }],
      roughCutTrackMode: 'main',
      cuts: [],
      segmentVideoOverrides: {},
      currentTime: 0,
    }, 'video'))
    expect(screen.queryByText(/no video.*audio only/i)).toBeNull()
  })
})
