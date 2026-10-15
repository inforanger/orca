import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { AGENT_STATUS_MAX_FIELD_LENGTH } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildBody, PANE, LEAF_2, LEAF_3 } from './server.test-fixtures'
import type * as AgentCheckpointModule from '../agent-checkpoint/agent-checkpoint'
type AgentCheckpoint = AgentCheckpointModule.AgentCheckpoint
import { agentCheckpointReadiness } from '../agent-checkpoint/agent-checkpoint-readiness'

const { checkpointLoadMock, getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  checkpointLoadMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

vi.mock('../agent-checkpoint/agent-checkpoint', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCheckpointModule>()
  return { ...actual, loadAgentCheckpoint: checkpointLoadMock }
})

beforeEach(() => {
  _internals.resetCachesForTests()
  agentCheckpointReadiness.clearAll()
  checkpointLoadMock.mockReset()
  checkpointLoadMock.mockResolvedValue({
    canonicalPath: 'C:/canonical/rules/CHECKPOINT.md',
    content: 'Canonical checkpoint text to inject unchanged.',
    sha256: 'a'.repeat(64)
  } satisfies AgentCheckpoint)
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function postClaudeHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody(payload))
  })
}

async function postCheckpointHook(
  server: AgentHookServer,
  source: 'claude' | 'codex' | 'antigravity',
  body: unknown
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(body)
  })
}

function application(taskId: string, checkpoint: AgentCheckpoint) {
  return {
    checkpointSha256: checkpoint.sha256,
    taskId,
    taskSummary: `Apply CHECKPOINT.md to ${taskId}.`,
    lessonsSearch: 'Reviewed the related checkpoint enforcement lessons and prior adapter evidence.',
    why: ['The launch may omit it.', 'Provider lifecycle hooks differ.', 'Writes need task-specific review.'],
    approachA: {
      method: 'Add one startup reminder.',
      workload: 'Small',
      remainingProblem: 'Resume and child sessions are not covered.'
    },
    approachB: {
      method: 'Use lifecycle context and exact supported mutation hooks.',
      workload: 'Three provider adapters.',
      solvedProblem: 'Supported file writes wait for this session application.',
      feasible: true,
      infeasibleReason: ''
    },
    userRequestedApproachA: false,
    selectedApproach: 'B' as const,
    selectionReason: 'This extends the authenticated hook route and keeps provider permission policy.',
    rootCause: 'The previous listener returned status-only responses.',
    resolution: 'Return canonical text and provider-specific mutation decisions.',
    verification: 'Exercise actual loopback HTTP responses and readiness.',
    reuseCheck: 'Reuse the current hook listener and CLI application RPC.',
    architectureCheck: 'Keep one canonical source and shared session-state owner.',
    errorPatternReview: 'Test missing and changed source before allowing writes.',
    shortcutReview: 'Do not inspect arbitrary shell command text with a whitelist.'
  }
}

