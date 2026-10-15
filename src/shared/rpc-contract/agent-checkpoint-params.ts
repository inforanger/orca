import { z } from 'zod'

const checkpointText = z.string().trim().min(1).max(8_192)
const sessionKey = z.string().trim().min(1).max(512)

export const AgentCheckpointApplicationParams = z
  .object({
    checkpointSha256: z.string().regex(/^[a-f\d]{64}$/i),
    taskId: sessionKey,
    taskSummary: checkpointText,
    lessonsSearch: checkpointText,
    why: z.array(checkpointText).min(3).max(12),
    approachA: z
      .object({
        method: checkpointText,
        workload: checkpointText,
        remainingProblem: checkpointText
      })
      .strict(),
    approachB: z
      .object({
        method: checkpointText,
        workload: checkpointText,
        solvedProblem: checkpointText,
        feasible: z.boolean(),
        infeasibleReason: z.string().max(8_192)
      })
      .strict(),
    userRequestedApproachA: z.boolean(),
    selectedApproach: z.enum(['A', 'B']),
    selectionReason: checkpointText,
    rootCause: checkpointText,
    resolution: checkpointText,
    verification: checkpointText,
    reuseCheck: checkpointText,
    architectureCheck: checkpointText,
    errorPatternReview: checkpointText,
    shortcutReview: checkpointText
  })
  .strict()

export const AgentCheckpointIdentityParams = z
  .object({
    paneKey: sessionKey,
    launchToken: sessionKey.optional(),
    agentId: sessionKey.optional()
  })
  .strict()

export const AgentCheckpointContextParams = AgentCheckpointIdentityParams.extend({
  taskId: sessionKey.optional(),
  taskSummary: z.string().trim().max(8_192).optional()
}).strict()

export const AgentCheckpointApplyParams = AgentCheckpointIdentityParams.extend({
  application: AgentCheckpointApplicationParams
}).strict()
