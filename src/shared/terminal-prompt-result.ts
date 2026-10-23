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
