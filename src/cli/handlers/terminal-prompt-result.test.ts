import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { RuntimeClient } from '../runtime-client'
import { terminalPromptResultHandler, terminalWaitPromptHandler } from './terminal-prompt-result'

const { status, call, print } = vi.hoisted(() => ({
  status: vi.fn(),
  call: vi.fn(),
  print: vi.fn()
}))
vi.mock('../runtime-client', async () => {
  const errors = await import('../runtime/types.js')
  return {
    ...errors,
    RuntimeClient: class {
      getCliStatus = status
      call = call
    }
  }
})
vi.mock('../format', () => ({ printResult: print }))

function context(flags: Record<string, string>) {
  return {
    flags: new Map(Object.entries({ terminal: 'term-1', 'request-id': 'request-1', ...flags })),
    client: new RuntimeClient('/unused'),
    cwd: '/folder-workspace',
    json: true
  }
}

describe('terminal prompt completion commands', () => {
  afterEach(() => {
    vi.clearAllMocks()
    process.exitCode = 0
  })

  it('rejects a host without support before making a prompt RPC', async () => {
    status.mockResolvedValue({ result: { runtime: { capabilities: [] } } })
    await expect(terminalWaitPromptHandler(context({}))).rejects.toThrow(
      'Update the execution host'
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('waits on the same request with transport grace and reports pending as unsatisfied', async () => {
    status.mockResolvedValue({
      result: { runtime: { capabilities: [TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY] } }
    })
    call.mockResolvedValue({ result: { prompt: { state: 'pending' } } })
    await terminalWaitPromptHandler(context({ 'timeout-ms': '60000' }))
    expect(call).toHaveBeenCalledWith(
      'terminal.waitPrompt',
      { terminal: 'term-1', requestId: 'request-1', timeoutMs: 60000 },
      { timeoutMs: 65000 }
    )
    expect(process.exitCode).toBe(1)
    expect(print).toHaveBeenCalled()
  })

  it('exposes pagination offsets and refuses incomplete answers', async () => {
    status.mockResolvedValue({
      result: { runtime: { capabilities: [TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY] } }
    })
    call.mockResolvedValue({
      result: {
        prompt: {
          state: 'completed',
          completion: { status: 'done', answerComplete: false },
          answer: { text: '', nextOffset: null }
        }
      }
    })
    await terminalPromptResultHandler(context({ offset: '16384', limit: '1000' }))
    expect(call).toHaveBeenCalledWith(
      'terminal.promptResult',
      { terminal: 'term-1', requestId: 'request-1', offset: 16384, limit: 1000 },
      undefined
    )
    expect(process.exitCode).toBe(1)
  })
})
