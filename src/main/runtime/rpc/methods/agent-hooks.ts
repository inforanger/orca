import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-status-hooks-setting'
import { prepareManagedWslCodexHomeBeforeShellLaunch } from '../../../codex/managed-wsl-home-shell-preflight'
import { defineMethod } from '../core'
import {
  PrepareCodexForWslPaneParams
} from '../../../../shared/rpc-contract/agent-hooks-params'
import {
  AgentCheckpointApplyParams,
  AgentCheckpointContextParams
} from '../../../../shared/rpc-contract/agent-checkpoint-params'
import {
  loadAgentCheckpoint,
  renderAgentCheckpointContext
} from '../../../agent-checkpoint/agent-checkpoint'
import { agentCheckpointReadiness } from '../../../agent-checkpoint/agent-checkpoint-readiness'

function requireCheckpointCli(clientKind: string | undefined): void {
  if (clientKind !== undefined) {
    throw new Error('Checkpoint context and application are only available to the local Orca CLI.')
  }
}

function checkpointTaskId(params: {
  taskId?: string
  launchToken?: string
  paneKey: string
}): string {
  return params.taskId?.trim() || params.launchToken?.trim() || params.paneKey.trim()
}

export const AGENT_HOOK_METHODS = [
  defineMethod({
    name: 'agentHooks.checkpointContext',
    permission: 'workspace',
    params: AgentCheckpointContextParams,
    handler: async (params, { clientKind }) => {
      requireCheckpointCli(clientKind)
      const checkpoint = await loadAgentCheckpoint()
      const taskId = checkpointTaskId(params)
      const taskSummary = params.taskSummary?.trim() ||
        (params.agentId
          ? 'The provider did not include this child task description; use its assigned task prompt.'
          : 'Apply CHECKPOINT.md to the current user task in this Orca session.')
      const identity = {
        paneKey: params.paneKey,
        ...(params.launchToken ? { launchToken: params.launchToken } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {})
      }
      const registered = agentCheckpointReadiness.beginContext(
        identity,
        taskId,
        taskSummary,
        checkpoint
      )
      if (!registered) {
        throw new Error(`Could not register checkpoint session ${params.paneKey}.`)
      }
      return {
        taskId,
        checkpointSha256: checkpoint.sha256,
        context: renderAgentCheckpointContext(
          checkpoint,
          {
            ...registered,
            ...(params.agentId ? { agentId: params.agentId } : {})
          }
        )
      }
    }
  }),
  defineMethod({
    name: 'agentHooks.checkpointApply',
    permission: 'workspace',
    params: AgentCheckpointApplyParams,
    handler: async (params, { clientKind }) => {
      requireCheckpointCli(clientKind)
      const checkpoint = await loadAgentCheckpoint()
      return agentCheckpointReadiness.apply(
        {
          paneKey: params.paneKey,
          ...(params.launchToken ? { launchToken: params.launchToken } : {}),
          ...(params.agentId ? { agentId: params.agentId } : {})
        },
        params.application,
        checkpoint
      )
    }
  }),
  defineMethod({
    name: 'agentHooks.prepareCodexForWslPane',
    permission: 'workspace',
    params: PrepareCodexForWslPaneParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Codex hook preparation is only available to the local Orca CLI.')
      }
      return await prepareManagedWslCodexHomeBeforeShellLaunch({
        env: {
          CODEX_HOME: params.codexHome,
          ORCA_CODEX_HOME: params.orcaCodexHome,
          WSL_DISTRO_NAME: params.wslDistro
        },
        hooksEnabled: isAgentStatusHooksEnabledForAgent(runtime.getClientSettings(), 'codex')
      })
    }
  })
]
