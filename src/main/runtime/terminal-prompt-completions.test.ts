import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { TerminalPromptCompletions } from './terminal-prompt-completions'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'

const binding = { ptyId: 'pty-1', generation: 1, processIncarnation: 'process-1' }
const request = {
  ...binding,
  terminal: 'term-1',
  requestId: 'request-1',
  baselineWorkingSequence: 0,
  baselineExplicitWorkingStartedAt: null
}

describe('terminal prompt completions', () => {
  it('rejects a reused request ID from another terminal incarnation', () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    expect(() => completions.register({ ...request, generation: 2 })).toThrow(
      'prompt_request_id_conflict'
    )
    expect(() => completions.register(request)).not.toThrow()
  })

  it('records failure and distinguishes an unknown task outcome from turn termination', () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    completions.observe('term-1', binding, {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 200,
      hookEventName: 'StopFailure',
      payload: { state: 'done', prompt: '' }
    })
    expect(completions.read('term-1', 'request-1').completion).toMatchObject({
      status: 'error',
      reason: 'failure',
      answerComplete: false
    })
  })

  it('fills an initially missing answer from a same-turn hook retry', () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    const stop = {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 200,
      hookEventName: 'Stop',
      payload: { state: 'done' as const, prompt: '' }
    }
    completions.observe('term-1', binding, stop)
    expect(completions.read('term-1', 'request-1').completion).toMatchObject({
      status: 'done',
      reason: 'outcome_unknown',
      answerComplete: false
    })
    completions.observe('term-1', binding, { ...stop, fullAssistantMessage: 'late final answer' })
    expect(completions.read('term-1', 'request-1').completion).toMatchObject({
      answerComplete: true,
      completedAt: 200
    })
    expect(completions.read('term-1', 'request-1').answer?.text).toBe('late final answer')
  })
  it('does not assign a duplicate of the previous completed turn to a newly submitted request', () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    const oldStop = {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 200,
      hookEventName: 'Stop',
      fullAssistantMessage: 'old',
      payload: { state: 'done' as const, prompt: '' }
    }
    completions.observe('term-1', binding, oldStop)
    completions.register(request)
    completions.observe('term-1', binding, oldStop)
    expect(completions.read('term-1', 'request-1').state).toBe('pending')
    completions.observe('term-1', binding, {
      ...oldStop,
      turnStartedAt: 300,
      fullAssistantMessage: 'new'
    })
    expect(completions.read('term-1', 'request-1').answer?.text).toBe('new')
  })
  it('retains a fast completed turn and pages the complete answer for a late reader', async () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    const text = '가나다🙂\n'.repeat(3_000)
    completions.register(request)
    completions.observe('term-1', binding, {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 101,
      stateStartedAt: 100,
      payload: { state: 'working', prompt: '' }
    })
    completions.observe('term-1', binding, {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 200,
      hookEventName: 'Stop',
      fullAssistantMessage: text,
      payload: { state: 'done', prompt: '', lastAssistantMessage: text.slice(0, 8000) }
    })
    const result = await completions.wait('term-1', 'request-1', 0)
    expect(result.state).toBe('completed')
    expect(result.completion).toMatchObject({
      requestId: 'request-1',
      terminal: 'term-1',
      status: 'done',
      completedAt: 200,
      answerLength: text.length,
      answerComplete: true
    })
    let assembled = ''
    let offset = 0
    while (offset < text.length) {
      const page = completions.read('term-1', 'request-1', offset, 1001)
      assembled += page.answer?.text
      offset = page.answer?.nextOffset ?? text.length
    }
    expect(assembled).toBe(text)
    expect(result.completion?.answerSha256).toBe(
      createHash('sha256').update(text, 'utf8').digest('hex')
    )
  })

  it('waits for an event, assigns one turn to one request and ignores stale or child evidence', async () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    completions.register({ ...request, requestId: 'request-2' })
    const waiting = completions.wait('term-1', 'request-1', 1000)
    const done = {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 200,
      hookEventName: 'Stop',
      fullAssistantMessage: 'answer',
      payload: { state: 'done' as const, prompt: '' }
    }
    completions.observe('term-1', { ...binding, generation: 2 }, done)
    completions.observe('term-1', binding, { ...done, isReplay: true })
    completions.observe('term-1', binding, { ...done, toolAgentId: 'child' })
    expect(completions.read('term-1', 'request-1').state).toBe('pending')
    completions.observe('term-1', binding, done)
    expect((await waiting).state).toBe('completed')
    expect(completions.read('term-1', 'request-2').state).toBe('pending')
    expect(completions.read('term-other', 'request-1').state).toBe('unavailable')
  })

  it('keeps timeout and cancellation distinct from completion and never promotes tool output', async () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    expect((await completions.wait('term-1', 'request-1', 0)).state).toBe('pending')
    const controller = new AbortController()
    const waiting = completions.wait('term-1', 'request-1', 1000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('client_disconnected')
    completions.observe('term-1', binding, {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 200,
      hookEventName: 'Interrupt',
      payload: {
        state: 'done',
        prompt: '',
        interrupted: true,
        lastAssistantMessage: 'stdout',
        lastAssistantMessageIsToolOutput: true
      }
    })
    expect(completions.read('term-1', 'request-1').completion).toMatchObject({
      status: 'interrupted',
      answerComplete: false,
      answerLength: 0
    })
  })

  it('records a main-agent completion while children keep the aggregate working and ignores duplicate stops', () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    completions.register({ ...request, requestId: 'request-2' })
    const done = {
      paneKey: 'pane-1',
      connectionId: null,
      turnStartedAt: 100,
      receivedAt: 200,
      stateStartedAt: 100,
      hookEventName: 'Stop',
      fullAssistantMessage: 'root answer',
      payload: {
        state: 'working' as const,
        prompt: '',
        mainAgent: { state: 'done' as const, stateStartedAt: 200 }
      }
    }
    completions.observe('term-1', binding, done)
    completions.observe('term-1', binding, done)
    expect(completions.read('term-1', 'request-1').completion?.status).toBe('done')
    expect(completions.read('term-1', 'request-2').state).toBe('pending')
    completions.clearForPty(binding.ptyId)
    expect(completions.read('term-1', 'request-2').completion?.status).toBe('interrupted')
    expect(completions.read('term-1', 'request-1').answer?.text).toBe('root answer')
  })

  it('bounds retention and wakes a waiter when its request is evicted', async () => {
    const completions = new TerminalPromptCompletions(new AgentPromptRequestCorrelation())
    completions.register(request)
    const waiting = completions.wait('term-1', 'request-1', 1000)
    for (let index = 0; index < 1024; index++) {
      completions.register({ ...request, requestId: `next-${index}` })
    }
    expect((await waiting).state).toBe('unavailable')
  })
})