describe('AgentHookServer listener replay', () => {
  it('accepts raw JSON hook bodies with base64 metadata headers', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN,
          'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
          'X-Orca-Agent-Hook-Meta': Buffer.from(
            [PANE, 'tab-1', '', 'wt-1', 'production', ''].join('\x1f')
          ).toString('base64')
        },
        body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'raw JSON' })
      })

      expect(response.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          worktreeId: 'wt-1',
          state: 'working',
          prompt: 'raw JSON'
        })
      ])
    } finally {
      server.stop()
    }
  })

  it('returns client context and supported-tool decisions through the authenticated listener', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const checkpoint = {
      canonicalPath: 'C:/canonical/rules/CHECKPOINT.md',
      content: 'Canonical checkpoint text to inject unchanged.',
      sha256: 'a'.repeat(64)
    }
    try {
      const scenarios = [
        { source: 'claude', eventName: 'SessionStart', toolName: 'Write', token: 'claude-token' },
        { source: 'codex', eventName: 'SessionStart', toolName: 'apply_patch', token: 'codex-token' },
        { source: 'antigravity', eventName: 'PreInvocation', toolName: 'write_to_file', token: 'agy-token' }
      ] as const

      for (const scenario of scenarios) {
        const processIdentity =
          scenario.source === 'antigravity'
            ? { platform: 'win32', pid: 1200, startTime: 'agy-initial-process' }
            : undefined
        const context = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          ...(processIdentity ? { agentProcess: processIdentity } : {}),
          payload: {
            hook_event_name: scenario.eventName,
            session_id: `${scenario.source}-session`,
            taskSummary: `Apply CHECKPOINT.md to ${scenario.token}.`
          }
        })
        expect(context.status).toBe(200)
        const contextText = await context.text()
        expect(contextText).toContain(checkpoint.sha256)
        expect(contextText).toContain('Bash/shell, command execution, MCP')

        const genericStatus = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: scenario.toolName,
            toolCall: { name: scenario.toolName }
          }
        })
        expect(genericStatus.status).toBe(204)

        const blocked = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          hookRole: 'checkpoint',
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: scenario.toolName,
            toolCall: { name: scenario.toolName }
          }
        })
        expect(blocked.status).toBe(200)
        expect(await blocked.text()).toContain('"deny"')
        expect(
          agentCheckpointReadiness.apply(
            { paneKey: PANE, launchToken: scenario.token },
            application(scenario.token, checkpoint),
            checkpoint
          )
        ).toEqual({ accepted: true })

        const genericStatusAfterApplication = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: scenario.toolName,
            toolCall: { name: scenario.toolName }
          }
        })
        expect(genericStatusAfterApplication.status).toBe(204)

        const allowed = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          hookRole: 'checkpoint',
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: scenario.toolName,
            toolCall: { name: scenario.toolName }
          }
        })
        if (scenario.source === 'antigravity') {
          expect(allowed.status).toBe(200)
          expect(await allowed.text()).toContain('"decision":"allow"')
        } else {
          expect(allowed.status).toBe(204)
        }

        const resumeEventName = scenario.source === 'antigravity' ? 'PreInvocation' : 'SessionStart'
        const resumeContext = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          ...(scenario.source === 'antigravity'
            ? {
                agentProcess: {
                  platform: 'win32',
                  pid: 1201,
                  startTime: 'agy-resumed-process'
                }
              }
            : {}),
          payload: {
            hook_event_name: resumeEventName,
            session_id: `${scenario.source}-session`,
            taskSummary: `Apply CHECKPOINT.md to ${scenario.token}.`,
            invocationNum: 0
          }
        })
        expect(resumeContext.status).toBe(200)
        expect(await resumeContext.text()).toContain(checkpoint.sha256)

        const resumeDenied = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          hookRole: 'checkpoint',
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: scenario.toolName,
            toolCall: { name: scenario.toolName }
          }
        })
        expect(resumeDenied.status).toBe(200)
        expect(await resumeDenied.text()).toContain('"deny"')
        expect(
          agentCheckpointReadiness.apply(
            { paneKey: PANE, launchToken: scenario.token },
            application(scenario.token, checkpoint),
            checkpoint
          )
        ).toEqual({ accepted: true })

        const resumeAllowed = await postCheckpointHook(server, scenario.source, {
          paneKey: PANE,
          launchToken: scenario.token,
          hookRole: 'checkpoint',
          payload: {
            hook_event_name: 'PreToolUse',
            tool_name: scenario.toolName,
            toolCall: { name: scenario.toolName }
          }
        })
        if (scenario.source === 'antigravity') {
          expect(resumeAllowed.status).toBe(200)
          expect(await resumeAllowed.text()).toContain('"decision":"allow"')
        } else {
          expect(resumeAllowed.status).toBe(204)
        }
      }

      const unsupported = await postCheckpointHook(server, 'codex', {
        paneKey: PANE,
        launchToken: 'codex-token',
        payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }
      })
      expect(unsupported.status).toBe(204)
    } finally {
      server.stop()
    }
  })

  it('caches and notifies status/main/plugin before retry scheduling and HTTP response', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const order: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spies on protected AgentHookServer methods that exist on the instance.
    const internal = server as unknown as {
      scheduleAssistantMessageRetry: (...args: unknown[]) => void
      scheduleTranscriptPoll: (...args: unknown[]) => void
    }
    const originalAssistantRetry = internal.scheduleAssistantMessageRetry.bind(server)
    const originalTranscriptPoll = internal.scheduleTranscriptPoll.bind(server)
    const assistantRetry = vi
      .spyOn(internal, 'scheduleAssistantMessageRetry')
      .mockImplementation((...args) => {
        order.push('assistant-retry')
        originalAssistantRetry(...args)
      })
    const codexRetry = vi
      .spyOn(internal, 'scheduleTranscriptPoll')
      .mockImplementation((...args) => {
        order.push('codex-retry')
        originalTranscriptPoll(...args)
      })
    const unsubscribeStatus = server.subscribeStatusChanges(() => order.push('status-change'))
    server.setListener(() => {
      expect(server.getStatusSnapshotForPane(PANE)).toHaveLength(1)
      order.push('main-listener')
    })
    const unsubscribePlugin = server.subscribeEnrichedStatus(() => order.push('plugin-listener'))
    try {
      const response = await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'ordered'
      })
      order.push('response')
      expect(response.status).toBe(204)
      expect(order).toEqual([
        'status-change',
        'main-listener',
        'plugin-listener',
        'assistant-retry',
        'codex-retry',
        'response'
      ])
    } finally {
      unsubscribeStatus()
      unsubscribePlugin()
      assistantRetry.mockRestore()
      codexRetry.mockRestore()
      server.stop()
    }
  })

  it('fails open after a throwing callback with cache retained and retries skipped', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spies on protected AgentHookServer methods that exist on the instance.
    const internal = server as unknown as {
      scheduleAssistantMessageRetry: (...args: unknown[]) => void
      scheduleTranscriptPoll: (...args: unknown[]) => void
    }
    const assistantRetry = vi.spyOn(internal, 'scheduleAssistantMessageRetry')
    const codexRetry = vi.spyOn(internal, 'scheduleTranscriptPoll')
    server.setListener(() => {
      throw new Error('listener failed')
    })
    try {
      const response = await postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'cached before callback'
      })
      expect(response.status).toBe(204)
      expect(server.getStatusSnapshotForPane(PANE)).toHaveLength(1)
      expect(assistantRetry).not.toHaveBeenCalled()
      expect(codexRetry).not.toHaveBeenCalled()
    } finally {
      assistantRetry.mockRestore()
      codexRetry.mockRestore()
      server.stop()
    }
  })
  it('ignores local nested Claude Stop while a parent Codex hook status is active', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)
      const postHook = async (
        source: 'codex' | 'claude',
        payload: Record<string, unknown>
      ): Promise<void> => {
        const response = await fetch(
          `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
            },
            body: JSON.stringify(buildBody(payload))
          }
        )
        expect(response.status).toBe(204)
      }

      await postHook('codex', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'parent codex'
      })
      await postHook('claude', {
        hook_event_name: 'Stop',
        last_assistant_message: 'child finished'
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          prompt: 'parent codex',
          agentType: 'codex'
        })
      ])
      const snapshot = server.getStatusSnapshot()[0]
      expect(snapshot.lastAssistantMessage).toBeUndefined()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'parent codex',
            agentType: 'codex'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('does not apply Claude background evidence from a rejected local status', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postClaudeHook = async (payload: Record<string, unknown>): Promise<void> => {
        const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })
        expect(response.status).toBe(204)
      }

      await postClaudeHook({
        hook_event_name: 'PermissionRequest',
        prompt: 'approve shell',
        tool_name: 'Bash',
        background_tasks: [{ id: 'shell-1', type: 'shell', status: 'running' }],
        session_crons: [{ id: 'cron-1', status: 'running' }]
      })
      const waiting = server.getStatusSnapshot()[0]

      await postClaudeHook({
        hook_event_name: 'PreToolUse',
        prompt: 'approve shell',
        tool_name: 'OtherTool',
        background_tasks: [],
        session_crons: []
      })

      expect(server.getStatusSnapshot()[0]).toEqual(waiting)
      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(true)
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('maps registered legacy numeric HTTP pane keys to stable pane keys', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      server.registerPaneKeyAlias('tab-1:0', PANE)
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              prompt: 'legacy pane'
            },
            { paneKey: 'tab-1:0' }
          )
        )
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'legacy pane',
            agentType: 'claude'
          })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('tracks hook posts with an empty paneKey before dropping them', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            {
              hook_event_name: 'UserPromptSubmit',
              prompt: 'missing pane'
            },
            { paneKey: '' }
          )
        )
      })
      const listener = vi.fn()
      server.setListener(listener)

      expect(response.status).toBe(204)
      expect(listener).not.toHaveBeenCalled()
      expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
        reason: 'empty_pane_key'
      })
    } finally {
      server.stop()
    }
  })

  // Why (agent-status-over-SSH §3): ingestRemote must run the same warn-once diagnostics as the local HTTP path so stale remote hooks signal locally.
  it('runs warn-once env/version diagnostics on relay-forwarded events', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = vi.fn()
      server.setListener(listener)

      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'development',
          version: '999',
          payload: {
            state: 'working',
            paneKey: PANE,
            updatedAt: Date.now(),
            agentType: 'claude'
          }
        },
        'conn-1'
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          connectionId: 'conn-1',
          payload: expect.objectContaining({ state: 'working', agentType: 'claude' })
        })
      )

      const warnCalls = warn.mock.calls.map((c) => String(c[0]))
      expect(warnCalls.some((m) => m.includes('v999'))).toBe(true)
      expect(warnCalls.some((m) => m.includes('development') && m.includes('production'))).toBe(
        true
      )

      const warnsAfterFirst = warn.mock.calls.length
      const secondPane = makePaneKey('tab-2', LEAF_2)
      server.ingestRemote(
        {
          paneKey: secondPane,
          env: 'development',
          version: '999',
          payload: {
            state: 'working',
            paneKey: secondPane,
            updatedAt: Date.now(),
            agentType: 'claude'
          }
        },
        'conn-1'
      )
      expect(warn.mock.calls.length).toBe(warnsAfterFirst)
      // Why: assert fanout still fires on the second event too, else a refactor that drops it would pass on warn-count alone.
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      server.stop()
    }
  })

  it('treats remote env as normal relay traffic and normalizes payload at the trust boundary', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = vi.fn()
      server.setListener(listener)

      const oversizedPrompt = 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH + 50)
      const remotePane = makePaneKey('tab-3', LEAF_3)
      server.ingestRemote(
        {
          paneKey: ` ${remotePane} `,
          tabId: ' tab-3 ',
          worktreeId: ' wt-3 ',
          env: 'remote',
          version: '1',
          payload: {
            state: 'done',
            prompt: oversizedPrompt,
            agentType: 'codex'
          }
        },
        ' conn-9 '
      )

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: remotePane,
          tabId: 'tab-3',
          worktreeId: 'wt-3',
          connectionId: 'conn-9',
          payload: expect.objectContaining({
            state: 'done',
            agentType: 'codex',
            prompt: 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH)
          })
        })
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('accepts form-encoded hook posts from Unix managed scripts', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const params = new URLSearchParams({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'repo::/tmp/worktree with "quotes"',
        env: 'production',
        version: env.ORCA_AGENT_HOOK_VERSION ?? '',
        payload: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'form encoded'
        })
      })

      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: params
      })
      expect(response.status).toBe(204)

      const listener = vi.fn()
      server.setListener(listener)

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'repo::/tmp/worktree with "quotes"',
          connectionId: null,
          receivedAt: expect.any(Number),
          stateStartedAt: expect.any(Number),
          payload: expect.objectContaining({
            state: 'working',
            prompt: 'form encoded',
            agentType: 'claude'
          })
        })
      )
    } finally {
      server.stop()
    }
  })
})
