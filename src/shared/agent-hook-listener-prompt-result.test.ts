import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import { readTerminalFinalAnswer } from './agent-hook-listener/terminal-final-answer'

describe('full terminal prompt answers', () => {
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it.each(['codex', 'claude'] as const)(
    'preserves %s Stop text separately from its bounded preview',
    (source) => {
      const state = createHookListenerState()
      const text = '가나다🙂\n'.repeat(3000)
      normalizeAndAccept(state, source, { hook_event_name: 'UserPromptSubmit', prompt: 'question' })
      const event = normalizeAndAccept(state, source, {
        hook_event_name: 'Stop',
        last_assistant_message: text
      })
      expect(event?.payload.lastAssistantMessage?.length).toBeLessThanOrEqual(8000)
      expect(event?.fullAssistantMessage).toBe(text)
      if (!event) {
        throw new Error('missing Stop')
      }
      expect(
        normalizeAndAccept(state, source, {
          hook_event_name: 'Stop',
          agent_id: 'child',
          last_assistant_message: 'child'
        })?.fullAssistantMessage
      ).toBeUndefined()
    }
  )

  it('reads all final Claude text blocks without promoting a cached tool response', () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-prompt-result-'))
    folders.push(folder)
    const path = join(folder, 'transcript.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 'tool' },
            { type: 'text', text: 'last' }
          ]
        }
      })}\n`
    )
    const state = createHookListenerState()
    state.lastToolByPaneKey.set(PANE_KEY, {
      lastAssistantMessage: 'stdout',
      lastAssistantMessageIsToolOutput: true
    })
    const event = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'Stop',
      transcript_path: path
    })
    expect(event?.fullAssistantMessage).toBe('first\nlast')
    const withoutText = normalizeAndAccept(state, 'claude', { hook_event_name: 'Stop' })
    expect(withoutText?.fullAssistantMessage).toBeUndefined()
  })

  it('reads Codex final rollout text while excluding commentary, tools and previous turns', () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-prompt-result-'))
    folders.push(folder)
    const path = join(folder, 'rollout.jsonl')
    const text = '가나다🙂\n'.repeat(3000)
    const rows = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          channel: 'final',
          content: [{ type: 'output_text', text }]
        }
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }
    ]
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const event = normalizeAndAccept(createHookListenerState(), 'codex', {
      hook_event_name: 'Stop',
      transcript_path: path
    })
    expect(event?.fullAssistantMessage).toBe(text)
    writeFileSync(
      path,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-2' }
      })}\n`
    )
    expect(readTerminalFinalAnswer('codex', { transcript_path: path })).toBeUndefined()
  })
})
