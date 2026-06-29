export type TraceEventType =
  | 'runtime:start'
  | 'runtime:end'
  | 'tool:start'
  | 'tool:end'
  | 'tool:error'
  | 'runtime:error'

export interface TraceEvent {
  type: TraceEventType
  timestamp: number
  runId: string
  data?: Record<string, unknown>
}

export interface TraceSink {
  emit(event: TraceEvent): void
}

export function createMemoryTraceSink(): TraceSink & { events: TraceEvent[] } {
  const events: TraceEvent[] = []
  return {
    events,
    emit(event) {
      events.push(event)
    }
  }
}
