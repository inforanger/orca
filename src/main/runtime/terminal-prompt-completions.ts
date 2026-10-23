import { createHash } from 'node:crypto'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type {
  TerminalPromptCompletion,
  TerminalPromptResult
} from '../../shared/terminal-prompt-result'
import type {
  AgentPromptRequestBaseline,
  AgentPromptRequestCorrelation
} from './agent-prompt-request-correlation'

type Binding = { ptyId: string; generation: number; processIncarnation: string }
type Request = AgentPromptRequestBaseline & Binding & { terminal: string; registeredAt?: number }
type Entry = Request & {
  turnFloor: number
  turnStartedAt?: number
  completion?: TerminalPromptCompletion
  text?: string
}

const MAX_ENTRIES = 1_024
const MAX_RETAINED_CHARS = 16 * 1024 * 1024
const PAGE_CHARS = 16_384

export class TerminalPromptCompletions {
  private readonly entries = new Map<string, Entry>()
  private readonly latestTurns = new Map<string, Binding & { startedAt: number }>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private retainedChars = 0

  constructor(private readonly correlation: AgentPromptRequestCorrelation) {}

  register(request: Request): void {
    const existing = this.entries.get(request.requestId)
    if (existing) {
      if (
        existing.terminal !== request.terminal ||
        existing.ptyId !== request.ptyId ||
        existing.generation !== request.generation ||
        existing.processIncarnation !== request.processIncarnation
      ) {
        throw new Error('prompt_request_id_conflict')
      }
      return
    }
    this.correlation.register(request.ptyId, request)
    const latest = this.latestTurns.get(request.terminal)
    const turnFloor =
      latest?.processIncarnation === request.processIncarnation &&
      latest.generation === request.generation
        ? latest.startedAt
        : (request.baselineExplicitWorkingStartedAt ?? 0)
    this.entries.set(request.requestId, { ...request, turnFloor })
    this.trim()
  }

  cancel(ptyId: string, generation: number, requestId: string): void {
    const entry = this.entries.get(requestId)
    if (entry && entry.ptyId === ptyId && entry.generation === generation && !entry.completion) {
      this.finish(entry, { status: 'error', completedAt: Date.now(), reason: 'submission_failed' })
    }
  }

  observe(terminal: string, binding: Binding, event: EnrichedAgentHookEventPayload): void {
    const startedAt = event.turnStartedAt
    if (
      event.isReplay ||
      event.hookEventName === 'SessionStart' ||
      event.toolAgentId ||
      event.structuredHost ||
      event.providerSessionOnly ||
      startedAt === undefined
    ) {
      return
    }
    const previous = this.latestTurns.get(terminal)
    this.latestTurns.delete(terminal)
    this.latestTurns.set(terminal, {
      ...binding,
      startedAt:
        previous?.processIncarnation === binding.processIncarnation &&
        previous.generation === binding.generation
          ? Math.max(previous.startedAt, startedAt)
          : startedAt
    })
    if (this.latestTurns.size > MAX_ENTRIES) {
      const oldest = this.latestTurns.keys().next().value
      if (oldest !== undefined) {
        this.latestTurns.delete(oldest)
      }
    }
    for (const entry of this.entries.values()) {
      if (
        entry.terminal !== terminal ||
        entry.ptyId !== binding.ptyId ||
        entry.generation !== binding.generation ||
        entry.processIncarnation !== binding.processIncarnation
      ) {
        continue
      }
      if (entry.completion) {
        if (
          entry.turnStartedAt === startedAt &&
          !entry.completion.answerComplete &&
          event.hookEventName === 'Stop' &&
          event.fullAssistantMessage !== undefined
        ) {
          this.finish(entry, entry.completion, event.fullAssistantMessage)
        }
        continue
      }
      if (entry.turnStartedAt === undefined) {
        if (startedAt <= entry.turnFloor || startedAt < (entry.registeredAt ?? 0)) {
          continue
        }
        if (
          !this.correlation.acceptTurnStart(
            entry.ptyId,
            entry.generation,
            entry.requestId,
            entry.baselineWorkingSequence,
            entry.baselineExplicitWorkingStartedAt,
            { kind: 'hook', workingStartedAt: startedAt }
          )
        ) {
          continue
        }
        entry.turnStartedAt = startedAt
      }
      if (entry.turnStartedAt !== startedAt) {
        continue
      }
      const lead = event.payload.mainAgent ?? event.payload
      if (lead.state !== 'done') {
        continue
      }
      const outcome = event.payload.mainAgent?.outcome
      const interrupted =
        event.payload.interrupted ||
        outcome === 'cancellation' ||
        outcome === 'interruption' ||
        outcome === 'superseded'
      if (!interrupted && event.hookEventName !== 'Stop' && event.hookEventName !== 'StopFailure') {
        continue
      }
      const status = interrupted
        ? 'interrupted'
        : event.hookEventName === 'StopFailure' ||
            outcome === 'failure' ||
            outcome === 'unconfirmed'
          ? 'error'
          : 'done'
      const text = event.fullAssistantMessage
      this.finish(
        entry,
        {
          status,
          completedAt: event.payload.turnCompletedAt ?? event.receivedAt,
          reason: outcome ?? (status === 'error' ? 'failure' : 'outcome_unknown')
        },
        text
      )
      break
    }
  }

