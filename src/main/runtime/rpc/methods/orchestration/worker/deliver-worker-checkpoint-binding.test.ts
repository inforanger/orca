import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentCheckpointModule from '../../../../../agent-checkpoint/agent-checkpoint'
import { agentCheckpointReadiness } from '../../../../../agent-checkpoint/agent-checkpoint-readiness'

const { checkpoint, sendAgentTurn } = vi.hoisted(() => ({
  checkpoint: {
    canonicalPath: 'C:/npmind/rules/CHECKPOINT.md',
    content: 'Canonical synthetic checkpoint text.',
    sha256: 'a'.repeat(64)
  },
  sendAgentTurn: vi.fn(async () => ({ prompt: { status: 'sent' } }))
}))

vi.mock('../../../../orchestration/preamble', () => ({
  buildDispatchPreamble: () => 'worker dispatch preamble'
}))
vi.mock('../../../../orchestration/send-agent-turn', () => ({ sendAgentTurn }))
vi.mock('../../../../launched-agent-write-guard', () => ({
  createWorkerBriefWriteGuard: () => null
}))
vi.mock('../../../../../agent-checkpoint/agent-checkpoint', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCheckpointModule>()
  return {
    ...actual,
    loadAgentCheckpoint: async () => checkpoint
  }
})

const { deliverWorkerDispatchPreamble } = await import('./deliver-worker-dispatch-preamble')

describe('worker CHECKPOINT dispatch binding', () => {
  const paneKey = 'tab-worker:pane-1'
  const launchToken = 'launch-verified-1'
  const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
  const taskSpec = 'Update the worker checkpoint gate.'
  let dispatch: {
    task_id: string
    status: string
    assignee_pane_key: string
    process_incarnation: string
    launch_token_hash: string
  }
  let authority: {
    paneKey: string
    processIncarnation: string
    launchTokenHash: string
  }

  beforeEach(() => {
    agentCheckpointReadiness.clearAll()
    sendAgentTurn.mockClear()
    dispatch = {
      task_id: 'task-1',
      status: 'pending',
      assignee_pane_key: paneKey,
      process_incarnation: 'pty:incarnation-1',
      launch_token_hash: launchTokenHash
    }
    authority = {
      paneKey,
      processIncarnation: dispatch.process_incarnation,
      launchTokenHash
    }
  })

  function args() {
    return {
      runtime: {
        getOrchestrationDispatchAuthority: () => authority,
        getTerminalPaneKey: () => paneKey,
        getNestedWorkerMaxDepth: () => 2,
        getTerminalOrchestrationCliCommand: () => 'orca'
      },
      db: {
        getDispatchContextById: () => dispatch,
        getWorkerDispatch: () => ({ state: 'starting' })
      },
      structuredSession: null,
      terminalHandle: 'term_worker',
      dispatchId: 'dispatch-1',
      dispatchDepth: 0,
      runId: 'run-1',
      taskId: 'task-1',
      taskSpec,
      coordinatorHandle: 'term_coordinator',
      devMode: undefined,
      requestId: 'request-1'
    }
  }

  function deliver() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fake supplies every runtime and database member the terminal dispatch path reads.
    return deliverWorkerDispatchPreamble(args() as never)
  }

  it('binds the delivered task to the host-authorized launch before its session hook arrives', async () => {
    await deliver()

    expect(JSON.stringify(sendAgentTurn.mock.calls)).toContain('Canonical synthetic checkpoint text.')
    expect(JSON.stringify(sendAgentTurn.mock.calls)).toContain(taskSpec)
    const session = { paneKey, launchToken }
    expect(
      agentCheckpointReadiness.beginContext(
        session,
        launchToken,
        'provider supplied no task description',
        checkpoint
      )
    ).toEqual({ taskId: 'task-1', taskSummary: taskSpec })
    expect(agentCheckpointReadiness.checkCurrent(session, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('rejects an obsolete process incarnation, hash, or inactive dispatch before delivery', async () => {
    dispatch = { ...dispatch, process_incarnation: 'pty:old-incarnation' }
    await expect(deliver()).rejects.toMatchObject({
      code: 'checkpoint_dispatch_unverifiable'
    })
    expect(sendAgentTurn).not.toHaveBeenCalled()

    dispatch = { ...dispatch, process_incarnation: authority.processIncarnation }
    dispatch = { ...dispatch, launch_token_hash: 'b'.repeat(64) }
    await expect(deliver()).rejects.toMatchObject({
      code: 'checkpoint_dispatch_unverifiable'
    })
    expect(sendAgentTurn).not.toHaveBeenCalled()

    dispatch = { ...dispatch, launch_token_hash: launchTokenHash, status: 'completed' }
    await expect(deliver()).rejects.toMatchObject({
      code: 'checkpoint_dispatch_inactive'
    })
    expect(sendAgentTurn).not.toHaveBeenCalled()
  })
})
