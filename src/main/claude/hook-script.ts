import { buildHookProcessCapture } from '../agent-hooks/hook-process-capture'
import { getAgentCheckpointUnavailableDecision } from '../agent-checkpoint/agent-checkpoint-tool-policy'
/** The managed Claude-compatible hook script, built for local, POSIX-remote and Windows targets.
 *  Split from hook-service.ts so the service owns install/status and this owns script text,
 *  mirroring the same split under src/main/cursor/. */
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installer-utils'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixGrokReplayGuardLines,
  buildWindowsGrokReplayGuardLines
} from '../agent-hooks/grok-replay-guard'
import {
  WINDOWS_HOOK_STDIN_DRAIN_LABEL,
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

// Why: a backgrounded session runs in a daemon worker that inherited the dispatching
// pane's env, so ORCA_PANE_KEY names a pane this session does not run in (#9236).
// Why exit, not the drain label: the drain parks in more.com and a worker is outside
// an Orca pane — the abandoned-stdin hang #11549 guards against.
export const WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD = 'if not "%CLAUDE_JOB_DIR%"=="" exit /b 0'

export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: {
    source?: AgentHookSource
    skipWhenDevinImportsClaude?: boolean
    skipWhenGrokImportsClaude?: boolean
    checkpointGate?: boolean
  } = {}
): string {
  const source = options.source ?? 'claude'
  const checkpointFallback = options.checkpointGate
    ? getAgentCheckpointUnavailableDecision('claude')
    : '{"systemMessage":"ORCA CHECKPOINT DELIVERY ERROR: the authenticated Orca hook endpoint is unavailable; checkpoint text was not delivered and this fallback does not block mutations."}'
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: refresh endpoint coordinates for PTYs surviving an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Why (#11549): the env guards must outrank the Devin skip — the Devin skip parks in more.com,
      // and outside an Orca pane the caller can abandon stdin, so more.com never returns.
      ...buildWindowsHookEnvironmentGuardLines(checkpointFallback),
      ...(options.checkpointGate ? ['set "ORCA_AGENT_HOOK_ROLE=checkpoint"'] : []),
      WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
      ...(options.skipWhenGrokImportsClaude ? buildWindowsGrokReplayGuardLines() : []),
      ...(options.skipWhenDevinImportsClaude
        ? [
            // Why: Devin imports .claude hooks by default; skip Orca's managed hook there so status posts stay attributed to Devin.
            `if not "%DEVIN_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
          ]
        : []),
      // Why: use curl.exe to avoid an extra PowerShell startup per hook.
      buildWindowsAgentHookCurlPostCommand(source, {
        outputResponse: true,
        failOnHttpError: true,
        ...(options.checkpointGate ? { hookRole: 'checkpoint' as const } : {})
      }),
      ...(options.checkpointGate
        ? [`if errorlevel 1 echo ${checkpointFallback}`]
        : ['if errorlevel 1 echo {"systemMessage":"ORCA CHECKPOINT DELIVERY ERROR: the authenticated Orca hook endpoint did not respond; checkpoint text was not delivered and this fallback does not block mutations."}']),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...(options.skipWhenGrokImportsClaude ? buildPosixGrokReplayGuardLines() : []),
    ...(options.checkpointGate ? ['ORCA_AGENT_HOOK_ROLE=checkpoint'] : []),
    ...buildPosixHookSpoolLines(source),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Why: Devin imports .claude hooks by default; skip Orca's managed hook there so status posts stay attributed to Devin.
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          '  exit 0',
          'fi'
        ]
      : []),
    // Why: a backgrounded session runs in a daemon worker that inherited the dispatching
    // pane's env, so ORCA_PANE_KEY names a pane this session does not run in (#9236).
    'if [ -n "$CLAUDE_JOB_DIR" ]; then',
    '  exit 0',
    'fi',
    ...(source === 'claude' ? buildHookProcessCapture() : []),
    // Why: refresh endpoint coordinates for PTYs surviving an Orca restart.
    // Why: suppress parse errors so they neither leak nor trip outer set -e.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  unset ORCA_AGENT_HOOK_TRANSPORT',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  if [ -n "$ORCA_PANE_KEY" ] && [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    `    printf '%s\\n' '${checkpointFallback}'`,
    '    spool_hook_event',
    '  fi',
    '  exit 0',
    'fi',
    // Why: keep full hook JSON off the command line and avoid IDS-friendly URL-encoded paths.
    ...buildPosixAgentHookPostCommand(source, {
      failOnHttpError: true,
      ...(options.checkpointGate ? { hookRole: 'checkpoint' as const } : {})
    }).map((line, index, lines) =>
      index === lines.length - 1
        ? `${line} || { printf '%s\\n' '${checkpointFallback}'; spool_hook_event; }`
        : line
    ),
    'exit 0',
    ''
  ].join('\n')
}
