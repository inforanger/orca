import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'

const { installForRuntimeHomeSerializedMock, realpathMock, readFileMock } = vi.hoisted(() => ({
  installForRuntimeHomeSerializedMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('../../../codex/hook-service', () => ({
  codexHookService: { installForRuntimeHomeSerialized: installForRuntimeHomeSerializedMock }
}))
vi.mock('node:fs/promises', () => ({ realpath: realpathMock, readFile: readFileMock }))

import { AGENT_HOOK_METHODS } from './agent-hooks'
import { agentCheckpointReadiness } from '../../../agent-checkpoint/agent-checkpoint-readiness'
import {
  _internals as managedWslHomeRegistryInternals,
  recordManagedWslCodexHome
} from '../../../codex/managed-wsl-codex-home-registry'

const LINUX_HOME = '/home/jin/.local/share/orca/codex-runtime-home/home'
const RUNTIME_HOME =
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-runtime-home\\home'

function prepareMethod() {
  const method = eraseRpcMethods(AGENT_HOOK_METHODS).find(
    (candidate) => candidate.name === 'agentHooks.prepareCodexForWslPane'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing agentHooks.prepareCodexForWslPane request method')
  }
  return method
}

function checkpointMethod(name: string) {
  const method = eraseRpcMethods(AGENT_HOOK_METHODS).find((candidate) => candidate.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing ${name} request method`)
  }
  return method
}

function runtimeWithSettings(enabled = true, disabledTuiAgents: string[] = []): OrcaRuntimeService {
  return {
    getClientSettings: vi.fn(() => ({
      agentStatusHooksEnabled: enabled,
      disabledTuiAgents
    }))
  } as unknown as OrcaRuntimeService
}

describe('agent hook RPC methods', () => {
  beforeEach(() => {
    installForRuntimeHomeSerializedMock.mockReset()
    realpathMock.mockReset()
    realpathMock.mockImplementation(async (path: string) => path)
    readFileMock.mockReset()
    readFileMock.mockResolvedValue('# CHECKPOINT\nRead the whole canonical file.\n')
    agentCheckpointReadiness.clearAll()
    managedWslHomeRegistryInternals.clearRecordedManagedWslCodexHomes()
    recordManagedWslCodexHome('Ubuntu-24.04', RUNTIME_HOME)
  })

  it('installs the pane-selected WSL home once and returns its status', async () => {
    const status = { agent: 'codex', state: 'installed' }
    installForRuntimeHomeSerializedMock.mockResolvedValue(status)
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: LINUX_HOME,
      orcaCodexHome: LINUX_HOME,
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBe(status)
    expect(installForRuntimeHomeSerializedMock).toHaveBeenCalledExactlyOnceWith(RUNTIME_HOME, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it.each([
    [false, []],
    [true, ['codex']]
  ])('does not install when hooks are disabled (%s, %j)', async (enabled, disabledTuiAgents) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      method.handler(params, { runtime: runtimeWithSettings(enabled, disabledTuiAgents) })
    ).resolves.toBeNull()
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it.each(['runtime', 'mobile'] as const)('rejects non-local %s callers', async (clientKind) => {
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      method.handler(params, {
        runtime: runtimeWithSettings(),
        clientKind
      } as RpcContext)
    ).rejects.toThrow(/only available to the local Orca CLI/)
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it('propagates an attempted installer failure', async () => {
    installForRuntimeHomeSerializedMock.mockRejectedValue(new Error('install failed'))
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).rejects.toThrow(
      'install failed'
    )
    expect(installForRuntimeHomeSerializedMock).toHaveBeenCalledOnce()
  })

  it('rejects a managed-looking home that resolves through a symlink', async () => {
    realpathMock.mockResolvedValue(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\outside-managed-home'
    )
    const method = prepareMethod()
    const params = method.params!.parse({
      codexHome: LINUX_HOME,
      orcaCodexHome: LINUX_HOME,
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toBeNull()
    expect(installForRuntimeHomeSerializedMock).not.toHaveBeenCalled()
  })

  it('rejects malformed distro names at the RPC schema', () => {
    const method = prepareMethod()

    expect(() =>
      method.params!.parse({
        codexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        orcaCodexHome: '/home/jin/.local/share/orca/codex-runtime-home/home',
        wslDistro: 'Ubuntu\\..\\host'
      })
    ).toThrow()
  })

  it('registers the current document and returns its verbatim task context over RPC', async () => {
    const method = checkpointMethod('agentHooks.checkpointContext')
    const params = method.params!.parse({
      paneKey: 'tab-1:pane-1',
      launchToken: 'launch-1',
      taskId: 'task-1',
      taskSummary: 'Fix checkpoint enforcement'
    })

    await expect(method.handler(params, { runtime: runtimeWithSettings() })).resolves.toMatchObject({
      taskId: 'task-1',
      context: expect.stringContaining('# CHECKPOINT\nRead the whole canonical file.\n')
    })
    expect(readFileMock).toHaveBeenCalledOnce()
  })

  it('accepts a complete task record only through the current session identity', async () => {
    const context = checkpointMethod('agentHooks.checkpointContext')
    const contextParams = context.params!.parse({
      paneKey: 'tab-1:pane-1',
      launchToken: 'launch-1',
      taskId: 'task-1',
      taskSummary: 'Fix checkpoint enforcement'
    })
    const current = await context.handler(contextParams, { runtime: runtimeWithSettings() })
    if (typeof current !== 'object' || current === null || !('checkpointSha256' in current)) {
      throw new Error('Checkpoint context did not return its source hash')
    }
    const application = {
      checkpointSha256: current.checkpointSha256,
      taskId: 'task-1',
      taskSummary: 'Fix checkpoint enforcement',
      lessonsSearch: 'Searched and applied the relevant hook lessons.',
      why: ['Launch omits context.', 'Hooks do not gate tools.', 'A shared source is needed.'],
      approachA: {
        method: 'Append a reminder.',
        workload: 'Small',
        remainingProblem: 'No task-bound gate.'
      },
      approachB: {
        method: 'Read and validate the canonical source.',
        workload: 'Several adapters',
        solvedProblem: 'Supported writes wait for analysis.',
        feasible: true,
        infeasibleReason: ''
      },
      userRequestedApproachA: false,
      selectedApproach: 'B',
      selectionReason: 'This closes the shared lifecycle gap.',
      rootCause: 'Delivery and hook decisions are disconnected.',
      resolution: 'Use the shared checkpoint readiness state.',
      verification: 'Exercise launch, resume, dispatch and hooks.',
      reuseCheck: 'Extend existing CLI and hook transports.',
      architectureCheck: 'Keep one source and readiness owner.',
      errorPatternReview: 'Search existing launch and hook patterns.',
      shortcutReview: 'No delays or swallowed errors.'
    }
    const apply = checkpointMethod('agentHooks.checkpointApply')

    await expect(
      apply.handler(
        apply.params!.parse({
          paneKey: 'tab-1:pane-1',
          launchToken: 'launch-1',
          application
        }),
        { runtime: runtimeWithSettings() }
      )
    ).resolves.toEqual({ accepted: true })
  })
})
