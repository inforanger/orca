import { HOOK_REQUEST_MAX_BYTES } from '../../shared/agent-hook-listener/request-body'
import {
  POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS,
  POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS
} from '../agent-hooks/hook-stdin-contract'
import { ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { getAgentCheckpointUnavailableDecision } from '../agent-checkpoint/agent-checkpoint-tool-policy'

// curl reads payload@- before starting its timeout; agy can keep that pipe open.
export const WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT = String.raw`
const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');
const env = process.env;
const port = Number(env.ORCA_AGENT_HOOK_PORT);
let outputWritten = false;
function writeFallback() {
  if (outputWritten) return;
  if (env.ORCA_ANTIGRAVITY_EVENT === 'Stop') {
    process.stdout.write('{"decision":""}\n');
    outputWritten = true;
  } else if (env.ORCA_ANTIGRAVITY_EVENT === 'PreToolUse') {
    process.stdout.write(env.ORCA_AGENT_HOOK_ROLE === 'checkpoint' ? '${getAgentCheckpointUnavailableDecision('antigravity')}' : '${ANTIGRAVITY_PRE_TOOL_USE_DECISION}');
    outputWritten = true;
  } else if (env.ORCA_ANTIGRAVITY_EVENT === 'SessionStart' || env.ORCA_ANTIGRAVITY_EVENT === 'PreInvocation') {
    process.stdout.write('{"injectSteps":[{"ephemeralMessage":"ORCA CHECKPOINT DELIVERY ERROR: the authenticated Orca hook endpoint did not respond; checkpoint text was not delivered."}]}\n');
    outputWritten = true;
  }
}
if (!Number.isInteger(port) || port < 1 || port > 65535 || !env.ORCA_AGENT_HOOK_TOKEN || !env.ORCA_PANE_KEY) { writeFallback(); process.exit(0); }
const decoder = new StringDecoder('utf8');
let payload = '';
let finished = false;
let byteLength = 0;
let started = false;
let inString = false;
let escaped = false;
let complete = false;
let invalid = false;
const stack = [];
const maxBytes = ${HOOK_REQUEST_MAX_BYTES};
let idleTimer;
const absoluteTimer = setTimeout(finish, 7000);
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  clearTimeout(absoluteTimer);
  process.stdin.pause();
  payload += decoder.end();
  const form = new URLSearchParams();
  for (const [name, variable] of [
    ['paneKey', 'ORCA_PANE_KEY'], ['tabId', 'ORCA_TAB_ID'],
    ['launchToken', 'ORCA_AGENT_LAUNCH_TOKEN'], ['worktreeId', 'ORCA_WORKTREE_ID'],
    ['env', 'ORCA_AGENT_HOOK_ENV'], ['version', 'ORCA_AGENT_HOOK_VERSION'],
    ['hook_event_name', 'ORCA_ANTIGRAVITY_EVENT']
  ]) form.set(name, env[variable] || '');
  if (env.ORCA_AGENT_HOOK_ROLE) form.set('hookRole', env.ORCA_AGENT_HOOK_ROLE);
  const agentProcessHint = env.ORCA_ANTIGRAVITY_EVENT === 'SessionStart' || env.ORCA_ANTIGRAVITY_EVENT === 'PreInvocation'
    ? JSON.stringify({ hookPid: process.pid, platform: process.platform })
    : '';
  if (agentProcessHint) form.set('agentProcess', agentProcessHint);
  form.set('payload', payload.trim() ? payload : '{}');
  const body = form.toString();
  if (Buffer.byteLength(body) > maxBytes) { writeFallback(); process.exit(0); }
  let request;
  const exit = () => { writeFallback(); if (request) request.destroy(); process.exit(0); };
  const postTimer = setTimeout(exit, 1500);
  try {
    // The listener verifies this hook PID's ancestor before accepting an AGY process identity.
    request = http.request({ hostname: '127.0.0.1', port, path: '/hook/antigravity', method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN,
      ...(agentProcessHint ? { 'X-Orca-Agent-Process': agentProcessHint } : {})
    } }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += chunk.toString('utf8'); });
      response.on('end', () => {
        clearTimeout(postTimer);
        if (responseBody.trim()) {
          process.stdout.write(responseBody);
          outputWritten = true;
          if (env.ORCA_ANTIGRAVITY_EVENT !== 'PreToolUse' && !responseBody.endsWith('\n')) process.stdout.write('\n');
        }
        exit();
      });
    });
    request.on('error', () => { clearTimeout(postTimer); exit(); });
    request.end(body);
  } catch { clearTimeout(postTimer); exit(); }
}
function resetIdle(timeout) { clearTimeout(idleTimer); idleTimer = setTimeout(finish, timeout); }
resetIdle(${POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS * 1000});
process.stdin.on('data', chunk => {
  if (finished) return;
  byteLength += chunk.length;
  if (byteLength > maxBytes) { writeFallback(); process.exit(0); }
  const text = decoder.write(chunk);
  payload += text;
  resetIdle(${POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS * 1000});
  for (const character of text) {
    if (invalid) break;
    if (complete) { if (!/\s/.test(character)) invalid = true; continue; }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (!started && /\s/.test(character)) continue;
    if (!started && character !== '{' && character !== '[') { invalid = true; break; }
    started = true;
    if (character === '"') inString = true;
    else if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (character !== stack.pop()) { invalid = true; break; }
      if (!stack.length) complete = true;
    }
  }
  if (complete && !invalid) {
    try { JSON.parse(payload); finish(); } catch { invalid = true; }
  }
});
process.stdin.on('end', finish);
process.stdin.on('error', finish);
`
