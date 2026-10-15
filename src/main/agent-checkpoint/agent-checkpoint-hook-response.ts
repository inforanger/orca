import {
  AgentCheckpointSourceError,
  loadAgentCheckpoint,
  renderAgentCheckpointContext,
  type AgentCheckpoint
} from './agent-checkpoint'
import {
  agentCheckpointReadiness,
  type AgentCheckpointIdentity,
  type AgentCheckpointReadiness
} from './agent-checkpoint-readiness'
import {
  decideAgentCheckpointTool,
  isAgentCheckpointGatedTool,
  type AgentCheckpointHookSource
} from './agent-checkpoint-tool-policy'
import { resolveAgentCheckpointProcessIncarnation } from './agent-checkpoint-process-identity'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

export type AgentCheckpointHookResponse = {
  statusCode: 200
  body: string
}

export async function createAgentCheckpointHookResponse(args: {
  source: string
  eventName?: string
  body: unknown
  hookRole?: string
  normalizedEvent?: AgentHookEventPayload | null
  loadCheckpoint?: () => Promise<AgentCheckpoint>
  readiness?: AgentCheckpointReadiness
  resolveProcessIncarnation?: (
    source: AgentCheckpointHookSource,
    agentProcess: unknown
  ) => Promise<string | undefined>
}): Promise<AgentCheckpointHookResponse | null> {
  if (!isCheckpointSource(args.source)) {
    return null
  }
  const source = args.source
  const readiness = args.readiness ?? agentCheckpointReadiness
  const records = readHookRecords(args.body)
  const eventName =
    args.eventName ??
    readString(records.payload.hook_event_name) ??
    readString(records.payload.hookEventName) ??
    readString(records.outer.hook_event_name)
  if (!eventName) {
    return null
  }
  const identity = checkpointIdentity(records, args.normalizedEvent)
  const hookRole = args.hookRole ?? readString(records.outer.hookRole) ?? readString(records.payload.hookRole)
  const taskId =
    readString(records.payload.taskId) ??
    readString(records.payload.task_id) ??
    identity.launchToken ??
    identity.paneKey
  const suppliedTaskSummary =
    readString(records.payload.taskSummary) ?? readString(records.payload.task_summary)
  const taskSummary = suppliedTaskSummary ?? (identity.agentId
    ? 'The provider did not include this child task description; use its assigned task prompt.'
    : 'Apply CHECKPOINT.md to the current user task in this Orca session.')
  const agentId = identity.agentId
  const isContextEvent = isCheckpointContextEvent(source, eventName)
  const toolName = isPreToolEvent(eventName) ? readToolName(records) : undefined

  if (isContextEvent) {
    identity.processIncarnation = await (
      args.resolveProcessIncarnation ?? resolveAgentCheckpointProcessIncarnation
    )(source, records.outer.agentProcess ?? records.payload.agentProcess)
  }

  if (hookRole === 'checkpoint' && !isPreToolEvent(eventName)) {
    return null
  }

  if (isContextEvent) {
    try {
      const checkpoint = await (args.loadCheckpoint ?? loadAgentCheckpoint)()
      if (!identity.paneKey) {
        return contextResponse(
          source,
          eventName,
          `ORCA CHECKPOINT DELIVERY ERROR: Orca session identity is missing; this context cannot be tied to a session.\n${renderAgentCheckpointContext(checkpoint)}`
        )
      }
      const task = { taskId, taskSummary, ...(agentId ? { agentId } : {}) }
      const registered = isInvocationEvent(source, eventName)
        ? readiness.ensureContext(identity, taskId, taskSummary, checkpoint)
        : readiness.beginContext(identity, taskId, taskSummary, checkpoint)
      if (!registered) {
        return contextResponse(
          source,
          eventName,
          `ORCA CHECKPOINT DELIVERY ERROR: this session could not be bound to one active host dispatch or session identity.\n${renderAgentCheckpointContext(checkpoint, task)}`
        )
      }
      const processIdentityWarning =
        source === 'antigravity' && !identity.processIncarnation
          ? 'ORCA CHECKPOINT PROCESS IDENTITY UNSUPPORTED: this host could not verify the provider process, so same-terminal resume reset cannot be guaranteed.'
          : undefined
      if (!readiness.claimContextDelivery(identity)) {
        return source === 'antigravity' && eventName === 'PreInvocation'
          ? respond({
              injectSteps: processIdentityWarning
                ? [{ ephemeralMessage: processIdentityWarning }]
                : []
            })
          : null
      }
      const context = renderAgentCheckpointContext(checkpoint, {
        ...registered,
        ...(agentId ? { agentId } : {})
      })
      return contextResponse(
        source,
        eventName,
        processIdentityWarning ? `${context}\n${processIdentityWarning}` : context
      )
    } catch (error) {
      const detail = checkpointSourceError(error)
      return contextResponse(source, eventName, `ORCA CHECKPOINT DELIVERY ERROR: ${detail}`)
    }
  }

  if (!isPreToolEvent(eventName) || hookRole !== 'checkpoint') {
    return null
  }
  if (!toolName) {
    return null
  }

  if (!identity.paneKey) {
    return isAgentCheckpointGatedTool(source, toolName)
      ? toolDenyResponse(
          source,
          eventName,
          'session_unregistered',
          'Orca checkpoint gate cannot identify this session; no checkpoint application is registered.'
        )
      : null
  }

  let checkpoint: AgentCheckpoint
  try {
    checkpoint = await (args.loadCheckpoint ?? loadAgentCheckpoint)()
  } catch (error) {
    const detail = checkpointSourceError(error)
    return isAgentCheckpointGatedTool(source, toolName)
      ? toolDenyResponse(source, eventName, sourceErrorCode(error), detail)
      : null
  }

  const decision = decideAgentCheckpointTool({
    source,
    toolName,
    readiness: readiness.checkCurrent(identity, checkpoint)
  })
  if (decision.decision === 'deny') {
    return toolDenyResponse(source, eventName, decision.code, decision.reason)
  }
  if (decision.decision === 'unsupported') {
    return null
  }
  return source === 'antigravity'
    ? respond({ decision: 'allow' })
    : null
}

