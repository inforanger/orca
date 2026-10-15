import { describe, expect, it } from 'vitest'
import {
  decideAgentCheckpointTool,
  getAgentCheckpointToolMatcher,
  isAgentCheckpointGatedTool
} from './agent-checkpoint-tool-policy'

const pending = { ready: false as const, code: 'analysis_required' as const }
const ready = { ready: true as const }

describe('decideAgentCheckpointTool', () => {
  it.each([
    ['claude', 'Write'],
    ['claude', 'Edit'],
    ['codex', 'apply_patch'],
    ['antigravity', 'write_to_file'],
    ['antigravity', 'replace_file_content'],
    ['antigravity', 'multi_replace_file_content']
  ] as const)('denies a known direct mutation tool while the task is pending (%s/%s)', (source, toolName) => {
    expect(decideAgentCheckpointTool({ source, toolName, readiness: pending })).toMatchObject({
      decision: 'deny',
      code: 'analysis_required'
    })
  })

  it('allows a classified mutation only after the same session is ready', () => {
    expect(
      decideAgentCheckpointTool({ source: 'claude', toolName: 'Write', readiness: ready })
    ).toEqual({ decision: 'allow' })
  })

  it.each([
    ['claude', 'Bash'],
    ['codex', 'shell_command'],
    ['antigravity', 'run_command'],
    ['claude', 'mcp__files__write_file']
  ] as const)('marks unclassified execution paths unsupported (%s/%s)', (source, toolName) => {
    expect(decideAgentCheckpointTool({ source, toolName, readiness: pending })).toMatchObject({
      decision: 'unsupported'
    })
  })

  it('holds agent delegation until checkpoint application', () => {
    expect(
      decideAgentCheckpointTool({ source: 'claude', toolName: 'Task', readiness: pending })
    ).toMatchObject({ decision: 'deny', code: 'analysis_required' })
  })

  it('derives provider matchers from the same classifier without matching reads or shell tools', () => {
    for (const source of ['claude', 'codex', 'antigravity'] as const) {
      const matcher = getAgentCheckpointToolMatcher(source)
      expect(matcher).not.toBeNull()
      const pattern = new RegExp(matcher!)
      for (const toolName of [
        'Write',
        'Edit',
        'MultiEdit',
        'NotebookEdit',
        'apply_patch',
        'spawn_agent',
        'write_to_file',
        'replace_file_content',
        'multi_replace_file_content',
        'Task',
        'invoke_subagent'
      ]) {
        expect(pattern.test(toolName)).toBe(isAgentCheckpointGatedTool(source, toolName))
      }
      expect(pattern.test('Read')).toBe(false)
      expect(pattern.test('Bash')).toBe(false)
      expect(pattern.test('run_command')).toBe(false)
    }
  })
})
