import { record } from '../codex-rollout-jsonl-cursor'
import { parseAgentHookJson } from './request-body'
import { scanFileRegionsBackward } from './reverse-file-region-scan'
import { extractAssistantContentText, extractAssistantTextFromLine } from './transcript-entry-text'
import { TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_MAX_SCAN_BYTES } from './transcript-reader'

export function readTerminalFinalAnswer(
  source: 'codex' | 'claude',
  payload: Record<string, unknown>
): string | undefined {
  if (typeof payload.last_assistant_message === 'string') {
    return payload.last_assistant_message
  }
  const path = payload.transcript_path ?? payload.transcriptPath
  if (typeof path !== 'string' || !path) {
    return undefined
  }
  const answer = scanFileRegionsBackward(
    path,
    {
      chunkBytes: TRANSCRIPT_CHUNK_BYTES,
      maxScanBytes: TRANSCRIPT_MAX_SCAN_BYTES
    },
    (region): { text?: string } | undefined => {
      const lines = region.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index--) {
        let item: Record<string, unknown> | undefined
        try {
          item = record(parseAgentHookJson(lines[index]))
        } catch {
          continue
        }
        if (!item) {
          continue
        }
        if (source === 'claude') {
          if (item.type === 'user') {
            return {}
          }
          const text = extractAssistantTextFromLine(lines[index], true)
          if (text !== undefined) {
            return { text }
          }
        } else {
          const body = record(item.payload)
          if (!body) {
            continue
          }
          if (item.type === 'event_msg') {
            if (body.type === 'task_complete' || body.type === 'turn_complete') {
              if (typeof body.last_agent_message === 'string') {
                return { text: body.last_agent_message }
              }
            }
            if (
              body.type === 'task_started' ||
              body.type === 'turn_started' ||
              body.type === 'user_message'
            ) {
              return {}
            }
          }
          if (
            item.type === 'response_item' &&
            body.type === 'message' &&
            body.role === 'assistant' &&
            body.channel === 'final'
          ) {
            return { text: extractAssistantContentText(body.content, true) }
          }
        }
      }
      return undefined
    }
  )
  return answer?.text
}
