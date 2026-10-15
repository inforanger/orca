import { describe, expect, it } from 'vitest'
import {
  resolveAgentCheckpointProcessIncarnation,
  type AgentCheckpointProcessIdentityDependencies
} from './agent-checkpoint-process-identity'

const windowsRows = [
  { pid: 67132, ppid: 77528, name: 'Orca.exe' },
  { pid: 77528, ppid: 69144, name: 'cmd.exe' },
  { pid: 69144, ppid: 37292, name: 'cmd.exe' },
  { pid: 37292, ppid: 64964, name: 'agy.exe', creationTimeMs: 1792052066599 },
  { pid: 64964, ppid: 84644, name: 'node.exe', creationTimeMs: 1792052050000 }
]

describe('resolveAgentCheckpointProcessIncarnation', () => {
  it('uses the provider PID and start time from an existing agentProcess identity', async () => {
    await expect(
      resolveAgentCheckpointProcessIncarnation('claude', {
        pid: 412,
        platform: 'linux',
        startTime: 'boot-id:9981'
      })
    ).resolves.toBe('linux:412:boot-id:9981')
  })

  it('resolves Antigravity from verified hook ancestry, not the hook runner PID', async () => {
    const dependencies: AgentCheckpointProcessIdentityDependencies = {
      platform: 'win32',
      readWindowsProcessIdentityTable: async () => windowsRows
    }

    await expect(
      resolveAgentCheckpointProcessIncarnation(
        'antigravity',
        { hookPid: 67132, platform: 'win32' },
        dependencies
      )
    ).resolves.toBe('win32:37292:1792052066599')
  })

  it('leaves an unverified Windows process or unrelated client unsupported', async () => {
    const dependencies: AgentCheckpointProcessIdentityDependencies = {
      platform: 'win32',
      readWindowsProcessIdentityTable: async () => windowsRows
    }

    await expect(
      resolveAgentCheckpointProcessIncarnation(
        'antigravity',
        { hookPid: 67132, platform: 'win32' },
        { ...dependencies, readWindowsProcessIdentityTable: async () => [] }
      )
    ).resolves.toBeUndefined()
    await expect(
      resolveAgentCheckpointProcessIncarnation(
        'codex',
        { hookPid: 67132, platform: 'win32' },
        dependencies
      )
    ).resolves.toBeUndefined()
  })
})
