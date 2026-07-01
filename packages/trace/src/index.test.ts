import { describe, expect, it } from 'vitest'
import { createMemoryTraceSink } from './index'

describe('createMemoryTraceSink', () => {
  it('collects emitted events in order', () => {
    const sink = createMemoryTraceSink()

    sink.emit({ type: 'runtime:start', timestamp: 1, runId: 'r1' })
    sink.emit({ type: 'tool:start', timestamp: 2, runId: 'r1', data: { toolId: 't' } })
    sink.emit({ type: 'runtime:end', timestamp: 3, runId: 'r1' })

    expect(sink.events.map((e) => e.type)).toEqual([
      'runtime:start',
      'tool:start',
      'runtime:end'
    ])
    expect(sink.events[1].data).toEqual({ toolId: 't' })
  })

  it('starts empty', () => {
    expect(createMemoryTraceSink().events).toEqual([])
  })
})
