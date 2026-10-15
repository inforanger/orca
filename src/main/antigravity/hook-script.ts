import {
  buildPosixHookPayloadCapture,
  POSIX_HOOK_JSON_STDIN,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines
} from '../agent-hooks/hook-stdin-contract'
import { ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { getAgentCheckpointUnavailableDecision } from '../agent-checkpoint/agent-checkpoint-tool-policy'

const unavailableCheckpointDecision = getAgentCheckpointUnavailableDecision('antigravity')

export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  windowsRuntimePath = process.execPath
): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      // Why (#9358/#9941): inherited delayed expansion eats `!` out of the percent-expanded
      // curl args, mangling paneKey and dropping worktreeId. `!` is legal in a Windows path.
      'setlocal DisableDelayedExpansion',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsAntigravityEnvironmentGuardLines(),
      // The runtime path is fixed at installation; hook payloads stay on stdin.
      'set "ELECTRON_RUN_AS_NODE=1"',
      `if not defined ORCA_AGENT_HOOK_NODE set "ORCA_AGENT_HOOK_NODE=${windowsRuntimePath.replaceAll('%', '%%')}"`,
      '"%ORCA_AGENT_HOOK_NODE%" "%~dp0antigravity-hook-post.cjs" 2>nul',
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    'emit_checkpoint_hook_fallback() {',
    '  case "$ORCA_ANTIGRAVITY_EVENT" in',
    '    Stop) printf \'%s\\n\' \'{"decision":""}\' ;;',
    `    PreToolUse) if [ "$ORCA_AGENT_HOOK_ROLE" = checkpoint ]; then printf '%s\\n' '${unavailableCheckpointDecision}'; else printf '%s\\n' '${ANTIGRAVITY_PRE_TOOL_USE_DECISION}'; fi ;;`,
    '    SessionStart|PreInvocation) printf \'%s\\n\' \'{"injectSteps":[{"ephemeralMessage":"ORCA CHECKPOINT DELIVERY ERROR: the authenticated Orca hook endpoint did not respond; checkpoint text was not delivered."}]}\' ;;',
    '  esac',
    '}',
    // Why: some Antigravity events arrive without stdin but still need a
    // status post, so the shared capture maps empty input to an object.
    ...buildPosixHookPayloadCapture('empty-object', POSIX_HOOK_JSON_STDIN),
    ...buildPosixHookSpoolLines('antigravity', 'ORCA_ANTIGRAVITY_EVENT'),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  if [ -n "$ORCA_PANE_KEY" ]; then',
    '    emit_checkpoint_hook_fallback',
    '  fi',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'if response=$(printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/antigravity" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "hook_event_name=${ORCA_ANTIGRAVITY_EVENT}" \\',
    '  --data-urlencode "hookRole=${ORCA_AGENT_HOOK_ROLE}" \\',
    '  --data-urlencode "payload@-"); then',
    '  if [ -n "$response" ]; then',
    '    printf \'%s\\n\' "$response"',
    '  else',
    '    emit_checkpoint_hook_fallback',
    '  fi',
    'else',
    '  emit_checkpoint_hook_fallback',
    '  spool_hook_event',
    'fi',
    'exit 0',
    ''
  ].join('\n')
}

