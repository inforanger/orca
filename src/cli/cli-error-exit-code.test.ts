import { describe, expect, it } from 'vitest'
import { resolveCliExitCode } from './cli-error'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'

describe('resolveCliExitCode', () => {
  it('returns exit code 2 for fatal non-retryable errors', () => {
    const fatalCodes = [
      'consumer_fenced',
      'consumer_closed',
      'fenced_by_subsequent',
      'stable_pane_required',
      'terminal_not_found',
      'permission_denied'
    ]

    for (const code of fatalCodes) {
      const clientError = new RuntimeClientError(code, `Fatal test error for ${code}`)
      expect(resolveCliExitCode(clientError)).toBe(2)

      const rpcError = new RuntimeRpcFailureError({
        id: 'test',
        ok: false,
        error: {
          code,
          message: `Fatal RPC test error for ${code}`
        },
        _meta: { runtimeId: 'test-runtime' }
      })
      expect(resolveCliExitCode(rpcError)).toBe(2)
    }
  })

  it('returns exit code 1 for generic and retryable client errors', () => {
    const genericCodes = ['invalid_argument', 'timeout', 'unknown_error', 'validation_failed']

    for (const code of genericCodes) {
      const clientError = new RuntimeClientError(code, `Generic test error for ${code}`)
      expect(resolveCliExitCode(clientError)).toBe(1)
    }
  })

  it('returns exit code 1 for standard javascript errors', () => {
    expect(resolveCliExitCode(new Error('Unexpected disk failure'))).toBe(1)
    expect(resolveCliExitCode('plain string error')).toBe(1)
    expect(resolveCliExitCode(null)).toBe(1)
  })
})
