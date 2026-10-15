import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { getAgentCheckpointUnavailableDecision } from '../agent-checkpoint/agent-checkpoint-tool-policy'
import { ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT } from './windows-hook-json-post'

const directory = mkdtempSync(join(tmpdir(), 'orca-agy-json-post-'))
const script = join(directory, 'hook.cjs')
writeFileSync(script, WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

it('writes PreToolUse fallback decisions as a single protojson value', async () => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => response.writeHead(204).end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  const decisions = [
    { role: undefined, expected: ANTIGRAVITY_PRE_TOOL_USE_DECISION },
    { role: 'checkpoint', expected: getAgentCheckpointUnavailableDecision('antigravity') }
  ]
  try {
    for (const { role, expected } of decisions) {
      const child = spawnProcess({
        program: process.execPath,
        args: [script],
        env: {
          ...process.env,
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
          ORCA_PANE_KEY: 'proof-pane',
          ORCA_ANTIGRAVITY_EVENT: 'PreToolUse',
          ...(role ? { ORCA_AGENT_HOOK_ROLE: role } : {})
        }
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const timer = setTimeout(() => child.kill(), 4000)
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
        child.stdin.end('{}')
      })
      clearTimeout(timer)
      expect(exitCode).toBe(0)
      expect(stdout).toBe(expected)
      expect(stderr).toBe('')
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('does not append a newline to authenticated PreToolUse decisions', async () => {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      const role = new URLSearchParams(body).get('hookRole')
      response.end(role === 'checkpoint' ? '{"decision":"deny","reason":"synthetic"}' : '{"decision":"ask"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  try {
    for (const scenario of [
      { role: undefined, expected: ANTIGRAVITY_PRE_TOOL_USE_DECISION },
      { role: 'checkpoint', expected: '{"decision":"deny","reason":"synthetic"}' }
    ]) {
      const child = spawnProcess({
        program: process.execPath,
        args: [script],
        env: {
          ...process.env,
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
          ORCA_PANE_KEY: 'proof-pane',
          ORCA_ANTIGRAVITY_EVENT: 'PreToolUse',
          ...(scenario.role ? { ORCA_AGENT_HOOK_ROLE: scenario.role } : {})
        }
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stdin.end('{}')
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      expect(exitCode).toBe(0)
      expect(stdout).toBe(scenario.expected)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('sends a hook PID ancestry hint with context events', async () => {
  const agentProcessHeaders: string[] = []
  const agentProcessBodyValues: string[] = []
  const server = createServer((request, response) => {
    const value = request.headers['x-orca-agent-process']
    if (typeof value === 'string') {
      agentProcessHeaders.push(value)
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      const bodyValue = new URLSearchParams(body).get('agentProcess')
      if (bodyValue) {
        agentProcessBodyValues.push(bodyValue)
      }
      response.end('{"injectSteps":[]}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  try {
    const child = spawnProcess({
      program: process.execPath,
      args: [script],
      env: {
        ...process.env,
        ORCA_AGENT_HOOK_PORT: String(address.port),
        ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
        ORCA_PANE_KEY: 'proof-pane',
        ORCA_TAB_ID: 'proof-tab',
        ORCA_AGENT_LAUNCH_TOKEN: 'proof-launch',
        ORCA_WORKTREE_ID: 'proof-worktree',
        ORCA_AGENT_HOOK_ENV: 'local',
        ORCA_AGENT_HOOK_VERSION: 'synthetic',
        ORCA_ANTIGRAVITY_EVENT: 'PreInvocation'
      }
    })
    child.stdin.end('{}')
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    expect(exitCode).toBe(0)
    expect(agentProcessHeaders).toHaveLength(1)
    expect(JSON.parse(agentProcessHeaders[0])).toEqual({
      hookPid: expect.any(Number),
      platform: process.platform
    })
    expect(agentProcessBodyValues).toEqual(agentProcessHeaders)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('delivers exact split UTF-8 JSON without EOF and bounds empty or partial input', async () => {
  const posts: URLSearchParams[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      posts.push(new URLSearchParams(body))
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  const env = {
    ...process.env,
    ORCA_AGENT_HOOK_PORT: String(address.port),
    ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
    ORCA_PANE_KEY: 'proof!pane',
    ORCA_ANTIGRAVITY_EVENT: 'PreInvocation'
  }
  const payload = JSON.stringify({
    message: '日本語 😀 café {"quoted"} \\ tail',
    transcript: 'x'.repeat(100_000)
  })
  try {
    for (const input of [payload, '', '{"partial":', '{} trailing-data']) {
      const child = spawnProcess({ program: process.execPath, args: [script], env })
      child.stdin.on('error', () => {})
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const timer = setTimeout(() => child.kill(), 9000)
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      const before = posts.length
      if (input) {
        const bytes = Buffer.from(input)
        const cut = bytes.indexOf(Buffer.from('日本語')) + 1
        child.stdin.write(bytes.subarray(0, Math.max(1, cut)))
        await new Promise((resolve) => setTimeout(resolve, 25))
        child.stdin.write(bytes.subarray(Math.max(1, cut)))
      }
      expect(await closed).toBe(0)
      clearTimeout(timer)
      child.stdin.destroy()
      expect(stdout).toBe('{}\n')
      expect(stderr).toBe('')
      expect(posts.slice(before)).toHaveLength(1)
      expect(posts[before].get('payload')).toBe(input || '{}')
      expect(posts[before].get('paneKey')).toBe('proof!pane')
      expect(posts[before].get('hook_event_name')).toBe('PreInvocation')
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 20_000)

it('returns a context delivery error when SessionStart has no listener', async () => {
  for (const eventName of ['SessionStart', 'PreInvocation']) {
    const child = spawnProcess({
      program: process.execPath,
      args: [script],
      env: {
        ...process.env,
        ORCA_AGENT_HOOK_PORT: '',
        ORCA_AGENT_HOOK_TOKEN: '',
        ORCA_PANE_KEY: 'proof-pane',
        ORCA_ANTIGRAVITY_EVENT: eventName
      }
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    child.stdin.end('{}')
    expect(await closed).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      injectSteps: [{ ephemeralMessage: expect.stringContaining('ORCA CHECKPOINT DELIVERY ERROR') }]
    })
  }
})

it('bounds oversized payloads, encoded bodies, absent endpoints and stalled HTTP', async () => {
  let requests = 0
  const server = createServer((request) => {
    requests++
    request.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  const env = {
    ...process.env,
    ORCA_AGENT_HOOK_PORT: String(address.port),
    ORCA_AGENT_HOOK_TOKEN: 'disposable-proof-token',
    ORCA_PANE_KEY: 'proof-pane',
    ORCA_ANTIGRAVITY_EVENT: 'PreInvocation'
  }
  try {
    for (const payloadCase of ['oversized', 'encoded-oversized', 'no-endpoint', 'hung-http']) {
      const before = requests
      const child = spawnProcess({
        program: process.execPath,
        args: [script],
        env: payloadCase === 'no-endpoint' ? { ...env, ORCA_AGENT_HOOK_PORT: '' } : env
      })
      child.stdin.on('error', () => {})
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      const timer = setTimeout(() => child.kill(), 4000)
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      if (payloadCase !== 'no-endpoint') {
        child.stdin.write(
          JSON.stringify({
            text:
              payloadCase === 'oversized'
                ? 'x'.repeat(1_000_001)
                : payloadCase === 'encoded-oversized'
                  ? '日'.repeat(150_000)
                  : 'hung-request'
          })
        )
      }
      expect(await closed, payloadCase).toBe(0)
      clearTimeout(timer)
      child.stdin.destroy()
      expect(output, payloadCase).toContain('ORCA CHECKPOINT DELIVERY ERROR')
      expect(requests - before, payloadCase).toBe(payloadCase === 'hung-http' ? 1 : 0)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15_000)
