import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/orca-session-address'
import { canonicalOrcaSessionId } from '../../../../orchestration/canonical-orca-session-id'
import { orcaSessionIdOrHandle } from '../../../../orchestration/orchestration-party'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import { sendAgentTurn } from '../../../../orchestration/send-agent-turn'
import { createWorkerBriefWriteGuard } from '../../../../launched-agent-write-guard'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import { chatAssigneeSessionId } from '../../../../orchestration/chat-assignee'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { sendChatTask, type ChatTaskDelivery } from '../chat-task-delivery'
import { dispatchTaskSource } from '../../../../orchestration/dispatch-task-source'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../../../../orchestration/structured-session-lineage'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../shared/structured-agent-session-projection'
import type { AgentMessageSource } from '../../../../../../shared/agent-session-message-source'
import type { WorkerTurnStartObservation } from './worker-start-turn-observation'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'
import {
  loadAgentCheckpoint,
  renderAgentCheckpointContext
} from '../../../../../agent-checkpoint/agent-checkpoint'
import {
  agentCheckpointReadiness,
  type AgentCheckpointDispatchBinding
} from '../../../../../agent-checkpoint/agent-checkpoint-readiness'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/**
 * Hands a started worker the dispatch preamble, over whichever transport it has.
 *
 * The preamble differs only in how it names the worker and calls it a chat or a terminal: a worker
 * is taught the same verbs whichever mode it runs in, and only the delivery differs — a PTY write
 * returns a queued/accepted receipt, while a structured turn is acknowledged, still held for an
 * agent that has not started, or throws. Held is a turn start nobody observed yet: the start is left
 * unknown, not torn down. A chat's task is a queued send, held as a card while the chat is busy:
 * handed over, with its start unobserved, as a busy terminal holding typed input is.
 */
