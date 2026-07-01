import { ToolkitError } from '@ai-application-toolkit/core'

export interface WorkflowStepContext {
  /** Result of the immediately preceding step (undefined for the first step). */
  previous: unknown
  /** Results of all preceding steps, in order. */
  results: readonly unknown[]
}

export interface WorkflowStep {
  id: string
  run: (context: WorkflowStepContext) => Promise<unknown> | unknown
}

export interface Workflow {
  id: string
  steps: WorkflowStep[]
}

export function createWorkflow(id: string) {
  const steps: WorkflowStep[] = []

  const builder = {
    step(step: WorkflowStep) {
      steps.push(step)
      return builder
    },
    build(): Workflow {
      return Object.freeze({
        id,
        steps: Object.freeze([...steps]) as unknown as WorkflowStep[]
      })
    }
  }

  return builder
}

export async function runWorkflow(workflow: Workflow): Promise<unknown[]> {
  const results: unknown[] = []

  for (const step of workflow.steps) {
    try {
      const result = await step.run({
        previous: results[results.length - 1],
        results: [...results]
      })
      results.push(result)
    } catch (cause) {
      throw new ToolkitError({
        code: 'WORKFLOW_STEP_FAILED',
        message: `Workflow step failed: ${workflow.id} -> ${step.id}`,
        cause
      })
    }
  }

  return results
}
