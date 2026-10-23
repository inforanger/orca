import type { CommandHandler } from '../dispatch'
import type { TerminalPromptResult } from '../../shared/terminal-prompt-result'
import { TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { getTerminalHandle } from '../selectors'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'

function promptResultHandler(wait: boolean): CommandHandler {
  return async ({ flags, client, cwd, json }) => {
    const status = await client.getCliStatus()
    if (
      !status.result.runtime.capabilities?.includes(TERMINAL_PROMPT_COMPLETIONS_RUNTIME_CAPABILITY)
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update the execution host to use terminal prompt completions.'
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
    const result = await client.call<{ prompt: TerminalPromptResult }>(
      wait ? 'terminal.waitPrompt' : 'terminal.promptResult',
      {
        terminal: await getTerminalHandle(flags, cwd, client),
        requestId: getRequiredStringFlag(flags, 'request-id'),
        ...(wait
          ? { timeoutMs }
          : {
              offset: offsetText === undefined ? 0 : Number(offsetText),
              limit
            })
      },
      wait ? { timeoutMs: timeoutMs + 5_000 } : undefined
    )
    printResult(result, json, ({ prompt }) => JSON.stringify(prompt, null, 2))
    if (
      result.result.prompt.state !== 'completed' ||
      !result.result.prompt.completion?.answerComplete ||
      result.result.prompt.completion.status !== 'done'
    ) {
      process.exitCode = 1
    }
  }
}

export const terminalPromptResultHandler = promptResultHandler(false)
export const terminalWaitPromptHandler = promptResultHandler(true)
