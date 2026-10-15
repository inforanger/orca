import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_CHECKPOINT_PATH,
  loadAgentCheckpoint,
  renderAgentCheckpointContext,
  validateAgentCheckpointApplication,
  type AgentCheckpointApplication
} from './agent-checkpoint'

const CHECKPOINT_TEXT = [
  '# Mandatory checkpoint',
  'Why #1, #2, #3',
  'Compare approaches A and B',
  'Use the structurally sound approach when feasible'
].join('\n')

function validApplication(checkpointSha256: string): AgentCheckpointApplication {
  return {
    checkpointSha256,
    taskId: 'task-7',
    taskSummary: 'Add checkpoint enforcement to Orca launches',
    lessonsSearch: 'Searched checkpoint and hook lessons; #7 and #144 apply.',
    why: ['Launch omits the document.', 'Adapters differ.', 'No shared gate owns it.'],
    approachA: {
      method: 'Add a reminder to the prompt.',
      workload: 'Small',
      remainingProblem: 'No verified pre-edit boundary.'
    },
    approachB: {
      method: 'Read the canonical document and use the client gate.',
      workload: 'Several adapters',
      solvedProblem: 'Supported mutation tools wait for task analysis.',
      feasible: true,
      infeasibleReason: ''
    },
    userRequestedApproachA: false,
    selectedApproach: 'B',
    selectionReason: 'The shared gate closes the observed lifecycle gap.',
    rootCause: 'The launch and hook responsibilities are disconnected.',
    resolution: 'Use one canonical source and a task-bound application record.',
    verification: 'Test launch, resume, dispatch, stale source, and tool denial.',
    reuseCheck: 'Extend the existing managed hook and launch transports.',
    architectureCheck: 'Keep the source path and shared gate as the single source.',
    errorPatternReview: 'Search existing launch and adapter paths for the same gap.',
    shortcutReview: 'No fixed delay, default-value bypass, or swallowed error.'
  }
}

describe('loadAgentCheckpoint', () => {
  it('reads the configured absolute source independent of the agent cwd', async () => {
    const paths: string[] = []
    const checkpoint = await loadAgentCheckpoint({
      canonicalPath: 'C:/policy/CHECKPOINT.md',
      readFile: async (path) => {
        paths.push(path)
        return CHECKPOINT_TEXT
      }
    })

    expect(paths).toEqual(['C:/policy/CHECKPOINT.md'])
    expect(checkpoint.content).toBe(CHECKPOINT_TEXT)
    expect(checkpoint.sha256).toBe(createHash('sha256').update(CHECKPOINT_TEXT).digest('hex'))
  })

  it('has the approved absolute canonical default', () => {
    expect(DEFAULT_AGENT_CHECKPOINT_PATH).toBe(
      'C:/npmind.com Dropbox/Cheon Yongjun/Dev/npmind/rules/CHECKPOINT.md'
    )
  })

  it('reports a missing source with its exact path', async () => {
    await expect(
      loadAgentCheckpoint({
        canonicalPath: 'C:/policy/CHECKPOINT.md',
        readFile: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
      })
    ).rejects.toMatchObject({
      code: 'source_missing',
      canonicalPath: 'C:/policy/CHECKPOINT.md'
    })
  })

  it('does not treat an empty or unreadable source as a valid document', async () => {
    await expect(
      loadAgentCheckpoint({ canonicalPath: 'C:/policy/CHECKPOINT.md', readFile: async () => '' })
    ).rejects.toMatchObject({ code: 'source_empty' })
    await expect(
      loadAgentCheckpoint({
        canonicalPath: 'C:/policy/CHECKPOINT.md',
        readFile: async () => {
          throw new Error('access denied')
        }
      })
    ).rejects.toMatchObject({ code: 'source_unreadable' })
  })
})

