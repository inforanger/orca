import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentCheckpoint } from './agent-checkpoint'
import { AgentCheckpointReadiness } from './agent-checkpoint-readiness'

const checkpoint: AgentCheckpoint = {
  canonicalPath: 'C:/policy/CHECKPOINT.md',
  content: 'Canonical checkpoint',
  sha256: 'a'.repeat(64)
}

const changedCheckpoint = { ...checkpoint, sha256: 'b'.repeat(64) }
const TASK_SUMMARY = 'Implement a shared checkpoint gate'
const dispatchBinding = {
  dispatchId: 'dispatch-2',
  processIncarnation: 'pty:incarnation-2',
  launchTokenHash: createHash('sha256').update('launch-1').digest('hex'),
  isActive: () => true
}

function application(taskId: string, checkpointSha256: string) {
  return {
    checkpointSha256,
    taskId,
    taskSummary: TASK_SUMMARY,
    lessonsSearch: 'Searched lessons about gate enforcement and hook callbacks.',
    why: ['The prompt is not common to every start.', 'Hooks currently observe only.', 'Tasks need a shared gate.'],
    approachA: {
      method: 'Add a reminder to launch text.',
      workload: 'Small',
      remainingProblem: 'No pre-change verification.'
    },
    approachB: {
      method: 'Use the canonical source and per-session hook state.',
      workload: 'Several adapters',
      solvedProblem: 'Supported mutation hooks wait for a task record.',
      feasible: true,
      infeasibleReason: ''
    },
    userRequestedApproachA: false,
    selectedApproach: 'B' as const,
    selectionReason: 'The common state covers launch and the supported hooks.',
    rootCause: 'Launch context and hook decisions are disconnected.',
    resolution: 'Read once per lifecycle and validate task-bound application.',
    verification: 'Test every lifecycle and adapter output.',
    reuseCheck: 'Extend existing launch, hook and CLI paths.',
    architectureCheck: 'Keep one source path and readiness owner.',
    errorPatternReview: 'Search launch, resume and dispatch entry points.',
    shortcutReview: 'No fixed delays or swallowed delivery errors.'
  }
}

