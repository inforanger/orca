import { createHash } from 'node:crypto'
import {
  validateAgentCheckpointApplication,
  type AgentCheckpoint,
  type AgentCheckpointApplicationResult
} from './agent-checkpoint'

const MAX_AGENT_CHECKPOINT_SESSIONS = 512

export type AgentCheckpointIdentity = {
  paneKey: string
  launchToken?: string
  agentId?: string
  processIncarnation?: string
}

type SessionReadiness = {
  identity: AgentCheckpointIdentity
  taskId: string
  taskSummary: string
  checkpointSha256: string
  applied: boolean
  contextDelivered: boolean
  dispatchId?: string
}

export type AgentCheckpointDispatchBinding = {
  dispatchId: string
  processIncarnation: string
  launchTokenHash: string
  isActive: () => boolean
}

type DispatchReadiness = {
  paneKey: string
  taskId: string
  taskSummary: string
  checkpointSha256: string
  binding: AgentCheckpointDispatchBinding
}

export type AgentCheckpointReadinessResult =
  | { ready: true }
  | {
      ready: false
      code: 'session_unregistered' | 'task_mismatch' | 'source_changed' | 'analysis_required'
    }

export class AgentCheckpointReadiness {
  private readonly sessions = new Map<string, SessionReadiness>()
  private readonly dispatches = new Map<string, DispatchReadiness>()

  ensure(
    identity: AgentCheckpointIdentity,
    taskId: string,
    taskSummary: string,
    checkpoint: AgentCheckpoint
  ): boolean {
    const key = sessionKey(identity)
    if (!key || !taskId.trim() || !taskSummary.trim()) {
      return false
    }
    const current = this.sessions.get(key)
    if (
      current?.taskId === taskId &&
      current.taskSummary === taskSummary &&
      current.checkpointSha256 === checkpoint.sha256 &&
      !hasDifferentVerifiedProcess(current.identity, identity)
    ) {
      current.identity.processIncarnation ??= identity.processIncarnation
      return true
    }
    return this.begin(identity, taskId, taskSummary, checkpoint)
  }

  begin(
    identity: AgentCheckpointIdentity,
    taskId: string,
    taskSummary: string,
    checkpoint: AgentCheckpoint
  ): boolean {
    const key = sessionKey(identity)
    if (!key || !taskId.trim() || !taskSummary.trim()) {
      return false
    }
    for (const [existingKey, current] of this.sessions) {
      if (sameSessionSlot(current.identity, identity)) {
        this.sessions.delete(existingKey)
      }
    }
    this.sessions.set(key, {
      identity: { ...identity },
      taskId,
      taskSummary,
      checkpointSha256: checkpoint.sha256,
      applied: false,
      contextDelivered: false
    })
    this.trim()
    return true
  }

  bindDispatchTask(
    paneKey: string,
    taskId: string,
    taskSummary: string,
    checkpoint: AgentCheckpoint,
    binding: AgentCheckpointDispatchBinding
  ): boolean {
    if (
      !paneKey.trim() ||
      !taskId.trim() ||
      !taskSummary.trim() ||
      !binding.dispatchId.trim() ||
      !binding.processIncarnation.trim() ||
      !/^[a-f0-9]{64}$/.test(binding.launchTokenHash) ||
      !isActive(binding)
    ) {
      return false
    }
    const dispatch: DispatchReadiness = {
      paneKey,
      taskId,
      taskSummary,
      checkpointSha256: checkpoint.sha256,
      binding
    }
    this.dispatches.set(binding.dispatchId, dispatch)
    const matchingSessions = [...this.sessions.values()].filter(
      (session) => this.matchesDispatch(session.identity, dispatch)
    )
    if (matchingSessions.length > 1) {
      this.dispatches.delete(binding.dispatchId)
      return false
    }
    const session = matchingSessions[0]
    if (session) {
      session.taskId = taskId
      session.taskSummary = taskSummary
      session.checkpointSha256 = checkpoint.sha256
      session.dispatchId = binding.dispatchId
      session.applied = false
      session.contextDelivered = false
    }
    this.trim()
    return true
  }

