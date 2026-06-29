export interface WorkflowStep {
  id: string
  run: () => Promise<unknown>
}

export interface Workflow {
  id: string
  steps: WorkflowStep[]
}

export function createWorkflow(id: string) {
  const steps: WorkflowStep[] = []

  return {
    step(step: WorkflowStep) {
      steps.push(step)
      return this
    },
    build(): Workflow {
      return Object.freeze({
        id,
        steps: Object.freeze([...steps]) as unknown as WorkflowStep[]
      })
    }
  }
}

export async function runWorkflow(workflow: Workflow) {
  const results: unknown[] = []

  for (const step of workflow.steps) {
    results.push(await step.run())
  }

  return results
}
