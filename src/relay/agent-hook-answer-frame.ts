import type { RelayDispatcher } from './dispatcher'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  type AgentHookRelayEnvelope
} from '../shared/agent-hook-relay'

export function fitTerminalAnswerFrame(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope
): { candidate: AgentHookRelayEnvelope; shedFields: string[] } {
  if (
    envelope.fullAssistantMessage !== undefined &&
    dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, envelope) < 0
  ) {
    return {
      candidate: { ...envelope, fullAssistantMessage: undefined },
      shedFields: ['fullAssistantMessage']
    }
  }
  return { candidate: envelope, shedFields: [] }
}