export function getWindowsWrapperScript(
  eventName: string,
  role: 'status' | 'checkpoint' = 'status'
): string {
  return [
    '@echo off',
    // Why (#9358/#9941): `!` is legal in the hooks path, and inherited delayed expansion
    // eats it out of the percent-expanded `%~dp0` — the wrapper then misses the core and
    // silently falls back on every event. Same reason the core disables it.
    'setlocal DisableDelayedExpansion',
      'rem Stop fallback: {"decision":""} is emitted by antigravity-hook-post.cjs when the listener returns no body.',
    `set "ORCA_ANTIGRAVITY_EVENT=${eventName}"`,
    ...(role === 'checkpoint' ? ['set "ORCA_AGENT_HOOK_ROLE=checkpoint"'] : []),
    'set "ORCA_ANTIGRAVITY_CORE=%~dp0antigravity-hook.cmd"',
    'if exist "%ORCA_ANTIGRAVITY_CORE%" (',
    '  call "%ORCA_ANTIGRAVITY_CORE%"',
    '  exit /b 0',
    ')',
    'if /I "%ORCA_ANTIGRAVITY_EVENT%"=="Stop" (',
    '  echo {"decision":""}',
    ') else if /I "%ORCA_ANTIGRAVITY_EVENT%"=="PreToolUse" (',
    ...(role === 'checkpoint'
      ? [`  echo ${unavailableCheckpointDecision}`]
      : [`  echo ${ANTIGRAVITY_PRE_TOOL_USE_DECISION}`]),
    ') else if /I "%ORCA_ANTIGRAVITY_EVENT%"=="SessionStart" (',
    '  echo {"injectSteps":[{"ephemeralMessage":"ORCA CHECKPOINT DELIVERY ERROR: managed Antigravity hook script is missing; checkpoint text was not delivered."}]}',
    ') else if /I "%ORCA_ANTIGRAVITY_EVENT%"=="PreInvocation" (',
    '  echo {"injectSteps":[{"ephemeralMessage":"ORCA CHECKPOINT DELIVERY ERROR: managed Antigravity hook script is missing; checkpoint text was not delivered."}]}',
    ') else (',
    '  echo {}',
    ')',
    // Missing-core fallbacks obey the same outside-Orca stdin guard as the core.
    ...buildWindowsHookEnvironmentGuardLines(),
    'exit /b 0',
    ''
  ].join('\r\n')
}

function buildWindowsAntigravityEnvironmentGuardLines(): string[] {
  return [
    'if not defined ORCA_PANE_KEY goto :orca_antigravity_no_pane',
    'if "%ORCA_AGENT_HOOK_PORT%"=="" goto :orca_antigravity_no_endpoint',
    'if "%ORCA_AGENT_HOOK_TOKEN%"=="" goto :orca_antigravity_no_endpoint',
    'if "%ORCA_PANE_KEY%"=="" goto :orca_antigravity_no_endpoint',
    'goto :orca_antigravity_endpoint_ready',
    ':orca_antigravity_no_endpoint',
    `if /I "%ORCA_ANTIGRAVITY_EVENT%"=="PreToolUse" if /I "%ORCA_AGENT_HOOK_ROLE%"=="checkpoint" echo ${unavailableCheckpointDecision}`,
    `if /I "%ORCA_ANTIGRAVITY_EVENT%"=="PreToolUse" if /I not "%ORCA_AGENT_HOOK_ROLE%"=="checkpoint" echo ${ANTIGRAVITY_PRE_TOOL_USE_DECISION}`,
    'if /I "%ORCA_ANTIGRAVITY_EVENT%"=="SessionStart" echo {"injectSteps":[{"ephemeralMessage":"ORCA CHECKPOINT DELIVERY ERROR: authenticated Orca hook endpoint is unavailable; checkpoint text was not delivered."}]}',
    'if /I "%ORCA_ANTIGRAVITY_EVENT%"=="PreInvocation" echo {"injectSteps":[{"ephemeralMessage":"ORCA CHECKPOINT DELIVERY ERROR: authenticated Orca hook endpoint is unavailable; checkpoint text was not delivered."}]}',
    'exit /b 0',
    ':orca_antigravity_endpoint_ready',
    'goto :orca_antigravity_guard_done',
    ':orca_antigravity_no_pane',
    `if /I "%ORCA_ANTIGRAVITY_EVENT%"=="PreToolUse" echo ${ANTIGRAVITY_PRE_TOOL_USE_DECISION}`,
    'exit /b 0',
    ':orca_antigravity_guard_done'
  ]
}