  beginContext(
    identity: AgentCheckpointIdentity,
    fallbackTaskId: string,
    fallbackTaskSummary: string,
    checkpoint: AgentCheckpoint
  ): { taskId: string; taskSummary: string } | null {
    return this.registerContext(identity, fallbackTaskId, fallbackTaskSummary, checkpoint, true)
  }

  ensureContext(
    identity: AgentCheckpointIdentity,
    fallbackTaskId: string,
    fallbackTaskSummary: string,
    checkpoint: AgentCheckpoint
  ): { taskId: string; taskSummary: string } | null {
    return this.registerContext(identity, fallbackTaskId, fallbackTaskSummary, checkpoint, false)
  }

  apply(
    identity: AgentCheckpointIdentity,
    input: unknown,
    checkpoint: AgentCheckpoint
  ): AgentCheckpointApplicationResult {
    const key = sessionKey(identity)
    const session = key ? this.sessions.get(key) : undefined
    if (!session) {
      return { accepted: false, code: 'analysis_required' }
    }
    if (session.checkpointSha256 !== checkpoint.sha256) {
      session.applied = false
      session.checkpointSha256 = checkpoint.sha256
      return { accepted: false, code: 'source_changed' }
    }
    if (!this.isDispatchActive(identity, session)) {
      session.applied = false
      return { accepted: false, code: 'task_mismatch' }
    }
    const result = validateAgentCheckpointApplication(input, {
      checkpoint,
      taskId: session.taskId,
      taskSummary: session.taskSummary
    })
    if (result.accepted) {
      session.applied = true
    }
    return result
  }

  check(
    identity: AgentCheckpointIdentity,
    taskId: string,
    checkpoint: AgentCheckpoint
  ): AgentCheckpointReadinessResult {
    const key = sessionKey(identity)
    const session = key ? this.sessions.get(key) : undefined
    if (!session) {
      return { ready: false, code: 'session_unregistered' }
    }
    if (session.taskId !== taskId) {
      return { ready: false, code: 'task_mismatch' }
    }
    if (!this.isDispatchActive(identity, session)) {
      session.applied = false
      return { ready: false, code: 'session_unregistered' }
    }
    if (session.checkpointSha256 !== checkpoint.sha256) {
      session.applied = false
      session.checkpointSha256 = checkpoint.sha256
      return { ready: false, code: 'source_changed' }
    }
    return session.applied ? { ready: true } : { ready: false, code: 'analysis_required' }
  }

  checkCurrent(
    identity: AgentCheckpointIdentity,
    checkpoint: AgentCheckpoint
  ): AgentCheckpointReadinessResult {
    const key = sessionKey(identity)
    const session = key ? this.sessions.get(key) : undefined
    return session
      ? this.check(identity, session.taskId, checkpoint)
      : { ready: false, code: 'session_unregistered' }
  }

  currentTaskId(identity: AgentCheckpointIdentity): string | undefined {
    const key = sessionKey(identity)
    return key ? this.sessions.get(key)?.taskId : undefined
  }

  clear(identity: AgentCheckpointIdentity): void {
    const key = sessionKey(identity)
    if (key) {
      this.sessions.delete(key)
    }
  }

  claimContextDelivery(identity: AgentCheckpointIdentity): boolean {
    const key = sessionKey(identity)
    const session = key ? this.sessions.get(key) : undefined
    if (!session || session.contextDelivered) {
      return false
    }
    session.contextDelivered = true
    return true
  }

  clearAll(): void {
    this.sessions.clear()
    this.dispatches.clear()
  }