function checkpointIdentity(
  records: HookRecords,
  normalizedEvent: AgentHookEventPayload | null | undefined
): AgentCheckpointIdentity {
  const paneKey = normalizedEvent?.paneKey ?? readString(records.outer.paneKey) ?? ''
  const launchToken = normalizedEvent?.launchToken ?? readString(records.outer.launchToken)
  const agentId =
    readString(records.payload.agent_id) ??
    readString(records.payload.agentId) ??
    readString(records.payload.tool_agent_id) ??
    readString(records.outer.agent_id) ??
    normalizedEvent?.toolAgentId
  return {
    paneKey,
    ...(launchToken ? { launchToken } : {}),
    ...(agentId ? { agentId } : {})
  }
}

type HookRecords = {
  outer: Record<string, unknown>
  payload: Record<string, unknown>
}

function readHookRecords(body: unknown): HookRecords {
  const outer = asRecord(body)
  const nested = parsePayload(outer.payload)
  return { outer, payload: nested ?? outer }
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value === undefined ? null : asRecord(value)
}

function readToolName(records: HookRecords): string | undefined {
  const toolCall = asRecord(records.payload.toolCall)
  return (
    readString(records.payload.tool_name) ??
    readString(records.payload.toolName) ??
    readString(toolCall.name) ??
    readString(records.outer.tool_name)
  )
}

function isCheckpointContextEvent(source: AgentCheckpointHookSource, eventName: string): boolean {
  if (source === 'antigravity') {
    return eventName === 'SessionStart' || eventName === 'PreInvocation'
  }
  return (
    eventName === 'SessionStart' ||
    eventName === 'SubagentStart' ||
    (source === 'claude' && eventName === 'PostCompact')
  )
}

function isInvocationEvent(source: AgentCheckpointHookSource, eventName: string): boolean {
  return source === 'antigravity' && eventName === 'PreInvocation'
}

function isPreToolEvent(eventName: string): boolean {
  return eventName === 'PreToolUse'
}

function contextResponse(
  source: AgentCheckpointHookSource,
  eventName: string,
  context: string
): AgentCheckpointHookResponse {
  if (source === 'antigravity') {
    return respond({
      injectSteps: [{ ephemeralMessage: context }]
    })
  }
  return respond({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context }
  })
}

function toolDenyResponse(
  source: AgentCheckpointHookSource,
  eventName: string,
  code: string,
  reason: string
): AgentCheckpointHookResponse {
  if (source === 'antigravity') {
    return respond({ decision: 'deny', reason: `CHECKPOINT ${code}: ${reason}` })
  }
  return respond({
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: 'deny',
      permissionDecisionReason: `CHECKPOINT ${code}: ${reason}`
    }
  })
}

function respond(output: unknown): AgentCheckpointHookResponse {
  return { statusCode: 200, body: JSON.stringify(output) }
}

function checkpointSourceError(error: unknown): string {
  if (error instanceof AgentCheckpointSourceError) {
    return `${error.code}: ${error.canonicalPath}`
  }
  return `source_unreadable: ${error instanceof Error ? error.message : String(error)}`
}

function sourceErrorCode(error: unknown): string {
  return error instanceof AgentCheckpointSourceError ? error.code : 'source_unreadable'
}

function isCheckpointSource(source: string): source is AgentCheckpointHookSource {
  return source === 'claude' || source === 'codex' || source === 'antigravity'
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
