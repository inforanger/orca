import { describe, expect, it } from 'vitest'
import {
  AgentCheckpointSourceError,
  type AgentCheckpoint
} from './agent-checkpoint'
import { AgentCheckpointReadiness } from './agent-checkpoint-readiness'
import { createAgentCheckpointHookResponse } from './agent-checkpoint-hook-response'

const checkpoint: AgentCheckpoint = {
  canonicalPath: 'C:/canonical/rules/CHECKPOINT.md',
  content: 'Preserve this exact canonical text.\nApply it to the current task.',
  sha256: 'a'.repeat(64)
}

const identity = { paneKey: 'tab-1:pane-1', launchToken: 'launch-1' }
const SESSION_TASK_SUMMARY = 'Apply CHECKPOINT.md to the current user task in this Orca session.'
const readiness = () => new AgentCheckpointReadiness()
const loadCheckpoint = async () => checkpoint

function application(taskId: string) {
  return {
    checkpointSha256: checkpoint.sha256,
    taskId,
    taskSummary: SESSION_TASK_SUMMARY,
    lessonsSearch: 'Reviewed prior hook enforcement lessons and existing adapter behavior.',
    why: ['Launch context can be omitted.', 'Hooks are currently observational.', 'Each task needs a current application.'],
    approachA: {
      method: 'Add the document to one launch prompt.',
      workload: 'Small',
      remainingProblem: 'Resume and child starts remain uncovered.'
    },
    approachB: {
      method: 'Use shared lifecycle context and exact supported tool hooks.',
      workload: 'Three adapters and their response paths.',
      solvedProblem: 'Lifecycle context and supported writes share current source state.',
      feasible: true,
      infeasibleReason: ''
    },
    userRequestedApproachA: false,
    selectedApproach: 'B' as const,
    selectionReason: 'This uses existing authenticated hook transport and provider-specific decisions.',
    rootCause: 'Hook scripts discarded responses and the listener returned only status receipts.',
    resolution: 'Return canonical context and deny recognized writes until a current application exists.',
    verification: 'Synthetic provider lifecycle tests verify output and readiness changes.',
    reuseCheck: 'The existing agent hook server and CLI transport are reused.',
    architectureCheck: 'One canonical source and one bounded session readiness store are used.',
    errorPatternReview: 'Missing and changed source paths produce explicit errors.',
    shortcutReview: 'No shell-command string whitelist is used as a security boundary.'
  }
}

