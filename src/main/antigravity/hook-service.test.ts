import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import { AntigravityHookService } from './hook-service'
import { POSIX_HOOK_JSON_STDIN_READER } from '../agent-hooks/hook-stdin-contract'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME,
  ANTIGRAVITY_PRE_TOOL_USE_DECISION
} from './hook-events'
import { getAgentCheckpointToolMatcher } from '../agent-checkpoint/agent-checkpoint-tool-policy'

const ANTIGRAVITY_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_PRE_INVOCATION_COMMAND =
  process.platform === 'win32' ? 'antigravity-pre-invocation.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_SESSION_START_COMMAND =
  process.platform === 'win32' ? 'antigravity-session-start.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_POST_TOOL_USE_COMMAND =
  process.platform === 'win32' ? 'antigravity-post-tool-use.cmd' : 'antigravity-hook.sh'
const ANTIGRAVITY_PRE_TOOL_USE_COMMAND =
  process.platform === 'win32' ? 'antigravity-pre-tool-use.cmd' : 'antigravity-hook.sh'
const PRE_TOOL_USE_DECISION = ANTIGRAVITY_PRE_TOOL_USE_DECISION
const UNSUPPORTED_POLICY_DECISIONS = ['force_ask', 'deny_unless_prior_grant']

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('AntigravityHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-antigravity-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs Antigravity global hooks.json bundle and managed script', () => {
    const status = new AntigravityHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(homeDir, '.gemini', 'config', 'hooks.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
    ) as {
      'orca-status': Record<
        string,
        { matcher?: string; command?: string; hooks?: { command: string }[] }[]
      >
    }
    expect(Object.keys(config['orca-status']).sort()).toEqual(
      ['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'SessionStart', 'Stop'].sort()
    )
    expect(config['orca-status'].PreToolUse[0].matcher).toBe('*')
    expect(config['orca-status'].PreToolUse[0].hooks?.[0]?.command).toContain(
      ANTIGRAVITY_PRE_TOOL_USE_COMMAND
    )
    expect(config['orca-status'].PostToolUse[0].matcher).toBe('*')
    expect(config['orca-status'].PreInvocation[0].command).toContain(
      ANTIGRAVITY_PRE_INVOCATION_COMMAND
    )
    expect(config['orca-status'].SessionStart[0].command).toContain(
      ANTIGRAVITY_SESSION_START_COMMAND
    )
    if (process.platform === 'win32') {
      expect(config['orca-status'].PreInvocation[0].command).not.toContain('ORCA_ANTIGRAVITY_EVENT')
      expect(config['orca-status'].SessionStart[0].command).not.toContain('ORCA_ANTIGRAVITY_EVENT')
    } else {
      expect(
        tokenizeCommandLine(config['orca-status'].PreInvocation[0].command ?? '')[2]
      ).toContain("ORCA_ANTIGRAVITY_EVENT='PreInvocation'")
      expect(tokenizeCommandLine(config['orca-status'].SessionStart[0].command ?? '')[2]).toContain(
        "ORCA_ANTIGRAVITY_EVENT='SessionStart'"
      )
      expect(tokenizeCommandLine(config['orca-status'].Stop[0].command ?? '')[2]).toContain(
        "ORCA_ANTIGRAVITY_EVENT='Stop'"
      )
    }

    const script = readFileSync(
      join(homeDir, '.orca', 'agent-hooks', ANTIGRAVITY_SCRIPT_FILE_NAME),
      'utf8'
    )
    expect(script).toContain(
      process.platform === 'win32' ? 'antigravity-hook-post.cjs' : '/hook/antigravity'
    )
    if (process.platform === 'win32') {
      expect(script).not.toContain('powershell.exe')
      expect(script).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(
        readFileSync(join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook-post.cjs'), 'utf8')
      ).toContain('/hook/antigravity')
      // Why (#9358/#9941): delayed expansion eats `!` out of percent-expanded curl args.
      expect(script).toContain('setlocal DisableDelayedExpansion')
    } else {
      expect(script).toContain('hook_event_name=${ORCA_ANTIGRAVITY_EVENT}')
      expect(script).toContain(`payload=$(${POSIX_HOOK_JSON_STDIN_READER})`)
      expect(script).toContain("payload='{}'")
      expect(script).not.toContain('if [ -z "$payload" ]; then\n  exit 0\nfi')
      // Why: payload is piped to curl via stdin (`payload@-`) so it never lands
      // on the curl command line (EDR oversized-command-line false positive).
      expect(script).toContain('printf \'%s\' "$payload" | curl')
      expect(script).toContain('--data-urlencode "payload@-"')
      expect(script).not.toContain('--data-urlencode "payload=${payload}"')
    }
    if (process.platform === 'win32') {
      const postScript = readFileSync(
        join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook-post.cjs'),
        'utf8'
      )
      expect(postScript).toContain('{"decision":""}')
    } else {
      expect(script).toContain('Stop) printf')
    }
    expect(script).toContain(PRE_TOOL_USE_DECISION)
    expect(script).toContain('"decision":"deny"')
    expect(script).toContain(
      'ORCA CHECKPOINT DELIVERY ERROR: the authenticated hook endpoint is unavailable; this classified tool is blocked until checkpoint readiness can be verified.'
    )
    for (const decision of UNSUPPORTED_POLICY_DECISIONS) {
      expect(script).not.toContain(`{"decision":"${decision}"}`)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'reports unsupported checkpoint enforcement through the PreToolUse ask fallback',
    () => {
      new AntigravityHookService().install()

      const result = spawnSync(
        '/bin/sh',
        [join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook.sh')],
        {
          env: {
            ...process.env,
            ORCA_ANTIGRAVITY_EVENT: 'PreToolUse',
            ORCA_AGENT_HOOK_ENDPOINT: '',
            ORCA_AGENT_HOOK_PORT: '',
            ORCA_AGENT_HOOK_TOKEN: '',
            ORCA_PANE_KEY: ''
          },
          input: '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}',
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      // Why: Antigravity reads silence/`{}` on PreToolUse as a deny (#2426), so the exact payload is the contract.
      expect(result.stdout).toBe(`${PRE_TOOL_USE_DECISION}\n`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps answering the PreToolUse gate when the managed script is missing',
    () => {
      new AntigravityHookService().install()
      rmSync(join(homeDir, '.orca', 'agent-hooks'), { recursive: true, force: true })

      const config = JSON.parse(
        readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
      ) as { 'orca-status': Record<string, { hooks?: { command: string }[] }[]> }
      const command = config['orca-status'].PreToolUse[0].hooks?.[0]?.command

      const result = spawnSync('/bin/sh', ['-c', command!], {
        input: '{"toolCall":{"name":"run_command"}}',
        encoding: 'utf8'
      })

      // Why: hooks.json lives in ~/.gemini and outlives ~/.orca, so a swept script must not deny every tool call.
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${PRE_TOOL_USE_DECISION}\n`)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports missing context delivery on context hooks when the managed script is missing',
    () => {
      new AntigravityHookService().install()
      rmSync(join(homeDir, '.orca', 'agent-hooks'), { recursive: true, force: true })

      const config = JSON.parse(
        readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
      ) as {
        'orca-status': Record<string, { command?: string; hooks?: { command: string }[] }[]>
      }
      const postToolUse = config['orca-status'].PostToolUse[0].hooks?.[0]?.command
      const preInvocation = config['orca-status'].PreInvocation[0].command
      const sessionStart = config['orca-status'].SessionStart[0].command

      const postToolResult = spawnSync('/bin/sh', ['-c', postToolUse!], {
        input: '{}',
        encoding: 'utf8'
      })
      expect(postToolResult.status).toBe(0)
      expect(postToolResult.stdout).toBe('')
      const preInvocationResult = spawnSync('/bin/sh', ['-c', preInvocation!], {
        input: '{}',
        env: { ...process.env, ORCA_PANE_KEY: 'test-pane' },
        encoding: 'utf8'
      })
      expect(preInvocationResult.status).toBe(0)
      expect(preInvocationResult.stdout).toContain('"ephemeralMessage"')
      expect(preInvocationResult.stdout).toContain('ORCA CHECKPOINT DELIVERY ERROR')

      const sessionStartResult = spawnSync('/bin/sh', ['-c', sessionStart!], {
        input: '{}',
        env: { ...process.env, ORCA_PANE_KEY: 'test-pane' },
        encoding: 'utf8'
      })
      expect(sessionStartResult.status).toBe(0)
      expect(sessionStartResult.stdout).toContain('"ephemeralMessage"')
      expect(sessionStartResult.stdout).toContain('ORCA CHECKPOINT DELIVERY ERROR')
    }
  )

  it('installs Windows event wrappers without nested cmd quoting and replaces stale PreToolUse hooks', () => {
    withPlatform('win32', () => {
      const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
      const staleScriptPath = join(
        homeDir,
        '.orca',
        'agent-hooks',
        'antigravity-hook.cmd'
      ).replaceAll('/', '\\')
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            'orca-status': {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: `cmd /d /s /c "set "ORCA_ANTIGRAVITY_EVENT=PreToolUse" && call "${staleScriptPath}""`
                    }
                  ]
                }
              ]
            }
          },
          null,
          2
        )}\n`
      )

      const service = new AntigravityHookService()
      const staleStatus = service.getStatus()
      expect(staleStatus.state).toBe('partial')
      expect(staleStatus.managedHooksPresent).toBe(true)

      const status = service.install()

      expect(status.state).toBe('installed')

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        'orca-status': Record<
          string,
          { matcher?: string; command?: string; hooks?: { command: string }[] }[]
        >
      }
      expect(config['orca-status'].PreToolUse).toHaveLength(2)
      expect(config['orca-status'].PreToolUse[0].matcher).toBe('*')
      expect(config['orca-status'].PreToolUse[1].matcher).toBe(
        getAgentCheckpointToolMatcher('antigravity')
      )

      const expectedWrappers = {
        SessionStart: 'antigravity-session-start.cmd',
        PreInvocation: 'antigravity-pre-invocation.cmd',
        PostInvocation: 'antigravity-post-invocation.cmd',
        Stop: 'antigravity-stop.cmd',
        PreToolUse: 'antigravity-pre-tool-use.cmd',
        PostToolUse: 'antigravity-post-tool-use.cmd'
      }
      for (const [eventName, wrapperFileName] of Object.entries(expectedWrappers)) {
        const definition = config['orca-status'][eventName][0]
        const command = ['PreToolUse', 'PostToolUse'].includes(eventName)
          ? definition.hooks?.[0]?.command
          : definition.command
        expect(createManagedCommandMatcher(wrapperFileName)(command)).toBe(true)
        expect(command).not.toContain('cmd /d /s /c')
        expect(command).not.toContain('ORCA_ANTIGRAVITY_EVENT')

        const wrapper = readFileSync(join(homeDir, '.orca', 'agent-hooks', wrapperFileName), 'utf8')
        expect(wrapper).toContain(`set "ORCA_ANTIGRAVITY_EVENT=${eventName}"`)
        expect(wrapper).toContain('call "%ORCA_ANTIGRAVITY_CORE%"')
        // Why: the wrapper is the stdin owner when the core script is gone, so preserve its normal ask decision.
        if (eventName === 'PreToolUse') {
          expect(wrapper).toContain(`echo ${PRE_TOOL_USE_DECISION}`)
        }
        for (const decision of UNSUPPORTED_POLICY_DECISIONS) {
          expect(wrapper).not.toContain(`{"decision":"${decision}"}`)
        }
      }

      const checkpointGateWrapper = readFileSync(
        join(homeDir, '.orca', 'agent-hooks', ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME),
        'utf8'
      )
      expect(checkpointGateWrapper).toContain(
        'echo {"decision":"deny","reason":"ORCA CHECKPOINT DELIVERY ERROR:'
      )

      const script = readFileSync(
        join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook.cmd'),
        'utf8'
      )
      expect(script).toContain('antigravity-hook-post.cjs')
      expect(script).not.toContain('powershell.exe')
      expect(script).toContain('ELECTRON_RUN_AS_NODE=1')
      expect(
        readFileSync(join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook-post.cjs'), 'utf8')
      ).toContain('/hook/antigravity')
      expect(script).toContain('setlocal DisableDelayedExpansion')
    })
  })

  it('preserves the installed core and config when publishing the Windows reader fails', () => {
    withPlatform('win32', () => {
      const service = new AntigravityHookService()
      expect(service.install().state).toBe('installed')
      const hookDir = join(homeDir, '.orca', 'agent-hooks')
      const readerPath = join(hookDir, 'antigravity-hook-post.cjs')
      const corePath = join(hookDir, 'antigravity-hook.cmd')
      const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
      writeFileSync(corePath, 'previous installed core')
      const previousConfig = readFileSync(configPath, 'utf8')
      rmSync(readerPath)
      mkdirSync(readerPath)

      expect(() => service.install()).toThrow()
      expect(readFileSync(corePath, 'utf8')).toBe('previous installed core')
      expect(readFileSync(configPath, 'utf8')).toBe(previousConfig)
    })
  })

  it('restores the owned Windows reader and resolves the current runtime on refresh', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const service = new AntigravityHookService()
      let runtimePath = 'C:\\Orca1\\Orca.exe'
      service.setWindowsRuntimePathProvider(() => runtimePath)
      const readerPath = join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook-post.cjs')
      await service.refreshManagedScripts()
      expect(existsSync(readerPath)).toBe(false)
      expect(service.install().state).toBe('installed')
      rmSync(readerPath)
      runtimePath = 'C:\\Orca2\\Orca.exe'
      await service.refreshManagedScripts()
      expect(readFileSync(readerPath, 'utf8')).toContain("require('node:string_decoder')")
      expect(
        readFileSync(join(homeDir, '.orca', 'agent-hooks', 'antigravity-hook.cmd'), 'utf8')
      ).toContain('ORCA_AGENT_HOOK_NODE=C:\\Orca2\\Orca.exe')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('preserves user-authored hook bundles and entries in Orca bundle', () => {
    const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          'user-hook': {
            PreInvocation: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
          },
          'orca-status': {
            PreInvocation: [{ type: 'command', command: '/usr/local/bin/orca-extra' }]
          }
        },
        null,
        2
      )}\n`
    )

    new AntigravityHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      'user-hook': { PreInvocation: { command: string }[] }
      'orca-status': { PreInvocation: { command: string }[] }
    }
    expect(config['user-hook'].PreInvocation[0].command).toBe('/usr/local/bin/user-hook')
    const commands = config['orca-status'].PreInvocation.map((entry) => entry.command)
    expect(commands).toContain('/usr/local/bin/orca-extra')
    expect(commands.some((command) => command.includes(ANTIGRAVITY_PRE_INVOCATION_COMMAND))).toBe(
      true
    )
  })

  it('removes stale managed Antigravity hook entries from retired events', () => {
    const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          'orca-status': {
            OldEvent: [
              {
                type: 'command',
                command: '/tmp/old/agent-hooks/antigravity-hook.sh'
              }
            ],
            PreToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: '/tmp/old/agent-hooks/antigravity-hook.sh' }]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    new AntigravityHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      'orca-status': Record<
        string,
        { matcher?: string; command?: string; hooks?: { command: string }[] }[]
      >
    }
    expect(config['orca-status'].OldEvent).toBeUndefined()
    // Why: the pre-a480e6b7 PreToolUse entry pointed at a script with no gate branch; it must be replaced, not kept.
    const preToolCommands = config['orca-status'].PreToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(preToolCommands).toHaveLength(2)
    const statusPreTool = config['orca-status'].PreToolUse.find(
      (definition) => definition.matcher === '*'
    )
    const checkpointPreTool = config['orca-status'].PreToolUse.find(
      (definition) => definition.matcher !== '*'
    )
    expect(statusPreTool?.hooks?.[0]?.command).toContain(
      join(homeDir, '.orca', 'agent-hooks', ANTIGRAVITY_PRE_TOOL_USE_COMMAND).replaceAll('\\', '/')
    )
    expect(checkpointPreTool?.matcher).toBe(getAgentCheckpointToolMatcher('antigravity'))
    expect(preToolCommands).not.toContain('/tmp/old/agent-hooks/antigravity-hook.sh')
    const commands = config['orca-status'].PostToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(
      join(homeDir, '.orca', 'agent-hooks', ANTIGRAVITY_POST_TOOL_USE_COMMAND).replaceAll('\\', '/')
    )
  })

  it('replaces legacy backslash Windows entries and keeps user hooks', () => {
    withPlatform('win32', () => {
      const configPath = join(homeDir, '.gemini', 'config', 'hooks.json')
      // The pre-forward-slash bare paths: Git Bash strips their backslashes and exits 127.
      const legacyStop = 'C:\\Users\\ada\\.orca\\agent-hooks\\antigravity-stop.cmd'
      const legacyPreToolUse = 'C:\\Users\\ada\\.orca\\agent-hooks\\antigravity-pre-tool-use.cmd'
      const userHook = { type: 'command', command: 'C:\\tools\\user-hook.cmd' }
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(
        configPath,
        `${JSON.stringify({
          'orca-status': {
            Stop: [{ type: 'command', command: legacyStop }, userHook],
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: legacyPreToolUse }] }]
          }
        })}\n`
      )

      const service = new AntigravityHookService()
      expect(service.getStatus().state).toBe('partial')
      expect(service.install().state).toBe('installed')

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        'orca-status': Record<string, { command?: string; hooks?: { command: string }[] }[]>
      }
      const [keptUserHook, stop] = config['orca-status'].Stop
      expect(config['orca-status'].Stop).toHaveLength(2)
      expect(keptUserHook).toEqual(userHook)
      expect(stop.command).not.toBe(legacyStop)
      expect(createManagedCommandMatcher('antigravity-stop.cmd')(stop.command)).toBe(true)
      const preToolUse = config['orca-status'].PreToolUse.flatMap((d) => d.hooks ?? [])
      expect(preToolUse).toHaveLength(2)
      expect(preToolUse[0].command).not.toBe(legacyPreToolUse)
      expect(preToolUse[1].command).toContain(ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME)
    })
  })
})
