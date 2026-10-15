import { createHash } from 'node:crypto'
import { readFile as readUtf8File } from 'node:fs/promises'

export const DEFAULT_AGENT_CHECKPOINT_PATH =
  'C:/npmind.com Dropbox/Cheon Yongjun/Dev/npmind/rules/CHECKPOINT.md'

export type AgentCheckpoint = {
  canonicalPath: string
  content: string
  sha256: string
}

export type AgentCheckpointTask = {
  taskId?: string
  taskSummary: string
  agentId?: string
}

export type AgentCheckpointApplication = {
  checkpointSha256: string
  taskId: string
  taskSummary: string
  lessonsSearch: string
  why: [string, string, string, ...string[]]
  approachA: {
    method: string
    workload: string
    remainingProblem: string
  }
  approachB: {
    method: string
    workload: string
    solvedProblem: string
    feasible: boolean
    infeasibleReason: string
  }
  userRequestedApproachA: boolean
  selectedApproach: 'A' | 'B'
  selectionReason: string
  rootCause: string
  resolution: string
  verification: string
  reuseCheck: string
  architectureCheck: string
  errorPatternReview: string
  shortcutReview: string
}

export type AgentCheckpointApplicationResult =
  | { accepted: true }
  | {
      accepted: false
      code:
        | 'analysis_required'
        | 'analysis_incomplete'
        | 'task_mismatch'
        | 'source_changed'
        | 'structural_approach_required'
    }

export class AgentCheckpointSourceError extends Error {
  constructor(
    readonly code: 'source_missing' | 'source_empty' | 'source_unreadable',
    readonly canonicalPath: string,
    cause?: unknown
  ) {
    super(`${code}: ${canonicalPath}`, { cause })
    this.name = 'AgentCheckpointSourceError'
  }
}

export async function loadAgentCheckpoint(options: {
  canonicalPath?: string
  readFile?: (path: string) => Promise<string>
} = {}): Promise<AgentCheckpoint> {
  const canonicalPath = options.canonicalPath ?? DEFAULT_AGENT_CHECKPOINT_PATH
  let content: string
  try {
    content = await (options.readFile ?? ((path) => readUtf8File(path, 'utf8')))(canonicalPath)
  } catch (cause) {
    const errorCode = readErrorCode(cause)
    throw new AgentCheckpointSourceError(
      errorCode === 'ENOENT' || errorCode === 'ENOTDIR' ? 'source_missing' : 'source_unreadable',
      canonicalPath,
      cause
    )
  }
  if (content.trim().length === 0) {
    throw new AgentCheckpointSourceError('source_empty', canonicalPath)
  }
  return {
    canonicalPath,
    content,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex')
  }
}

export function renderAgentCheckpointContext(
  checkpoint: AgentCheckpoint,
  task?: AgentCheckpointTask
): string {
  const taskContext = task
    ? `\n${task.taskId ? `Current task ID: ${task.taskId}\n` : ''}Current task: ${task.taskSummary}\n${task.agentId ? `Current child agent ID: ${task.agentId}\n` : ''}`
    : '\nCurrent task: not assigned yet. Re-read this context after a task arrives.\n'
  return [
    'ORCA CHECKPOINT — read and apply before the first change',
    `Canonical source: ${checkpoint.canonicalPath}`,
    `Canonical SHA-256: ${checkpoint.sha256}`,
    taskContext,
    'The complete canonical document follows verbatim. Do not replace it with a summary.',
    '----- BEGIN CHECKPOINT.md -----',
    checkpoint.content,
    '----- END CHECKPOINT.md -----',
    '',
    `Before changing files or state, submit a task-specific application using \`orca agent checkpoint apply${task?.agentId ? ` --agent-id ${task.agentId}` : ''} --body-file -\`.`,
    'Include three concrete whys; compare approaches A and B, workload, and remaining/solved problems;',
    'select the structurally sound feasible approach, explain the root cause and resolution, and cover verification,',
    'reuse, architecture, error patterns, and shortcuts. Read-only investigation may happen first.',
    'A read claim or generic acknowledgement does not count. Re-apply after the canonical source hash changes.',
    'When you recognize a distinct user task in this same session, register it before the first change with `orca agent checkpoint context --task-summary "<task>"`; this clears the previous application. Do not re-register for every prompt or follow-up.',
    'Enforcement coverage is limited to the exact mutation and delegation tool names classified by the host.',
    'Bash/shell, command execution, MCP, custom tools, and other unclassified mutation routes are unsupported and are not blocked.',
    'A complete application record is structurally checked; it cannot prove that the analysis is truthful.',
    ''
  ].join('\n')
}

export function validateAgentCheckpointApplication(
  input: unknown,
  expected: { checkpoint: AgentCheckpoint; taskId: string; taskSummary: string }
): AgentCheckpointApplicationResult {
  if (!isRecord(input)) {
    return { accepted: false, code: 'analysis_required' }
  }
  const checkpointSha256 = readString(input.checkpointSha256)
  const taskId = readString(input.taskId)
  if (!checkpointSha256 || !taskId) {
    return { accepted: false, code: 'analysis_required' }
  }
  if (checkpointSha256 !== expected.checkpoint.sha256) {
    return { accepted: false, code: 'source_changed' }
  }
  if (taskId !== expected.taskId) {
    return { accepted: false, code: 'task_mismatch' }
  }
  if (readString(input.taskSummary) !== expected.taskSummary) {
    return { accepted: false, code: 'task_mismatch' }
  }
  if (!hasCompleteAnalysis(input)) {
    return { accepted: false, code: 'analysis_incomplete' }
  }
  if (
    (input.selectedApproach === 'A' &&
      input.approachB.feasible &&
      !input.userRequestedApproachA) ||
    (input.selectedApproach === 'B' && !input.approachB.feasible)
  ) {
    return { accepted: false, code: 'structural_approach_required' }
  }
  return { accepted: true }
}

function hasCompleteAnalysis(input: Record<string, unknown>): input is Record<string, unknown> & {
  taskSummary: string
  lessonsSearch: string
  why: string[]
  approachA: Record<string, unknown>
  approachB: Record<string, unknown> & { feasible: boolean }
  userRequestedApproachA: boolean
  selectedApproach: 'A' | 'B'
} {
  const approachA = isRecord(input.approachA) ? input.approachA : null
  const approachB = isRecord(input.approachB) ? input.approachB : null
  return (
    hasText(input.taskSummary) &&
    hasText(input.lessonsSearch) &&
    Array.isArray(input.why) &&
    input.why.length >= 3 &&
    input.why.every(hasText) &&
    !!approachA &&
    hasText(approachA.method) &&
    hasText(approachA.workload) &&
    hasText(approachA.remainingProblem) &&
    !!approachB &&
    hasText(approachB.method) &&
    hasText(approachB.workload) &&
    hasText(approachB.solvedProblem) &&
    typeof approachB.feasible === 'boolean' &&
    (approachB.feasible || hasText(approachB.infeasibleReason)) &&
    typeof input.userRequestedApproachA === 'boolean' &&
    (input.selectedApproach === 'A' || input.selectedApproach === 'B') &&
    hasText(input.selectionReason) &&
    hasText(input.rootCause) &&
    hasText(input.resolution) &&
    hasText(input.verification) &&
    hasText(input.reuseCheck) &&
    hasText(input.architectureCheck) &&
    hasText(input.errorPatternReview) &&
    hasText(input.shortcutReview)
  )
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function readString(value: unknown): string | null {
  return hasText(value) ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }
  return typeof error.code === 'string' ? error.code : null
}
