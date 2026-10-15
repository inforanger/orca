import { readAgentProcessIdentity } from '../../shared/agent-process-presence'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import { readWindowsProcessIdentityTableFresh } from '../windows/windows-process-table'
import type { AgentCheckpointHookSource } from './agent-checkpoint-tool-policy'

export type AgentCheckpointProcessIdentityDependencies = {
  platform?: NodeJS.Platform
  readWindowsProcessIdentityTable?: () => Promise<WindowsProcessIdentityRow[]>
}

export async function resolveAgentCheckpointProcessIncarnation(
  source: AgentCheckpointHookSource,
  agentProcess: unknown,
  dependencies: AgentCheckpointProcessIdentityDependencies = {}
): Promise<string | undefined> {
  const identity = readAgentProcessIdentity(agentProcess)
  if (identity) {
    return `${identity.platform}:${identity.pid}:${identity.startTime}`
  }

  const hint = readWindowsHookProcessHint(agentProcess)
  if (source !== 'antigravity' || !hint || (dependencies.platform ?? process.platform) !== 'win32') {
    return undefined
  }

  try {
    const rows = await (dependencies.readWindowsProcessIdentityTable ??
      readWindowsProcessIdentityTableFresh)()
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    let processRow = byPid.get(hint.hookPid)
    const visited = new Set<number>([hint.hookPid])
    while (processRow && processRow.ppid > 0 && !visited.has(processRow.ppid)) {
      visited.add(processRow.ppid)
      processRow = byPid.get(processRow.ppid)
      if (!processRow) {
        return undefined
      }
      if (processRow.name.toLowerCase() === 'agy.exe') {
        return typeof processRow.creationTimeMs === 'number' &&
          Number.isSafeInteger(processRow.creationTimeMs) &&
          processRow.creationTimeMs > 0
          ? `win32:${processRow.pid}:${processRow.creationTimeMs}`
          : undefined
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function readWindowsHookProcessHint(value: unknown): { hookPid: number } | undefined {
  let record = value
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record)
    } catch {
      return undefined
    }
  }
  if (!isRecord(record)) {
    return undefined
  }
  const hint = record
  return hint.platform === 'win32' &&
    typeof hint.hookPid === 'number' &&
    Number.isSafeInteger(hint.hookPid) &&
    hint.hookPid > 1 &&
    hint.hookPid <= 0xffffffff
    ? { hookPid: hint.hookPid }
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
