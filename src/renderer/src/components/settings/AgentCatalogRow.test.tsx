// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCatalogRow, type AgentCatalogRowProps } from './AgentCatalogRow'

afterEach(cleanup)

function rowProps(overrides: Partial<AgentCatalogRowProps> = {}): AgentCatalogRowProps {
  return {
    agentId: 'claude',
    label: 'Claude',
    homepageUrl: 'https://example.com',
    defaultCmd: 'claude',
    defaultArgs: '',
    defaultEnv: {},
    isDetected: true,
    isEnabled: true,
    isDefault: false,
    cmdOverride: undefined,
    argsOverride: '',
    envOverride: {},
    onSetDefault: vi.fn(),
    onSetEnabled: vi.fn(),
    onSaveOverride: vi.fn(),
    onSaveArgs: vi.fn(),
    onSaveEnv: vi.fn(),
    ...overrides
  }
}

async function expand(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Expand command override' }))
}

describe('AgentCatalogRow environment editor', () => {
  it('lets an agent with no default or saved environment gain its first variables', async () => {
    const props = rowProps()
    const user = userEvent.setup()
    render(<AgentCatalogRow {...props} />)
    await expand(user)
    await user.type(
      screen.getByPlaceholderText('No default environment'),
      'CLAUDE_CODE_SUBAGENT_MODEL=m CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1{Enter}'
    )
    expect(props.onSaveEnv).toHaveBeenCalledWith({
      CLAUDE_CODE_SUBAGENT_MODEL: 'm',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1'
    })
    expect(props.onSaveOverride).not.toHaveBeenCalled()
    expect(props.onSaveArgs).not.toHaveBeenCalled()
    expect(props.onSetEnabled).not.toHaveBeenCalled()
    expect(props.onSetDefault).not.toHaveBeenCalled()
  })

  it('keeps the editor and clears its text when the saved environment is removed on rerender', async () => {
    const props = rowProps({ envOverride: { KEEP: '1' } })
    const user = userEvent.setup()
    const view = render(<AgentCatalogRow {...props} />)
    expect(screen.getByDisplayValue('KEEP=1')).toBeTruthy()
    view.rerender(<AgentCatalogRow {...props} envOverride={{}} />)
    const input = screen.getByPlaceholderText('No default environment')
    expect(input).toHaveProperty('value', '')
    expect(screen.queryByDisplayValue('KEEP=1')).toBeNull()
    await user.type(input, 'NEXT=2{Enter}')
    expect(props.onSaveEnv).toHaveBeenLastCalledWith({ NEXT: '2' })
  })

  it('does not save anything when only expanding the row', async () => {
    const props = rowProps()
    const user = userEvent.setup()
    render(<AgentCatalogRow {...props} />)
    await expand(user)
    for (const key of ['onSaveEnv', 'onSaveOverride', 'onSaveArgs'] as const) {
      expect(props[key]).not.toHaveBeenCalled()
    }
  })
})