describe('AgentCheckpointReadiness', () => {
  it('keeps readiness scoped to an exact session and requires analysis after begin', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'task-1', TASK_SUMMARY, checkpoint)

    expect(readiness.check(identity, 'task-1', checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
    expect(readiness.check({ ...identity, launchToken: 'launch-2' }, 'task-1', checkpoint)).toEqual({
      ready: false,
      code: 'session_unregistered'
    })
  })

  it('accepts a complete current record and clears it when the task changes', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'task-1', TASK_SUMMARY, checkpoint)

    expect(readiness.apply(identity, application('task-1', checkpoint.sha256), checkpoint)).toEqual({
      accepted: true
    })
    expect(readiness.check(identity, 'task-1', checkpoint)).toEqual({ ready: true })

    readiness.begin(identity, 'task-2', 'A second checkpoint task', checkpoint)
    expect(readiness.check(identity, 'task-2', checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
    expect(readiness.apply(identity, application('task-1', checkpoint.sha256), checkpoint)).toEqual({
      accepted: false,
      code: 'task_mismatch'
    })
  })

  it('requires a fresh record after the canonical document changes', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'task-1', TASK_SUMMARY, checkpoint)
    readiness.apply(identity, application('task-1', checkpoint.sha256), checkpoint)

    expect(readiness.check(identity, 'task-1', changedCheckpoint)).toEqual({
      ready: false,
      code: 'source_changed'
    })
    readiness.begin(identity, 'task-1', TASK_SUMMARY, changedCheckpoint)
    expect(readiness.check(identity, 'task-1', changedCheckpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('binds an owned dispatch task to the unique active session and clears prior readiness', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'launch-1', TASK_SUMMARY, checkpoint)
    readiness.apply(identity, application('launch-1', checkpoint.sha256), checkpoint)

    expect(
      readiness.bindDispatchTask(
        identity.paneKey,
        'task-2',
        'A second checkpoint task',
        checkpoint,
        dispatchBinding
      )
    ).toBe(true)
    expect(readiness.currentTaskId(identity)).toBe('task-2')
    expect(readiness.check(identity, 'task-2', checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
    expect(readiness.apply(identity, application('launch-1', checkpoint.sha256), checkpoint)).toEqual({
      accepted: false,
      code: 'task_mismatch'
    })
  })

  it('keeps an accepted application across repeated invocation hooks in the same task', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'task-1', TASK_SUMMARY, checkpoint)
    readiness.apply(identity, application('task-1', checkpoint.sha256), checkpoint)

    expect(readiness.ensure(identity, 'task-1', TASK_SUMMARY, checkpoint)).toBe(true)
    expect(readiness.check(identity, 'task-1', checkpoint)).toEqual({ ready: true })
    expect(readiness.ensure(identity, 'task-2', 'A second checkpoint task', checkpoint)).toBe(true)
    expect(readiness.check(identity, 'task-2', checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('resets readiness when the same pane and launch token resume in a new provider process', () => {
    const readiness = new AgentCheckpointReadiness()
    const initialProcess = {
      paneKey: 'tab-1:pane-1',
      launchToken: 'launch-1',
      processIncarnation: 'win32:agy:100'
    }
    readiness.begin(initialProcess, 'task-1', TASK_SUMMARY, checkpoint)
    readiness.apply(initialProcess, application('task-1', checkpoint.sha256), checkpoint)

    expect(readiness.ensure(initialProcess, 'task-1', TASK_SUMMARY, checkpoint)).toBe(true)
    expect(readiness.check(initialProcess, 'task-1', checkpoint)).toEqual({ ready: true })

    const resumedProcess = { ...initialProcess, processIncarnation: 'win32:agy:200' }
    expect(readiness.ensure(resumedProcess, 'task-1', TASK_SUMMARY, checkpoint)).toBe(true)
    expect(readiness.check(resumedProcess, 'task-1', checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('preserves readiness when a later invocation cannot verify process incarnation', () => {
    const readiness = new AgentCheckpointReadiness()
    const verifiedIdentity = {
      paneKey: 'tab-1:pane-1',
      launchToken: 'launch-1',
      processIncarnation: 'win32:agy:100'
    }
    readiness.begin(verifiedIdentity, 'task-1', TASK_SUMMARY, checkpoint)
    readiness.apply(verifiedIdentity, application('task-1', checkpoint.sha256), checkpoint)

    expect(
      readiness.ensure(
        { paneKey: verifiedIdentity.paneKey, launchToken: verifiedIdentity.launchToken },
        'task-1',
        TASK_SUMMARY,
        checkpoint
      )
    ).toBe(true)
    expect(readiness.check(verifiedIdentity, 'task-1', checkpoint)).toEqual({ ready: true })
  })

  it('resets an active dispatch once when its provider process changes', () => {
    const readiness = new AgentCheckpointReadiness()
    const firstProcess = {
      paneKey: 'tab-1:pane-1',
      launchToken: 'launch-1',
      processIncarnation: 'win32:agy:100'
    }
    readiness.begin(firstProcess, 'launch-1', TASK_SUMMARY, checkpoint)
    expect(
      readiness.bindDispatchTask(
        firstProcess.paneKey,
        'dispatch-2',
        TASK_SUMMARY,
        checkpoint,
        dispatchBinding
      )
    ).toBe(true)
    readiness.apply(firstProcess, application('dispatch-2', checkpoint.sha256), checkpoint)

    const resumedProcess = { ...firstProcess, processIncarnation: 'win32:agy:200' }
    expect(readiness.ensureContext(resumedProcess, 'launch-1', TASK_SUMMARY, checkpoint)).toEqual({
      taskId: 'dispatch-2',
      taskSummary: TASK_SUMMARY
    })
    expect(readiness.checkCurrent(resumedProcess, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
    readiness.apply(resumedProcess, application('dispatch-2', checkpoint.sha256), checkpoint)

    readiness.ensureContext(resumedProcess, 'launch-1', TASK_SUMMARY, checkpoint)
    expect(readiness.checkCurrent(resumedProcess, checkpoint)).toEqual({ ready: true })
  })

  it('rejects generic read claims and mismatched task records', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'task-1', TASK_SUMMARY, checkpoint)

    expect(readiness.apply(identity, 'I read CHECKPOINT.md.', checkpoint)).toEqual({
      accepted: false,
      code: 'analysis_required'
    })
    expect(readiness.apply(identity, application('task-2', checkpoint.sha256), checkpoint)).toEqual({
      accepted: false,
      code: 'task_mismatch'
    })
  })

  it('rejects a previous application after the same task ID receives a new task summary', () => {
    const readiness = new AgentCheckpointReadiness()
    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    readiness.begin(identity, 'task-1', TASK_SUMMARY, checkpoint)
    expect(readiness.apply(identity, application('task-1', checkpoint.sha256), checkpoint)).toEqual({
      accepted: true
    })

    readiness.begin(identity, 'task-1', 'A different task with the same ID', checkpoint)
    expect(readiness.apply(identity, application('task-1', checkpoint.sha256), checkpoint)).toEqual({
      accepted: false,
      code: 'task_mismatch'
    })
    expect(readiness.check(identity, 'task-1', checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('binds a dispatch arriving before SessionStart only to the matching launch token', () => {
    const readiness = new AgentCheckpointReadiness()
    expect(
      readiness.bindDispatchTask(
        'tab-1:pane-1',
        'dispatch-2',
        TASK_SUMMARY,
        checkpoint,
        dispatchBinding
      )
    ).toBe(true)

    const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    expect(readiness.beginContext(identity, 'launch-1', 'provider fallback', checkpoint)).toEqual({
      taskId: 'dispatch-2',
      taskSummary: TASK_SUMMARY
    })
    expect(readiness.apply(identity, application('dispatch-2', checkpoint.sha256), checkpoint)).toEqual({
      accepted: true
    })
    expect(readiness.beginContext(identity, 'launch-1', 'provider fallback', checkpoint)).toEqual({
      taskId: 'dispatch-2',
      taskSummary: TASK_SUMMARY
    })
    expect(readiness.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('does not attach a pending dispatch to another launch or an inactive dispatch', () => {
    const readiness = new AgentCheckpointReadiness()
    let dispatchActive = true
    const binding = { ...dispatchBinding, isActive: () => dispatchActive }
    expect(
      readiness.bindDispatchTask('tab-1:pane-1', 'dispatch-2', TASK_SUMMARY, checkpoint, binding)
    ).toBe(true)

    const differentLaunch = { paneKey: 'tab-1:pane-1', launchToken: 'launch-2' }
    expect(
      readiness.beginContext(differentLaunch, 'launch-2', 'A standalone task', checkpoint)
    ).toEqual({ taskId: 'launch-2', taskSummary: 'A standalone task' })
    expect(
      readiness.apply(
        differentLaunch,
        application('dispatch-2', checkpoint.sha256),
        checkpoint
      )
    ).toEqual({ accepted: false, code: 'task_mismatch' })

    const dispatchedLaunch = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
    expect(
      readiness.beginContext(dispatchedLaunch, 'launch-1', 'provider fallback', checkpoint)
    ).toEqual({ taskId: 'dispatch-2', taskSummary: TASK_SUMMARY })
    dispatchActive = false
    expect(readiness.checkCurrent(dispatchedLaunch, checkpoint)).toEqual({
      ready: false,
      code: 'session_unregistered'
    })
  })
})
