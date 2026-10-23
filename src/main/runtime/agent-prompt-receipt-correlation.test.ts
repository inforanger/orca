import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-correlation',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-correlation',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

describe('agent prompt receipt correlation', () => {
  afterEach(() => vi.useRealTimers())

  it('retains an answer completed inside the submit write before observation starts', async () => {
    vi.useFakeTimers()
    const text = '가나다🙂\n'.repeat(3000)
    let paneKey = ''
    const { runtime, handle } = await createAgentPromptSubmissionRuntime((active, data) => {
      if (!data.endsWith('\r')) {
        return
      }
      const turnStartedAt = Date.now() + 1
      active.observeTerminalPromptStatus({
        paneKey,
        connectionId: null,
        receivedAt: turnStartedAt,
        stateStartedAt: turnStartedAt,
        turnStartedAt,
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'question' }
      })
      active.observeTerminalPromptStatus({
        paneKey,
        connectionId: null,
        receivedAt: turnStartedAt + 1,
        stateStartedAt: turnStartedAt + 1,
        turnStartedAt,
        hookEventName: 'Stop',
        fullAssistantMessage: text,
        payload: { state: 'done', prompt: 'question' }
      })
    }, 'codex')
    paneKey = runtime.getTerminalPaneKey(handle) ?? ''
    expect(paneKey).not.toBe('')
    const sending = runtime.sendTerminalAgentPrompt(handle, 'question', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'fast-answer',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const sent = await sending
    const completed = await runtime.waitForTerminalPrompt(handle, sent.prompt!.requestId, 0)
    expect(completed.completion).toMatchObject({
      requestId: 'fast-answer',
      answerLength: text.length,
      answerComplete: true
    })
    expect(completed.answer?.text).toBe(text.slice(0, 16384))
    expect(runtime.getTerminalPromptResult(handle, 'fast-answer', 16384).answer?.text).toBe(
      text.slice(16384)
    )
  })

  it('assigns historical lifecycle edges to queued receipts in FIFO order', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'codex'
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())

    const firstPromise = runtime.sendTerminalAgentPrompt(handle, 'first prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'historical-first',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const first = await firstPromise
    const secondPromise = runtime.sendTerminalAgentPrompt(handle, 'second prompt', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'historical-second',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()
    const second = await secondPromise

    runtime.onPtyData(
      'pty-prompt',
      '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07' +
        '\x1b]0;Codex idle\x07\x1b]0;Codex working\x07',
      Date.now()
    )

    const writesAfterSubmission = writes.length
    await expect(
      runtime.observeTerminalAgentPrompt(handle, second.prompt!, 0)
    ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
    await expect(
      runtime.observeTerminalAgentPrompt(handle, first.prompt!, 0)
    ).resolves.toMatchObject({ stages: ['input_accepted', 'turn_started'] })
    // Observing a queued receipt must never write to the PTY again.
    expect(writes).toHaveLength(writesAfterSubmission)
  })
})
