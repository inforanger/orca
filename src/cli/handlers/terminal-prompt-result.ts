import type { CommandHandler } from '../dispatch'
import type {
  TerminalLastCompletion,
  TerminalPromptResult
} from '../../shared/terminal-prompt-result'
import {
  TERMINAL_LAST_COMPLETION_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { getTerminalHandle } from '../selectors'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'

function promptResultHandler(mode: 'read' | 'wait' | 'last'): CommandHandler {
  return async ({ flags, client, cwd, json }) => {
    const wait = mode === 'wait'
    const last = mode === 'last'
    const status = await client.getCliStatus()
    const capability = last
      ? TERMINAL_LAST_COMPLETION_RUNTIME_CAPABILITY
      : TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY
    if (!status.result.runtime.capabilities?.includes(capability)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        last
          ? 'Update the execution host to use terminal last completion.'
          : 'Update the execution host to use terminal prompt completions.'
      )
    }
    const offsetText = flags.get('offset')
    if (
      offsetText !== undefined &&
      (typeof offsetText !== 'string' ||
        !/^\d+$/.test(offsetText) ||
        !Number.isSafeInteger(Number(offsetText)))
    ) {
      throw new RuntimeClientError('invalid_argument', '--offset must be a non-negative integer')
    }
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms') ?? 300_000
    if (timeoutMs > 3_600_000) {
      throw new RuntimeClientError('invalid_argument', '--timeout-ms must not exceed 3600000')
    }
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined && limit > 16_384) {
      throw new RuntimeClientError('invalid_argument', '--limit must not exceed 16384')
    }
    const result = await client.call<{
      prompt?: TerminalPromptResult
      last?: TerminalLastCompletion
    }>(
      last ? 'terminal.lastCompletion' : wait ? 'terminal.waitPrompt' : 'terminal.promptResult',
      {
        terminal: await getTerminalHandle(flags, cwd, client),
        ...(last
          ? { turnId: flags.get('turn-id') }
          : { requestId: getRequiredStringFlag(flags, 'request-id') }),
        ...(wait
          ? { timeoutMs }
          : {
              offset: offsetText === undefined ? 0 : Number(offsetText),
              limit
            })
      },
      wait ? { timeoutMs: timeoutMs + 5_000 } : undefined
    )
    printResult(result, json, (body) => JSON.stringify(body.last ?? body.prompt, null, 2))
    const completion = result.result.last ?? result.result.prompt
    if (
      completion?.state !== 'completed' ||
      !completion.completion?.answerComplete ||
      completion.completion.status !== 'done'
    ) {
      process.exitCode = 1
    }
  }
}

export const terminalPromptResultHandler = promptResultHandler('read')
export const terminalWaitPromptHandler = promptResultHandler('wait')
export const terminalLastResultHandler = promptResultHandler('last')
