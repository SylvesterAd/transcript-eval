import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import EditorSidebar from '../EditorSidebar.jsx'

afterEach(cleanup)

vi.mock('../../../contexts/RoleContext.jsx', () => ({
  useRole: () => ({ isAdmin: false }),
}))

const baseProps = {
  activeTab: 'sync',
  assemblyStatus: 'done',
  hasVideos: true,
  hasBrollSearch: true,
}

describe('EditorSidebar — Strategy click guard', () => {
  it('routes Strategy click to /?step=processing when chain is running', () => {
    const onNavigateToProcessing = vi.fn()
    const onTabChange = vi.fn()
    render(
      <EditorSidebar
        {...baseProps}
        brollChainStatus="running"
        parentGroupId={42}
        onNavigateToProcessing={onNavigateToProcessing}
        onTabChange={onTabChange}
      />
    )
    fireEvent.click(screen.getByText(/B-Roll Strategy/i))
    expect(onNavigateToProcessing).toHaveBeenCalledWith(42)
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('routes Strategy click normally when chain is done', () => {
    const onNavigateToProcessing = vi.fn()
    const onTabChange = vi.fn()
    render(
      <EditorSidebar
        {...baseProps}
        brollChainStatus="done"
        parentGroupId={42}
        onNavigateToProcessing={onNavigateToProcessing}
        onTabChange={onTabChange}
      />
    )
    fireEvent.click(screen.getByText(/B-Roll Strategy/i))
    expect(onTabChange).toHaveBeenCalledWith('brolls/strategy')
    expect(onNavigateToProcessing).not.toHaveBeenCalled()
  })

  it('keeps the existing paused_at_rough_cut resume behavior', () => {
    const onResumeFromRoughCut = vi.fn()
    const onNavigateToProcessing = vi.fn()
    const onTabChange = vi.fn()
    render(
      <EditorSidebar
        {...baseProps}
        brollChainStatus="paused_at_rough_cut"
        parentGroupId={42}
        onResumeFromRoughCut={onResumeFromRoughCut}
        onNavigateToProcessing={onNavigateToProcessing}
        onTabChange={onTabChange}
      />
    )
    fireEvent.click(screen.getByText(/B-Roll Strategy/i))
    expect(onResumeFromRoughCut).toHaveBeenCalled()
    expect(onNavigateToProcessing).not.toHaveBeenCalled()
    expect(onTabChange).not.toHaveBeenCalled()
  })
})
