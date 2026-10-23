export type TerminalPromptCompletion = {
  requestId: string
  terminal: string
  processIncarnation: string
  generation: number
  turnId: string
  /** Turn termination; `done` does not assert that the user's task succeeded. */
  status: 'done' | 'error' | 'interrupted'
  completedAt: number
  answerLength: number
  answerSha256: string
  answerComplete: boolean
  reason?: string
}

export type TerminalPromptResult = {
  state: 'pending' | 'completed' | 'unavailable'
  completion?: TerminalPromptCompletion
  answer?: { text: string; offset: number; nextOffset: number | null }
}

export type TerminalCompletion = Omit<TerminalPromptCompletion, 'requestId'> & {
  origin: 'bridge_request' | 'direct_user' | 'unknown'
  requestId?: string
}

export type TerminalLastCompletion = {
  state: 'completed' | 'unavailable'
  currentTurn: { state: 'running' | 'idle' | 'unknown'; turnId?: string }
  completion?: TerminalCompletion
  answer?: { text: string; offset: number; nextOffset: number | null }
}