describe('renderAgentCheckpointContext', () => {
  it('passes the canonical text unchanged with path and digest on every context build', () => {
    const checkpoint = {
      canonicalPath: 'C:/policy/CHECKPOINT.md',
      content: CHECKPOINT_TEXT,
      sha256: 'a'.repeat(64)
    }

    const context = renderAgentCheckpointContext(checkpoint, {
      taskId: 'task-7',
      taskSummary: 'Add checkpoint enforcement'
    })

    expect(context).toContain(checkpoint.canonicalPath)
    expect(context).toContain(checkpoint.sha256)
    expect(context).toContain(CHECKPOINT_TEXT)
    expect(context).toContain('task-7')
    expect(context).toContain('Add checkpoint enforcement')
  })
})

describe('validateAgentCheckpointApplication', () => {
  const checkpoint = {
    canonicalPath: 'C:/policy/CHECKPOINT.md',
    content: CHECKPOINT_TEXT,
    sha256: 'b'.repeat(64)
  }

  it('rejects a generic read claim instead of accepting it as task analysis', () => {
    expect(
      validateAgentCheckpointApplication('I read CHECKPOINT.md and will comply.', {
        checkpoint,
        taskId: 'task-7',
        taskSummary: 'Add checkpoint enforcement to Orca launches'
      })
    ).toMatchObject({ accepted: false, code: 'analysis_required' })
  })

  it('accepts complete analysis only when it matches the current task and document hash', () => {
    expect(
      validateAgentCheckpointApplication(validApplication(checkpoint.sha256), {
        checkpoint,
        taskId: 'task-7',
        taskSummary: 'Add checkpoint enforcement to Orca launches'
      })
    ).toEqual({ accepted: true })
  })

  it('rejects records for another task or a changed canonical document', () => {
    expect(
      validateAgentCheckpointApplication(validApplication('c'.repeat(64)), {
        checkpoint,
        taskId: 'task-7',
        taskSummary: 'Add checkpoint enforcement to Orca launches'
      })
    ).toMatchObject({ accepted: false, code: 'source_changed' })
    expect(
      validateAgentCheckpointApplication(validApplication(checkpoint.sha256), {
        checkpoint,
        taskId: 'task-8',
        taskSummary: 'Add checkpoint enforcement to Orca launches'
      })
    ).toMatchObject({ accepted: false, code: 'task_mismatch' })
  })

  it('requires the structural approach unless the user explicitly requested A', () => {
    const incomplete = { ...validApplication(checkpoint.sha256), why: ['Only one why'] }
    expect(
      validateAgentCheckpointApplication(incomplete, {
        checkpoint,
        taskId: 'task-7',
        taskSummary: 'Add checkpoint enforcement to Orca launches'
      })
    ).toMatchObject({ accepted: false, code: 'analysis_incomplete' })

    const avoidsStructural = {
      ...validApplication(checkpoint.sha256),
      selectedApproach: 'A',
      approachB: {
        ...validApplication(checkpoint.sha256).approachB,
        feasible: true
      },
      userRequestedApproachA: false
    }
    expect(
      validateAgentCheckpointApplication(avoidsStructural, {
        checkpoint,
        taskId: 'task-7',
        taskSummary: 'Add checkpoint enforcement to Orca launches'
      })
    ).toMatchObject({ accepted: false, code: 'structural_approach_required' })

    expect(
      validateAgentCheckpointApplication(
        { ...avoidsStructural, userRequestedApproachA: true },
        {
          checkpoint,
          taskId: 'task-7',
          taskSummary: 'Add checkpoint enforcement to Orca launches'
        }
      )
    ).toEqual({ accepted: true })
  })

  it('rejects an application from a different task summary in the same session', () => {
    expect(
      validateAgentCheckpointApplication(
        { ...validApplication(checkpoint.sha256), taskSummary: 'A later unrelated task' },
        {
          checkpoint,
          taskId: 'task-7',
          taskSummary: 'Add checkpoint enforcement to Orca launches'
        }
      )
    ).toMatchObject({ accepted: false, code: 'task_mismatch' })
  })
})
