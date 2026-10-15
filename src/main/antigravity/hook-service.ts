import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  getSharedManagedScriptPath,
  readHooksJson,
  wrapPosixHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT } from './windows-hook-json-post'
import {
  restoreManagedScript,
  refreshManagedScriptIfPresent,
  scriptStillExists
} from '../agent-hooks/managed-hook-script-refresh'
import {
  ANTIGRAVITY_EVENTS,
  ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME,
  ANTIGRAVITY_PRE_TOOL_USE_DECISION,
  type AntigravityEvent
} from './hook-events'
import {
  getAgentCheckpointToolMatcher,
  getAgentCheckpointUnavailableDecision
} from '../agent-checkpoint/agent-checkpoint-tool-policy'
import { quotePosixShellString } from '../agent-hooks/posix-hook-command'
import { getManagedScript, getWindowsWrapperScript } from './hook-script'
import {
  buildInstalledConfig,
  bundleHasStaleManagedCommand,
  createAntigravityManagedCommandMatcher,
  getBundle,
  hasManagedCommand,
  removeInstalledConfig
} from './hooks-json-bundle'

function getConfigPath(): string {
  // Why: Antigravity's hook docs define global hooks in ~/.gemini/config/hooks.json,
  // not in the CLI settings file used by Gemini CLI.
  return join(homedir(), '.gemini', 'config', 'hooks.json')
}

const CONTEXT_DELIVERY_ERROR = JSON.stringify({
  injectSteps: [
    {
      ephemeralMessage:
        'ORCA CHECKPOINT DELIVERY ERROR: the managed Antigravity hook script is missing; checkpoint text was not delivered.'
    }
  ]
})

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getWindowsWrapperScriptPath(event: AntigravityEvent, checkpointGate = false): string {
  if (checkpointGate) {
    return getSharedManagedScriptPath(ANTIGRAVITY_CHECKPOINT_GATE_WRAPPER_FILE_NAME)
  }
  return getSharedManagedScriptPath(event.windowsWrapperFileName)
}

function getPosixManagedCommand(
  scriptPath: string,
  event: AntigravityEvent,
  checkpointGate = false
): string {
  const command = wrapPosixHookCommand(
    scriptPath,
    { ORCA_ANTIGRAVITY_EVENT: event.eventName },
    event.eventName === 'PreToolUse'
      ? {
          fallbackStdout: checkpointGate
            ? getAgentCheckpointUnavailableDecision('antigravity')
            : ANTIGRAVITY_PRE_TOOL_USE_DECISION
        }
      : event.eventName === 'SessionStart' || event.eventName === 'PreInvocation'
        ? { fallbackStdout: CONTEXT_DELIVERY_ERROR, requiredEnvVar: 'ORCA_PANE_KEY' }
        : {}
  )
  // ACP hosts tokenize the command into argv; the shell must be the executable, not `if`.
  return `/bin/sh -c ${quotePosixShellString(
    `${checkpointGate ? 'ORCA_AGENT_HOOK_ROLE=checkpoint ' : ''}${command}`
  )}`
}

function getManagedCommand(
  scriptPath: string,
  event: AntigravityEvent,
  checkpointGate = false
): string {
  if (process.platform === 'win32') {
    return wrapWindowsBatchHookCommand(getWindowsWrapperScriptPath(event, checkpointGate))
  }
  return getPosixManagedCommand(scriptPath, event, checkpointGate)
}

export class AntigravityHookService {
  private getWindowsRuntimePath = (): string => process.execPath

  setWindowsRuntimePathProvider(provider: () => string): void {
    this.getWindowsRuntimePath = provider
  }

