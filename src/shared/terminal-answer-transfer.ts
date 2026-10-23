import { createHash } from 'node:crypto'
import { record } from './codex-rollout-jsonl-cursor'

export const TERMINAL_ANSWER_READ_METHOD = 'agent_hook.readTerminalAnswer'
const MAX_CHARS = 16 * 1024 * 1024
const PAGE_CHARS = 1024

type AnswerReference = { sha256: string; length: number }

export class TerminalAnswerCache {
  private readonly answers = new Map<string, string>()
  private chars = 0

  attach<T extends { fullAssistantMessage?: string }>(
    envelope: T
  ): T & { fullAssistantMessageRef?: AnswerReference } {
    const ref =
      envelope.fullAssistantMessage === undefined
        ? undefined
        : this.remember(envelope.fullAssistantMessage)
    return { ...envelope, ...(ref ? { fullAssistantMessageRef: ref } : {}) }
  }

  remember(text: string): AnswerReference | undefined {
    if (text.length > MAX_CHARS) {
      return undefined
    }
    const sha256 = hash(text)
    if (!this.answers.has(sha256)) {
      this.answers.set(sha256, text)
      this.chars += text.length
    }
    for (const [key, answer] of this.answers) {
      if (this.chars <= MAX_CHARS && this.answers.size <= 1024) {
        break
      }
      this.answers.delete(key)
      this.chars -= answer.length
    }
    return { sha256, length: text.length }
  }

  read(params: Record<string, unknown>): { text: string } | null {
    if (
      typeof params.sha256 !== 'string' ||
      typeof params.offset !== 'number' ||
      !Number.isSafeInteger(params.offset) ||
      params.offset < 0
    ) {
      return null
    }
    const text = this.answers.get(params.sha256)
    return text === undefined
      ? null
      : { text: text.slice(params.offset, params.offset + PAGE_CHARS) }
  }
}

type RequestAnswer = (method: string, params: Record<string, unknown>) => Promise<unknown>

export class RelayTerminalAnswerDelivery {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly request: RequestAnswer,
    private readonly isCurrent: () => boolean
  ) {}

  deliver(
    envelope: Record<string, unknown>,
    ingest: (value: Record<string, unknown>) => void
  ): Promise<void> | void {
    if (typeof envelope.paneKey !== 'string') {
      return
    }
    const paneKey = envelope.paneKey
    const previous = this.pending.get(paneKey)
    if (!previous && !envelope.fullAssistantMessageRef) {
      if (this.isCurrent()) {
        ingest(envelope)
      }
      return
    }
    const run = async (): Promise<void> => {
      const fullAssistantMessage = await this.read(envelope)
      if (this.isCurrent()) {
        ingest({ ...envelope, fullAssistantMessage })
      }
    }
    const next = (previous ?? Promise.resolve()).then(run).catch((error: unknown) => {
      console.warn('[agent-hooks] terminal answer delivery failed', error)
    })
    this.pending.set(paneKey, next)
    void next.then(() => {
      if (this.pending.get(paneKey) === next) {
        this.pending.delete(paneKey)
      }
    })
    return next
  }

  private async read(envelope: Record<string, unknown>): Promise<string | undefined> {
    if (typeof envelope.fullAssistantMessage === 'string') {
      return envelope.fullAssistantMessage
    }
    const ref = record(envelope.fullAssistantMessageRef)
    if (
      !ref ||
      typeof ref.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      typeof ref.length !== 'number' ||
      !Number.isSafeInteger(ref.length) ||
      ref.length < 0 ||
      ref.length > MAX_CHARS
    ) {
      return undefined
    }
    const parts: string[] = []
    const deadline = Date.now() + 30_000
    for (let offset = 0; offset < ref.length; offset += PAGE_CHARS) {
      if (!this.isCurrent() || Date.now() >= deadline) {
        return undefined
      }
      let page: Record<string, unknown> | undefined
      try {
        page = record(
          await this.request(TERMINAL_ANSWER_READ_METHOD, { sha256: ref.sha256, offset })
        )
      } catch {
        return undefined
      }
      if (
        typeof page?.text !== 'string' ||
        page.text.length !== Math.min(PAGE_CHARS, ref.length - offset)
      ) {
        return undefined
      }
      parts.push(page.text)
    }
    const text = parts.join('')
    return hash(text) === ref.sha256 ? text : undefined
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
