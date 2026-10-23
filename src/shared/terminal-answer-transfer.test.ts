import { describe, expect, it } from 'vitest'
import {
  RelayTerminalAnswerDelivery,
  TerminalAnswerCache,
  TERMINAL_ANSWER_READ_METHOD
} from './terminal-answer-transfer'

describe('relay full terminal answers', () => {
  it('fetches a shed answer by immutable hash and preserves per-pane turn order', async () => {
    const cache = new TerminalAnswerCache()
    const text = '가나다🙂\n'.repeat(5000)
    const fullAssistantMessageRef = cache.remember(text)
    const received: Record<string, unknown>[] = []
    const delivery = new RelayTerminalAnswerDelivery(
      async (method, params) => {
        expect(method).toBe(TERMINAL_ANSWER_READ_METHOD)
        return cache.read(params)
      },
      () => true
    )
    const done = delivery.deliver(
      { paneKey: 'pane-1', hookEventName: 'Stop', fullAssistantMessageRef },
      (event) => {
        received.push(event)
      }
    )
    const start = delivery.deliver(
      { paneKey: 'pane-1', hookEventName: 'UserPromptSubmit' },
      (event) => {
        received.push(event)
      }
    )
    await Promise.all([done, start])
    expect(received.map((event) => event.hookEventName)).toEqual(['Stop', 'UserPromptSubmit'])
    expect(received[0].fullAssistantMessage).toBe(text)
  })

  it('does not treat a missing, corrupted or superseded transfer as a complete answer', async () => {
    const cache = new TerminalAnswerCache()
    const ref = cache.remember('answer')
    const received: Record<string, unknown>[] = []
    for (const page of [null, { text: 'wrong!' }]) {
      const delivery = new RelayTerminalAnswerDelivery(
        async () => page,
        () => true
      )
      await delivery.deliver({ paneKey: 'pane-1', fullAssistantMessageRef: ref }, (event) => {
        received.push(event)
      })
    }
    expect(received).toHaveLength(2)
    expect(received.every((event) => event.fullAssistantMessage === undefined)).toBe(true)
    const stale = new RelayTerminalAnswerDelivery(
      async (_method, params) => cache.read(params),
      () => false
    )
    await stale.deliver({ paneKey: 'pane-1', fullAssistantMessageRef: ref }, (event) => {
      received.push(event)
    })
    expect(received).toHaveLength(2)
  })

  it('accepts legacy inline events synchronously without requesting a new method', () => {
    const delivery = new RelayTerminalAnswerDelivery(
      async () => {
        throw new Error('unexpected RPC')
      },
      () => true
    )
    const received: Record<string, unknown>[] = []
    delivery.deliver({ paneKey: 'pane-1', fullAssistantMessage: 'legacy' }, (event) => {
      received.push(event)
    })
    expect(received[0].fullAssistantMessage).toBe('legacy')
  })
})