describe('createAgentCheckpointHookResponse', () => {
  it('injects the full canonical source at Claude startup and resets readiness on resume', async () => {
    const state = readiness()
    const response = await createAgentCheckpointHookResponse({
      source: 'claude',
      eventName: 'SessionStart',
      body: { paneKey: identity.paneKey, launchToken: identity.launchToken },
      readiness: state,
      loadCheckpoint
    })

    expect(contextText(response?.body)).toContain(checkpoint.content)
    expect(contextText(response?.body)).toContain(checkpoint.sha256)
    expect(state.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
    state.apply(identity, application('launch-1'), checkpoint)
    await createAgentCheckpointHookResponse({
      source: 'claude',
      eventName: 'SessionStart',
      body: { paneKey: identity.paneKey, launchToken: identity.launchToken },
      readiness: state,
      loadCheckpoint
    })
    expect(state.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('gives a Codex subagent separate context and blocks its first supported edit', async () => {
    const state = readiness()
    const body = {
      paneKey: identity.paneKey,
      launchToken: identity.launchToken,
      payload: JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'child-7' })
    }
    const context = await createAgentCheckpointHookResponse({
      source: 'codex',
      body,
      readiness: state,
      loadCheckpoint
    })
    expect(context?.body).toContain('child-7')
    expect(contextText(context?.body)).toContain(checkpoint.content)

    const blocked = await createAgentCheckpointHookResponse({
      source: 'codex',
      eventName: 'PreToolUse',
      hookRole: 'checkpoint',
      body: {
        ...body,
        payload: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: 'child-7', tool_name: 'apply_patch' })
      },
      readiness: state,
      loadCheckpoint
    })
    expect(blocked?.body).toContain('"permissionDecision":"deny"')
    expect(blocked?.body).toContain('analysis_required')
  })

  it('rejects a false generic acknowledgement and allows an applied task to use Write', async () => {
    const state = readiness()
    await createAgentCheckpointHookResponse({
      source: 'claude',
      eventName: 'SessionStart',
      body: { paneKey: identity.paneKey, launchToken: identity.launchToken },
      readiness: state,
      loadCheckpoint
    })
    expect(state.apply(identity, 'I read CHECKPOINT.md.', checkpoint)).toEqual({
      accepted: false,
      code: 'analysis_required'
    })
    expect(state.apply(identity, application('launch-1'), checkpoint)).toEqual({ accepted: true })

    await expect(
      createAgentCheckpointHookResponse({
        source: 'claude',
        eventName: 'PreToolUse',
        body: {
          paneKey: identity.paneKey,
          launchToken: identity.launchToken,
          payload: { hook_event_name: 'PreToolUse', tool_name: 'Write' }
        },
        readiness: state,
        loadCheckpoint
      })
    ).resolves.toBeNull()
  })

  it('surfaces the current document once through Antigravity PreInvocation and denies writes', async () => {
    const state = readiness()
    const invocation = {
      paneKey: identity.paneKey,
      launchToken: identity.launchToken,
      hook_event_name: 'PreInvocation',
      payload: '{}'
    }
    const context = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      body: invocation,
      readiness: state,
      loadCheckpoint
    })
    expect(context?.body).toContain('injectSteps')
    expect(contextText(context?.body)).toContain(checkpoint.content)
    const duplicate = await createAgentCheckpointHookResponse({
        source: 'antigravity',
        body: invocation,
        readiness: state,
        loadCheckpoint
      })
    expect(JSON.parse(duplicate?.body ?? '{}')).toMatchObject({
      injectSteps: [
        {
          ephemeralMessage: expect.stringContaining('ORCA CHECKPOINT PROCESS IDENTITY UNSUPPORTED')
        }
      ]
    })

    const denied = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreToolUse',
      hookRole: 'checkpoint',
      body: {
        ...invocation,
        hook_event_name: 'PreToolUse',
        payload: JSON.stringify({ toolCall: { name: 'write_to_file' } })
      },
      readiness: state,
      loadCheckpoint
    })
    expect(denied?.body).toContain('"decision":"deny"')
  })

  it('leaves generic Antigravity status decisions to the provider', async () => {
    const state = readiness()
    state.begin(identity, 'launch-1', SESSION_TASK_SUMMARY, checkpoint)
    expect(state.apply(identity, application('launch-1'), checkpoint)).toEqual({ accepted: true })

    const response = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreToolUse',
      body: {
        ...identity,
        payload: { hook_event_name: 'PreToolUse', tool_name: 'write_to_file' }
      },
      readiness: state,
      loadCheckpoint
    })

    expect(response).toBeNull()
  })

  it('keeps readiness for the same AGY process and resets it after same-conversation re-exec', async () => {
    const state = readiness()
    const resolveProcessIncarnation = async (_source: string, agentProcess: unknown) =>
      agentProcess === 'first-process' ? 'win32:agy:100' : 'win32:agy:200'
    const initial = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'SessionStart',
      body: { ...identity, agentProcess: 'first-process' },
      readiness: state,
      loadCheckpoint,
      resolveProcessIncarnation
    })
    expect(contextText(initial?.body)).toContain(checkpoint.content)
    state.apply(identity, application('launch-1'), checkpoint)

    const sameProcess = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreInvocation',
      body: { ...identity, agentProcess: 'first-process', payload: { invocationNum: 0 } },
      readiness: state,
      loadCheckpoint,
      resolveProcessIncarnation
    })
    expect(JSON.parse(sameProcess?.body ?? '{}')).toEqual({ injectSteps: [] })
    expect(state.checkCurrent(identity, checkpoint)).toEqual({ ready: true })

    const resumedProcess = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreInvocation',
      body: { ...identity, agentProcess: 'second-process', payload: { invocationNum: 0 } },
      readiness: state,
      loadCheckpoint,
      resolveProcessIncarnation
    })
    expect(contextText(resumedProcess?.body)).toContain(checkpoint.content)
    expect(state.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('injects Antigravity SessionStart context and resets readiness on another SessionStart', async () => {
    const state = readiness()
    const start = () =>
      createAgentCheckpointHookResponse({
        source: 'antigravity',
        eventName: 'SessionStart',
        body: { paneKey: identity.paneKey, launchToken: identity.launchToken },
        readiness: state,
        loadCheckpoint
      })

    const initial = await start()
    expect(contextText(initial?.body)).toContain(checkpoint.content)
    expect(JSON.parse(initial?.body ?? '{}').injectSteps[0].ephemeralMessage).toContain(
      checkpoint.content
    )
    expect(state.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })

    expect(state.apply(identity, application('launch-1'), checkpoint)).toEqual({ accepted: true })
    await start()
    expect(state.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
  })

  it('preserves same-launch Antigravity turns and resets a resumed conversation on a new launch token', async () => {
    const state = readiness()
    const conversationId = 'agy-conversation-1'
    const resolveProcessIncarnation = async () => 'win32:agy:100:200'
    const initial = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'SessionStart',
      body: { ...identity, payload: { conversationId } },
      readiness: state,
      resolveProcessIncarnation,
      loadCheckpoint
    })
    expect(contextText(initial?.body)).toContain(checkpoint.content)
    expect(state.apply(identity, application('launch-1'), checkpoint)).toEqual({ accepted: true })

    const sameLaunchTurn = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreInvocation',
      body: {
        ...identity,
        payload: { conversationId, invocationNum: 0 }
      },
      readiness: state,
      resolveProcessIncarnation,
      loadCheckpoint
    })
    expect(JSON.parse(sameLaunchTurn?.body ?? '{}')).toEqual({ injectSteps: [] })
    expect(state.checkCurrent(identity, checkpoint)).toEqual({ ready: true })

    const resumedIdentity = { ...identity, launchToken: 'launch-2' }
    const resumed = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreInvocation',
      body: {
        ...resumedIdentity,
        payload: { conversationId, invocationNum: 0 }
      },
      readiness: state,
      resolveProcessIncarnation,
      loadCheckpoint
    })
    expect(contextText(resumed?.body)).toContain(checkpoint.content)
    expect(state.checkCurrent(resumedIdentity, checkpoint)).toEqual({
      ready: false,
      code: 'analysis_required'
    })
    expect(state.checkCurrent(identity, checkpoint)).toEqual({
      ready: false,
      code: 'session_unregistered'
    })

    const duplicateResumeEvent = await createAgentCheckpointHookResponse({
      source: 'antigravity',
      eventName: 'PreInvocation',
      body: {
        ...resumedIdentity,
        payload: { conversationId, invocationNum: 0 }
      },
      readiness: state,
      resolveProcessIncarnation,
      loadCheckpoint
    })
    expect(JSON.parse(duplicateResumeEvent?.body ?? '{}')).toEqual({ injectSteps: [] })
  })

  it('does not classify shell commands as protected mutations', async () => {
    const response = await createAgentCheckpointHookResponse({
      source: 'codex',
      eventName: 'PreToolUse',
      body: {
        paneKey: identity.paneKey,
        launchToken: identity.launchToken,
        payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }
      },
      readiness: readiness(),
      loadCheckpoint
    })
    expect(response).toBeNull()
  })

  it('returns a concrete canonical source error and blocks recognized writes', async () => {
    const missing = async (): Promise<AgentCheckpoint> => {
      throw new AgentCheckpointSourceError('source_missing', checkpoint.canonicalPath)
    }
    const context = await createAgentCheckpointHookResponse({
      source: 'codex',
      eventName: 'SessionStart',
      body: { paneKey: identity.paneKey, launchToken: identity.launchToken },
      loadCheckpoint: missing,
      readiness: readiness()
    })
    expect(context?.body).toContain('source_missing')
    expect(context?.body).toContain(checkpoint.canonicalPath)

    const denied = await createAgentCheckpointHookResponse({
      source: 'codex',
      eventName: 'PreToolUse',
      hookRole: 'checkpoint',
      body: {
        paneKey: identity.paneKey,
        launchToken: identity.launchToken,
        payload: { hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }
      },
      loadCheckpoint: missing,
      readiness: readiness()
    })
    expect(denied?.body).toContain('"permissionDecision":"deny"')
    expect(denied?.body).toContain('source_missing')
  })
})

function contextText(body: string | undefined): string {
  if (!body) {
    return ''
  }
  const parsed: unknown = JSON.parse(body)
  if (!isRecord(parsed)) {
    return ''
  }
  const hookSpecificOutput = isRecord(parsed.hookSpecificOutput)
    ? parsed.hookSpecificOutput
    : undefined
  const steps = Array.isArray(parsed.injectSteps) ? parsed.injectSteps : []
  const firstStep = isRecord(steps[0]) ? steps[0] : undefined
  if (typeof firstStep?.ephemeralMessage === 'string') {
    return firstStep.ephemeralMessage
  }
  const systemMessage = firstStep && isRecord(firstStep.systemMessage)
    ? firstStep.systemMessage
    : undefined
  return (
    (typeof hookSpecificOutput?.additionalContext === 'string'
      ? hookSpecificOutput.additionalContext
      : undefined) ??
    (typeof systemMessage?.systemMessage === 'string' ? systemMessage.systemMessage : undefined) ??
    ''
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
