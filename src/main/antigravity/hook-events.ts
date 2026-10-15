export const ANTIGRAVITY_HOOK_BUNDLE_NAME = 'orca-status'
export const ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME = 'antigravity-pre-tool-checkpoint-gate.cmd'

export const ANTIGRAVITY_EVENTS = [
  {
    eventName: 'SessionStart',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-session-start.cmd'
  },
  {
    eventName: 'PreInvocation',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-pre-invocation.cmd'
  },
  {
    eventName: 'PostInvocation',
    schema: 'direct',
    windowsWrapperFileName: 'antigravity-post-invocation.cmd'
  },
  { eventName: 'Stop', schema: 'direct', windowsWrapperFileName: 'antigravity-stop.cmd' },
  // PreToolUse is the only pre-tool signal Antigravity emits; without it panes show a bare "Working" spinner (#12898).
  {
    eventName: 'PreToolUse',
    schema: 'tool',
    windowsWrapperFileName: 'antigravity-pre-tool-use.cmd'
  },
  {
    eventName: 'PostToolUse',
    schema: 'tool',
    windowsWrapperFileName: 'antigravity-post-tool-use.cmd'
  }
] as const

// Why: the generic status hook must preserve Antigravity's normal confirmation policy.
export const ANTIGRAVITY_PRE_TOOL_USE_DECISION = '{"decision":"ask"}'

export type AntigravityEvent = (typeof ANTIGRAVITY_EVENTS)[number]

export const ANTIGRAVITY_MANAGED_SCRIPT_FILE_NAMES = [
  'antigravity-hook.sh',
  'antigravity-hook.cmd',
  ...ANTIGRAVITY_EVENTS.map((event) => event.windowsWrapperFileName),
  ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME
] as const