  private registerContext(
    identity: AgentCheckpointIdentity,
    fallbackTaskId: string,
    fallbackTaskSummary: string,
    checkpoint: AgentCheckpoint,
    resetApplied: boolean
  ): { taskId: string; taskSummary: string } | null {
    const key = sessionKey(identity)
    if (!key || !fallbackTaskId.trim() || !fallbackTaskSummary.trim()) {
      return null
    }
    const activeDispatches = [...this.dispatches.values()].filter(
      (dispatch) => this.matchesDispatch(identity, dispatch)
    )
    if (activeDispatches.length > 1) {
      return null
    }
    const dispatch = activeDispatches[0]
    const current = this.sessions.get(key)
    if (dispatch) {
      if (current?.dispatchId === dispatch.binding.dispatchId) {
        const processChanged = hasDifferentVerifiedProcess(current.identity, identity)
        if (
          resetApplied ||
          current.checkpointSha256 !== checkpoint.sha256 ||
          processChanged
        ) {
          current.applied = false
          current.contextDelivered = false
        }
        current.identity.processIncarnation = processChanged
          ? identity.processIncarnation
          : (current.identity.processIncarnation ?? identity.processIncarnation)
        current.checkpointSha256 = checkpoint.sha256
        return { taskId: current.taskId, taskSummary: current.taskSummary }
      }
      this.clearSessionSlot(identity)
      this.sessions.set(key, {
        identity: { ...identity },
        taskId: dispatch.taskId,
        taskSummary: dispatch.taskSummary,
        checkpointSha256: checkpoint.sha256,
        dispatchId: dispatch.binding.dispatchId,
        applied: false,
        contextDelivered: false
      })
      this.trim()
      return { taskId: dispatch.taskId, taskSummary: dispatch.taskSummary }
    }
    const accepted = resetApplied
      ? this.begin(identity, fallbackTaskId, fallbackTaskSummary, checkpoint)
      : this.ensure(identity, fallbackTaskId, fallbackTaskSummary, checkpoint)
    return accepted ? { taskId: fallbackTaskId, taskSummary: fallbackTaskSummary } : null
  }

  private matchesDispatch(
    identity: AgentCheckpointIdentity,
    dispatch: DispatchReadiness
  ): boolean {
    const launchToken = identity.launchToken?.trim()
    return (
      identity.paneKey === dispatch.paneKey &&
      identity.agentId === undefined &&
      !!launchToken &&
      createHash('sha256').update(launchToken).digest('hex') === dispatch.binding.launchTokenHash &&
      isActive(dispatch.binding)
    )
  }

  private isDispatchActive(identity: AgentCheckpointIdentity, session: SessionReadiness): boolean {
    if (!session.dispatchId) {
      return true
    }
    const dispatch = this.dispatches.get(session.dispatchId)
    return dispatch ? this.matchesDispatch(identity, dispatch) : false
  }

  private clearSessionSlot(identity: AgentCheckpointIdentity): void {
    for (const [existingKey, current] of this.sessions) {
      if (sameSessionSlot(current.identity, identity)) {
        this.sessions.delete(existingKey)
      }
    }
  }

  private trim(): void {
    while (this.sessions.size + this.dispatches.size > MAX_AGENT_CHECKPOINT_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value
      if (oldestKey !== undefined) {
        this.sessions.delete(oldestKey)
        continue
      }
      const oldestDispatchId = this.dispatches.keys().next().value
      if (oldestDispatchId === undefined) {
        return
      }
      this.dispatches.delete(oldestDispatchId)
    }
  }
}

export const agentCheckpointReadiness = new AgentCheckpointReadiness()

function sessionKey(identity: AgentCheckpointIdentity): string | null {
  const paneKey = identity.paneKey.trim()
  const launchToken = identity.launchToken?.trim() ?? ''
  const agentId = identity.agentId?.trim() ?? ''
  if (
    !paneKey ||
    (identity.launchToken !== undefined && !launchToken) ||
    (identity.agentId !== undefined && !agentId)
  ) {
    return null
  }
  return JSON.stringify([paneKey, launchToken, agentId])
}

function sameSessionSlot(
  left: AgentCheckpointIdentity,
  right: AgentCheckpointIdentity
): boolean {
  return left.paneKey === right.paneKey && left.agentId === right.agentId
}

function isActive(binding: AgentCheckpointDispatchBinding): boolean {
  try {
    return binding.isActive()
  } catch {
    return false
  }
}

function hasDifferentVerifiedProcess(
  current: AgentCheckpointIdentity,
  incoming: AgentCheckpointIdentity
): boolean {
  return (
    current.processIncarnation !== undefined &&
    incoming.processIncarnation !== undefined &&
    current.processIncarnation !== incoming.processIncarnation
  )
}
