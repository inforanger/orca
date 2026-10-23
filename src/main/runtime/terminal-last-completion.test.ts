import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'
import { TerminalPromptCompletions } from './terminal-prompt-completions'

const binding = { ptyId: 'pty', generation: 1, processIncarnation: 'process' }
const stop = {
  paneKey: 'pane',
  connectionId: null,
  turnStartedAt: 100,
  receivedAt: 200,
  stateStartedAt: 200,
  hookEventName: 'Stop',
  fullAssistantMessage: 'answer',
  payload: { state: 'done' as const, prompt: '' }
}

function store() {
  return new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
}

describe('terminal latest completion', () => {
  it('retains an unregistered turn without inventing a request or user identity', () => {
    const completions = store()
    completions.observe('term', binding, stop)
    expect(completions.readLast('term', binding)).toMatchObject({
      state: 'completed',
      currentTurn: { state: 'idle', turnId: 'process:1:100' },
      completion: { origin: 'unknown', terminal: 'term', status: 'done', answerComplete: true },
      answer: { text: 'answer' }
    })
    expect(completions.readLast('term', binding).completion).not.toHaveProperty('requestId')
    expect(completions.readLast('another', binding).state).toBe('unavailable')
  })

  it('pages the complete unicode text and fences pages when the latest turn changes', () => {
    const completions = store()
    const text = '가🙂\n'.repeat(3000)
    completions.observe('term', binding, { ...stop, fullAssistantMessage: text })
    const first = completions.readLast('term', binding, 0, 1001)
    expect(first.completion).toMatchObject({
      answerLength: text.length,
      answerSha256: createHash('sha256').update(text).digest('hex')
    })
    let joined = first.answer?.text ?? ''
    let offset = first.answer?.nextOffset
    while (offset != null) {
      const page = completions.readLast('term', binding, offset, 1001, first.completion?.turnId)
      joined += page.answer?.text
      offset = page.answer?.nextOffset
    }
    expect(joined).toBe(text)
    completions.observe('term', binding, { ...stop, turnStartedAt: 300 })
    expect(completions.readLast('term', binding, 1001, 1001, first.completion?.turnId).state).toBe(
      'unavailable'
    )
  })

  it('distinguishes a running turn from the previous completed answer and ignores old stops', () => {
    const completions = store()
    completions.observe('term', binding, stop)
    completions.observe('term', binding, {
      ...stop,
      turnStartedAt: 300,
      hookEventName: 'UserPromptSubmit',
      payload: { state: 'working', prompt: '' }
    })
    completions.observe('term', binding, stop)
    expect(completions.readLast('term', binding)).toMatchObject({
      currentTurn: { state: 'running', turnId: 'process:1:300' },
      completion: { turnId: 'process:1:100' }
    })
    completions.observe('term', binding, { ...stop, turnStartedAt: 300 })
    expect(completions.readLast('term', binding).currentTurn.state).toBe('idle')
  })

  it('only assigns bridge origin to the exactly correlated request', () => {
    const completions = store()
    completions.observe('term', binding, stop)
    completions.register({
      ...binding,
      terminal: 'term',
      requestId: 'request',
      baselineWorkingSequence: 0,
      baselineExplicitWorkingStartedAt: null
    })
    completions.observe('term', binding, stop)
    expect(completions.readLast('term', binding).completion?.origin).toBe('unknown')
    completions.observe('term', binding, { ...stop, turnStartedAt: 300 })
    expect(completions.readLast('term', binding).completion).toMatchObject({
      origin: 'bridge_request',
      requestId: 'request',
      turnId: 'process:1:300'
    })
    expect(completions.read('term', 'request').answer?.text).toBe('answer')
    completions.observe('term', binding, { ...stop, turnStartedAt: 400 })
    expect(completions.readLast('term', binding).completion?.origin).toBe('unknown')
  })

  it('fences incarnation changes and clears the latest record on PTY retirement', () => {
    const completions = store()
    completions.observe('term', binding, stop)
    expect(completions.readLast('term', { ...binding, generation: 2 }).state).toBe('unavailable')
    expect(completions.readLast('term', { ...binding, processIncarnation: 'new' }).state).toBe(
      'unavailable'
    )
    completions.clearForPty(binding.ptyId)
    expect(completions.readLast('term', binding).state).toBe('unavailable')
  })

  it('excludes replay, child, structured and session-only observations', () => {
    const completions = store()
    for (const ignored of [
      { isReplay: true },
      { toolAgentId: 'child' },
      { structuredHost: 'owned' as const },
      { providerSessionOnly: true },
      { hookEventName: 'SessionStart' }
    ]) {
      completions.observe('term', binding, { ...stop, ...ignored })
    }
    expect(completions.readLast('term', binding).state).toBe('unavailable')
  })

  it('never promotes tool output and upgrades missing evidence from a same-turn retry', () => {
    const completions = store()
    completions.observe('term', binding, {
      ...stop,
      payload: { ...stop.payload, lastAssistantMessageIsToolOutput: true }
    })
    expect(completions.readLast('term', binding)).toMatchObject({
      completion: { answerComplete: false, answerLength: 0 },
      answer: { text: '' }
    })
    completions.observe('term', binding, { ...stop, receivedAt: 500 })
    expect(completions.readLast('term', binding).completion).toMatchObject({
      completedAt: 200,
      answerComplete: true
    })
  })

  it('does not retain an answer exceeding the shared memory limit', () => {
    const completions = store()
    completions.observe('term', binding, {
      ...stop,
      fullAssistantMessage: 'x'.repeat(17 * 1024 * 1024)
    })
    expect(completions.readLast('term', binding).state).toBe('unavailable')
  })

  it('retains error and interrupted outcomes without inventing a complete answer', () => {
    const completions = store()
    completions.observe('term', binding, {
      ...stop,
      hookEventName: 'StopFailure',
      fullAssistantMessage: undefined
    })
    expect(completions.readLast('term', binding).completion).toMatchObject({
      status: 'error',
      answerComplete: false
    })
    completions.observe('term', binding, {
      ...stop,
      turnStartedAt: 300,
      hookEventName: 'Notification',
      fullAssistantMessage: undefined,
      payload: { ...stop.payload, interrupted: true }
    })
    expect(completions.readLast('term', binding).completion).toMatchObject({
      status: 'interrupted',
      answerComplete: false
    })
  })

  it('bounds terminal records and preserves a registered result after later direct turns', () => {
    const completions = store()
    completions.register({
      ...binding,
      terminal: 'term',
      requestId: 'request',
      baselineWorkingSequence: 0,
      baselineExplicitWorkingStartedAt: null
    })
    completions.observe('term', binding, stop)
    completions.observe('term', binding, {
      ...stop,
      turnStartedAt: 300,
      fullAssistantMessage: 'next'
    })
    expect(completions.read('term', 'request').answer?.text).toBe('answer')
    expect(completions.readLast('term', binding).answer?.text).toBe('next')
    for (let i = 0; i < 1025; i++) {
      completions.observe(`terminal-${i}`, binding, stop)
    }
    expect(completions.readLast('terminal-0', binding).state).toBe('unavailable')
    expect(completions.readLast('terminal-1024', binding).state).toBe('completed')
  })
})