export async function deliverWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  runId: string
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode: boolean | undefined
  requestId: string
  /** The agent this worker start launched into `terminalHandle`; absent for a caller's terminal. */
  launchedAgent?: string | null
}): Promise<{
  prompt?: RuntimeTerminalSend['prompt']
  structuredTurnStart?: WorkerTurnStartObservation
}> {
  const { runtime, structuredSession, terminalHandle } = args
  const checkpoint = await loadAgentCheckpoint()
  const paneKey = workerCheckpointPaneKey(args)
  if (!paneKey) {
    throw new OrchestrationError(
      'checkpoint_session_unregistered',
      `Could not resolve the Orca session identity for Dispatch ${args.dispatchId}; CHECKPOINT.md cannot be bound to task ${args.taskId}.`
    )
  }
  const dispatch = args.db.getDispatchContextById(args.dispatchId)
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  if (
    !dispatch ||
    dispatch.task_id !== args.taskId ||
    !isActiveWorkerDispatch(dispatch.status, worker?.state)
  ) {
    throw new OrchestrationError(
      'checkpoint_dispatch_inactive',
      `Dispatch ${args.dispatchId} is not the active host task for CHECKPOINT.md.`
    )
  }
  const chatSessionId = chatAssigneeSessionId(terminalHandle)
  const promptOnlyCheckpoint = structuredSession !== null || chatSessionId !== null
  if (structuredSession) {
    if (
      !isOrcaSessionId(structuredSession.identity.sessionId) ||
      dispatch.assignee_orca_session_id !==
        canonicalOrcaSessionId(structuredSession.identity.sessionId) ||
      dispatch.process_incarnation !== structuredSession.identity.processIncarnation ||
      dispatch.assignee_pane_key !== paneKey
    ) {
      throw new OrchestrationError(
        'checkpoint_dispatch_unverifiable',
        `Dispatch ${args.dispatchId} does not match the active structured session identity.`
      )
    }
  } else if (chatSessionId) {
    if (dispatch.assignee_orca_session_id !== canonicalOrcaSessionId(chatSessionId)) {
      throw new OrchestrationError(
        'checkpoint_dispatch_unverifiable',
        `Dispatch ${args.dispatchId} does not match the active chat session identity.`
      )
    }
  } else {
    const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
    if (
      !authority?.processIncarnation ||
      !authority.launchTokenHash ||
      authority.paneKey !== paneKey ||
      dispatch.assignee_pane_key !== paneKey ||
      dispatch.process_incarnation !== authority.processIncarnation ||
      dispatch.launch_token_hash !== authority.launchTokenHash
    ) {
      throw new OrchestrationError(
        'checkpoint_dispatch_unverifiable',
        `Dispatch ${args.dispatchId} does not match the active pane, process incarnation, and launch token authority.`
      )
    }
    const binding: AgentCheckpointDispatchBinding = {
      dispatchId: args.dispatchId,
      processIncarnation: authority.processIncarnation,
      launchTokenHash: authority.launchTokenHash,
      isActive: () => {
        const currentAuthority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
        const currentDispatch = args.db.getDispatchContextById(args.dispatchId)
        const currentWorker = args.db.getWorkerDispatch(args.dispatchId)
        return Boolean(
          currentAuthority?.paneKey === paneKey &&
            currentAuthority.processIncarnation === authority.processIncarnation &&
            currentAuthority.launchTokenHash === authority.launchTokenHash &&
            currentDispatch?.task_id === args.taskId &&
            currentDispatch.assignee_pane_key === paneKey &&
            currentDispatch.process_incarnation === authority.processIncarnation &&
            currentDispatch.launch_token_hash === authority.launchTokenHash &&
            isActiveWorkerDispatch(currentDispatch.status, currentWorker?.state)
        )
      }
    }
    if (
      !agentCheckpointReadiness.bindDispatchTask(
        paneKey,
        args.taskId,
        args.taskSpec,
        checkpoint,
        binding
      )
    ) {
      throw new OrchestrationError(
        'checkpoint_dispatch_unverifiable',
        `Dispatch ${args.dispatchId} could not be bound to one active agent launch.`
      )
    }
  }
  const checkpointTaskContext = renderAgentCheckpointContext(checkpoint, {
    taskId: args.taskId,
    taskSummary: args.taskSpec
  })
  const preamble = `${checkpointTaskContext}${
    promptOnlyCheckpoint
      ? '\nCHECKPOINT enforcement is unsupported for this structured/chat transport: the canonical source is in this preamble, but this path does not block mutation tools.'
      : ''
  }\n\n${buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: orcaSessionIdOrHandle(args.coordinatorHandle, args.db),
    // Its mailbox stays keyed by the handle; its commands name its Orca session ID, which binds to it.
    workerHandle:
      structuredSession && isOrcaSessionId(structuredSession.identity.sessionId)
        ? formatOrcaSessionAddress(canonicalOrcaSessionId(structuredSession.identity.sessionId))
        : terminalHandle,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })}`
  if (chatAssigneeSessionId(terminalHandle)) {
    const dispatch = args.db.getDispatchContextById(args.dispatchId)
    if (!dispatch) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${args.dispatchId} was not found.`
      )
    }
    const from = workerTaskSource(args)
    const delivery = await sendChatTask({ db: args.db, dispatch, from, preamble })
    return { structuredTurnStart: chatTaskTurnStart(delivery) }
  }
  if (structuredSession) {
    const delivery = await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble,
      from: workerTaskSource(args)
    })
    return {
      structuredTurnStart:
        delivery === 'accepted'
          ? { verdict: 'observed' }
          : {
              verdict: 'unobserved',
              reason:
                'The dispatch preamble was accepted, but the agent had not started to take it. It ' +
                'is delivered when the agent starts; if the worker then reports, this Dispatch ' +
                'settles normally.'
            }
    }
  }
  // A shell back at its prompt also reads as ready, so the brief needs the agent found in front.
  const briefGuard = createWorkerBriefWriteGuard(runtime, args.launchedAgent, !!args.launchedAgent)
  try {
    const sent = await sendAgentTurn({
      kind: 'terminal',
      runtime,
      handle: terminalHandle,
      ...(briefGuard ? { beforeWrite: briefGuard.beforeWrite } : {}),
      turn: { purpose: 'dispatch-preamble', body: preamble, operationId: args.requestId }
    })
    return { prompt: sent.prompt }
  } finally {
    briefGuard?.dispose()
  }
}

function workerCheckpointPaneKey(args: {
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession
  terminalHandle: string
}): string | null {
  if (args.structuredSession) {
    return args.structuredSession.identity.paneKey
  }
  const chatSessionId = chatAssigneeSessionId(args.terminalHandle)
  if (chatSessionId) {
    const store = readAgentSessionRecordStore()
    const current = store ? lineageLiveSession(store, chatSessionId) : null
    return current
      ? structuredAgentSessionPaneKey(
          structuredAgentSessionTabId(current.sessionId),
          current.sessionId
        )
      : null
  }
  return args.runtime.getTerminalPaneKey(args.terminalHandle)
}

function isActiveWorkerDispatch(
  dispatchStatus: string,
  workerState: string | undefined
): boolean {
  return (
    (dispatchStatus === 'pending' &&
      (workerState === 'starting' || workerState === 'start_unknown')) ||
    (dispatchStatus === 'dispatched' &&
      (workerState === 'ready' || workerState === 'start_unknown'))
  )
}

function chatTaskTurnStart(delivery: ChatTaskDelivery): WorkerTurnStartObservation {
  switch (delivery) {
    case 'accepted':
      return { verdict: 'observed' }
    case 'pending':
      return {
        verdict: 'unobserved',
        reason:
          "The task was accepted, but the chat's agent had not started to take it. If the worker " +
          'then reports, this Dispatch settles normally.'
      }
    case 'queued':
      return {
        verdict: 'unobserved',
        reason:
          "The task is waiting as a card in the chat's queue and is sent when the queue reaches " +
          'it. If the worker then reports, this Dispatch settles normally. worker-abandon ' +
          'settles the Dispatch but does not remove the card from the chat.'
      }
  }
}

/** Who the task is from, for a worker whose chat shows the sender. */
function workerTaskSource(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  runId: string
  taskId: string
  coordinatorHandle: string
}): AgentMessageSource {
  return dispatchTaskSource({
    db: args.db,
    dispatch: { id: args.dispatchId, run_id: args.runId, task_id: args.taskId },
    from: args.coordinatorHandle,
    senderName: (party, reported) => args.runtime.orchestrationSenderNames.nameOf(party, reported)
  })
}
