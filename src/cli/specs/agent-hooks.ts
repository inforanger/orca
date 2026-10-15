import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'checkpoint', 'context'],
    summary: 'Read and register the canonical CHECKPOINT.md for this Orca session',
    usage: 'orca agent checkpoint context [--task-id <id>] [--task-summary <text>] [--agent-id <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task-id', 'task-summary', 'agent-id'],
    notes: [
      'Reads the single canonical CHECKPOINT.md path and prints the complete original document with its SHA-256.',
      'In an Orca-launched session, this also resets the session checkpoint state before the task-specific analysis is submitted.',
      'Pass --task-summary when a distinct user task starts in the same session; this resets readiness for that task.'
    ],
    examples: ['orca agent checkpoint context']
  },
  {
    path: ['agent', 'checkpoint', 'apply'],
    summary: 'Submit task-specific CHECKPOINT.md analysis from JSON on stdin',
    usage: 'orca agent checkpoint apply --body-file - [--agent-id <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'body-file', 'agent-id'],
    notes: [
      'Reads a structured task application from stdin; it does not create a JSON file in the workspace.',
      'The current Orca session and canonical document hash must match; a read claim or generic acknowledgement is rejected.'
    ]
  },
  {
    path: ['agent', 'hooks', 'prepare-codex'],
    summary: "Prepare a WSL pane's Orca-managed Codex home before a shell launch",
    usage: 'orca agent hooks prepare-codex',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Orca-managed agent status hooks are enabled',
    usage: 'orca agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks status', 'orca agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Orca-managed agent status hooks and remove local hook entries',
    usage: 'orca agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Orca-managed agent status hooks',
    usage: 'orca agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks on']
  }
]
