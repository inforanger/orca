import type {
  AgentCheckpointReadinessResult
} from './agent-checkpoint-readiness'

export type AgentCheckpointHookSource = 'claude' | 'codex' | 'antigravity'

export type AgentCheckpointToolDecision =
  | { decision: 'allow' }
  | {
      decision: 'deny'
      code: string
      reason: string
    }
  | {
      decision: 'unsupported'
      reason: string
    }

const CHECKPOINT_MUTATION_TOOLS = new Set([
  'claude:Write',
  'claude:Edit',
  'claude:MultiEdit',
  'claude:NotebookEdit',
  'codex:apply_patch',
  'antigravity:write_to_file',
  'antigravity:replace_file_content',
  'antigravity:multi_replace_file_content'
])

const CHECKPOINT_DELEGATION_TOOLS = new Set([
  'claude:Task',
  'codex:spawn_agent',
  'antigravity:invoke_subagent'
])
const CHECKPOINT_GATED_TOOLS = new Set([...CHECKPOINT_MUTATION_TOOLS, ...CHECKPOINT_DELEGATION_TOOLS])

export function decideAgentCheckpointTool(args: {
  source: AgentCheckpointHookSource
  toolName: string
  readiness: AgentCheckpointReadinessResult
}): AgentCheckpointToolDecision {
  if (!isAgentCheckpointGatedTool(args.source, args.toolName)) {
    return {
      decision: 'unsupported',
      reason: `Orca does not classify ${args.source} tool ${args.toolName} as a checkpoint-gated mutation.`
    }
  }
  if (args.readiness.ready) {
    return { decision: 'allow' }
  }
  return {
    decision: 'deny',
    code: args.readiness.code,
    reason: readinessReason(args.readiness)
  }
}

export function isAgentCheckpointGatedTool(
  source: AgentCheckpointHookSource,
  toolName: string
): boolean {
  return CHECKPOINT_GATED_TOOLS.has(`${source}:${toolName}`)
}

export function getAgentCheckpointToolMatcher(source: AgentCheckpointHookSource): string | null {
  const toolNames = [...CHECKPOINT_GATED_TOOLS]
    .filter((key) => key.startsWith(`${source}:`))
    .map((key) => key.slice(source.length + 1))
  return toolNames.length > 0 ? `^(${toolNames.map(escapeRegExp).join('|')})$` : null
}

export function getAgentCheckpointUnavailableDecision(source: AgentCheckpointHookSource): string {
  const reason =
    'ORCA CHECKPOINT DELIVERY ERROR: the authenticated hook endpoint is unavailable; this classified tool is blocked until checkpoint readiness can be verified.'
  if (source === 'antigravity') {
    return JSON.stringify({ decision: 'deny', reason })
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readinessReason(readiness: Extract<AgentCheckpointReadinessResult, { ready: false }>): string {
  switch (readiness.code) {
    case 'session_unregistered':
      return 'This Orca session has not loaded CHECKPOINT.md. Run `orca agent checkpoint context` and apply its task-specific checklist.'
    case 'task_mismatch':
      return 'The checkpoint application belongs to another task. Read the current task context and apply it again.'
    case 'source_changed':
      return 'The canonical CHECKPOINT.md changed. Read the current document and apply it again before changing files.'
    case 'analysis_required':
      return 'Apply the current task-specific CHECKPOINT.md analysis with `orca agent checkpoint apply --stdin` before changing files.'
  }
}