  clearForPty(ptyId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.ptyId === ptyId && !entry.completion) {
        this.finish(entry, {
          status: 'interrupted',
          completedAt: Date.now(),
          reason: 'incarnation_replaced'
        })
      }
    }
  }

  read(terminal: string, requestId: string, offset = 0, limit = PAGE_CHARS): TerminalPromptResult {
    const entry = this.entries.get(requestId)
    if (!entry || entry.terminal !== terminal) {
      return { state: 'unavailable' }
    }
    if (!entry.completion) {
      return { state: 'pending' }
    }
    const text = entry.text ?? ''
    const start = Math.min(Math.max(0, offset), text.length)
    const end = Math.min(start + Math.max(1, Math.min(limit, PAGE_CHARS)), text.length)
    return {
      state: 'completed',
      completion: { ...entry.completion },
      answer: {
        text: text.slice(start, end),
        offset: start,
        nextOffset: end < text.length ? end : null
      }
    }
  }

  wait(
    terminal: string,
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<TerminalPromptResult> {
    if (signal?.aborted) {
      return Promise.reject(new Error('client_disconnected'))
    }
    const current = this.read(terminal, requestId)
    if (current.state !== 'pending' || timeoutMs === 0) {
      return Promise.resolve(current)
    }
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(requestId) ?? new Set<() => void>()
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        listeners.delete(settle)
        if (listeners.size === 0) {
          this.listeners.delete(requestId)
        }
      }
      const settle = (): void => {
        cleanup()
        resolve(this.read(terminal, requestId))
      }
      const abort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      const timer = setTimeout(settle, timeoutMs)
      listeners.add(settle)
      this.listeners.set(requestId, listeners)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private finish(
    entry: Entry,
    result: Pick<TerminalPromptCompletion, 'status' | 'completedAt' | 'reason'>,
    text?: string
  ): void {
    this.retainedChars -= entry.text?.length ?? 0
    entry.text = text ?? ''
    this.retainedChars += entry.text.length
    entry.completion = {
      requestId: entry.requestId,
      terminal: entry.terminal,
      processIncarnation: entry.processIncarnation,
      generation: entry.generation,
      turnId: `${entry.processIncarnation}:${entry.generation}:${entry.turnStartedAt ?? entry.requestId}`,
      ...result,
      answerLength: entry.text.length,
      answerSha256: createHash('sha256').update(entry.text, 'utf8').digest('hex'),
      answerComplete: text !== undefined
    }
    this.correlation.forget(entry.ptyId, entry.generation, entry.requestId)
    for (const listener of this.listeners.get(entry.requestId) ?? []) {
      listener()
    }
    this.trim()
  }

  private trim(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && this.retainedChars <= MAX_RETAINED_CHARS) {
        break
      }
      if (!entry.completion && this.entries.size <= MAX_ENTRIES) {
        continue
      }
      this.retainedChars -= entry.text?.length ?? 0
      this.entries.delete(id)
      this.correlation.forget(entry.ptyId, entry.generation, id)
      for (const listener of this.listeners.get(id) ?? []) {
        listener()
      }
    }
  }
}
