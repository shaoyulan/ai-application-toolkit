import { describe, expect, it } from 'vitest'
import { createWorkflow, runWorkflow } from './index'

describe('createWorkflow', () => {
  it('builds a frozen workflow with the given steps', () => {
    const workflow = createWorkflow('flow')
      .step({ id: 's1', run: async () => 1 })
      .step({ id: 's2', run: async () => 2 })
      .build()

    expect(workflow.id).toBe('flow')
    expect(workflow.steps).toHaveLength(2)
    expect(Object.isFrozen(workflow.steps)).toBe(true)
  })
})

describe('runWorkflow', () => {
  it('runs steps in order and collects their results', async () => {
    const order: string[] = []
    const workflow = createWorkflow('flow')
      .step({
        id: 's1',
        run: async () => {
          order.push('s1')
          return 'a'
        }
      })
      .step({
        id: 's2',
        run: async () => {
          order.push('s2')
          return 'b'
        }
      })
      .build()

    const results = await runWorkflow(workflow)

    expect(order).toEqual(['s1', 's2'])
    expect(results).toEqual(['a', 'b'])
  })

  it('passes the previous result and all prior results to each step', async () => {
    const seen: WorkflowSnapshot[] = []
    const workflow = createWorkflow('flow')
      .step({ id: 's1', run: () => 1 })
      .step({
        id: 's2',
        run: ({ previous, results }) => {
          seen.push({ previous, results: [...results] })
          return (previous as number) + 1
        }
      })
      .step({
        id: 's3',
        run: ({ previous, results }) => {
          seen.push({ previous, results: [...results] })
          return (previous as number) + 1
        }
      })
      .build()

    const results = await runWorkflow(workflow)

    expect(results).toEqual([1, 2, 3])
    expect(seen[0]).toEqual({ previous: 1, results: [1] })
    expect(seen[1]).toEqual({ previous: 2, results: [1, 2] })
  })

  it('supports synchronous step functions', async () => {
    const workflow = createWorkflow('flow').step({ id: 's1', run: () => 'sync' }).build()
    expect(await runWorkflow(workflow)).toEqual(['sync'])
  })

  it('wraps a failing step in WORKFLOW_STEP_FAILED with the step id', async () => {
    const workflow = createWorkflow('flow')
      .step({ id: 'ok', run: () => 1 })
      .step({
        id: 'bad',
        run: () => {
          throw new Error('boom')
        }
      })
      .build()

    await expect(runWorkflow(workflow)).rejects.toMatchObject({
      code: 'WORKFLOW_STEP_FAILED',
      message: expect.stringContaining('flow -> bad')
    })
  })

  it('stops at the first failing step', async () => {
    let ran = false
    const workflow = createWorkflow('flow')
      .step({
        id: 'bad',
        run: () => {
          throw new Error('boom')
        }
      })
      .step({
        id: 'never',
        run: () => {
          ran = true
          return 1
        }
      })
      .build()

    await expect(runWorkflow(workflow)).rejects.toBeDefined()
    expect(ran).toBe(false)
  })
})

interface WorkflowSnapshot {
  previous: unknown
  results: unknown[]
}