  async refreshManagedScripts(): Promise<void> {
    const runtimePath = process.platform === 'win32' ? this.getWindowsRuntimePath() : undefined
    if (process.platform === 'win32' && (await scriptStillExists(getManagedScriptPath()))) {
      await restoreManagedScript(
        getSharedManagedScriptPath('antigravity-hook-post.cjs'),
        WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT
      )
      for (const event of ANTIGRAVITY_EVENTS) {
        await refreshManagedScriptIfPresent(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
      const preToolUseEvent = ANTIGRAVITY_EVENTS.find((event) => event.eventName === 'PreToolUse')
      if (preToolUseEvent) {
        await refreshManagedScriptIfPresent(
          getWindowsWrapperScriptPath(preToolUseEvent, true),
          getWindowsWrapperScript('PreToolUse', 'checkpoint')
        )
      }
    }
    await refreshManagedScriptIfPresent(
      getManagedScriptPath(),
      getManagedScript('local', runtimePath)
    )
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    const bundle = getBundle(config)
    const isManagedCommand = createAntigravityManagedCommandMatcher()
    const preToolUseEvent = ANTIGRAVITY_EVENTS.find((event) => event.eventName === 'PreToolUse')
    const matcher = getAgentCheckpointToolMatcher('antigravity')
    const gateCommand = preToolUseEvent && matcher
      ? getManagedCommand(scriptPath, preToolUseEvent, true)
      : null
    const currentCommands = new Set([
      ...ANTIGRAVITY_EVENTS.map((event) => getManagedCommand(scriptPath, event)),
      ...(gateCommand ? [gateCommand] : [])
    ])
    const staleManagedPresent = bundleHasStaleManagedCommand(
      bundle,
      isManagedCommand,
      currentCommands
    )
    const missing: string[] = []
    let presentCount = 0
    for (const event of ANTIGRAVITY_EVENTS) {
      const definitions = Array.isArray(bundle[event.eventName])
        ? (bundle[event.eventName] as HookDefinition[])
        : []
      if (hasManagedCommand(definitions, getManagedCommand(scriptPath, event))) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
      }
    }
    const preToolUseDefinitions = hookDefinitions(bundle.PreToolUse)
    const gatePresent = gateCommand !== null && matcher !== null &&
      preToolUseDefinitions.some(
        (definition) =>
          definition.matcher === matcher &&
          Array.isArray(definition.hooks) &&
          definition.hooks.some((hook) => hook.command === gateCommand)
      )
    if (!gatePresent) {
      missing.push('PreToolUse checkpoint gate')
    }

    const managedHooksPresent = presentCount > 0 || gatePresent || staleManagedPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0 && !staleManagedPresent) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0 && !staleManagedPresent) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail =
        missing.length > 0
          ? `Managed hook missing for events: ${missing.join(', ')}`
          : 'Stale managed hook entries need cleanup'
    }
    return { agent: 'antigravity', state, configPath, managedHooksPresent, detail }
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    buildInstalledConfig(
      config,
      (event) => getManagedCommand(scriptPath, event),
      createAntigravityManagedCommandMatcher(),
      (() => {
        const matcher = getAgentCheckpointToolMatcher('antigravity')
        const event = ANTIGRAVITY_EVENTS.find((item) => item.eventName === 'PreToolUse')
        return matcher && event
          ? { matcher, command: getManagedCommand(scriptPath, event, true) }
          : undefined
      })()
    )
    const runtimePath = process.platform === 'win32' ? this.getWindowsRuntimePath() : undefined
    if (process.platform === 'win32') {
      writeManagedScript(
        getSharedManagedScriptPath('antigravity-hook-post.cjs'),
        WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT
      )
    }
    writeManagedScript(scriptPath, getManagedScript('local', runtimePath))
    if (process.platform === 'win32') {
      // Why: Antigravity wraps hook commands in cmd.exe. Keeping event env
      // setup inside event-specific .cmd files avoids nested hooks.json quotes.
      for (const event of ANTIGRAVITY_EVENTS) {
        writeManagedScript(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
      const preToolUseEvent = ANTIGRAVITY_EVENTS.find((event) => event.eventName === 'PreToolUse')
      if (preToolUseEvent) {
        writeManagedScript(
          getWindowsWrapperScriptPath(preToolUseEvent, true),
          getWindowsWrapperScript('PreToolUse', 'checkpoint')
        )
      }
    }
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.gemini/config/hooks.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/antigravity-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'antigravity',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Antigravity hooks.json'
        }
      }

      buildInstalledConfig(
        config,
        (event) => getPosixManagedCommand(remoteScriptPath, event),
        createAntigravityManagedCommandMatcher(),
        (() => {
          const matcher = getAgentCheckpointToolMatcher('antigravity')
          const event = ANTIGRAVITY_EVENTS.find((item) => item.eventName === 'PreToolUse')
          return matcher && event
            ? { matcher, command: getPosixManagedCommand(remoteScriptPath, event, true) }
            : undefined
        })()
      )
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'antigravity',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    removeInstalledConfig(config)
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

function hookDefinitions(value: unknown): HookDefinition[] {
  return Array.isArray(value)
    ? value.filter((item): item is HookDefinition =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
      )
    : []
}

export const antigravityHookService = new AntigravityHookService()
