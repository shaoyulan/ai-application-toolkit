import { ToolkitError } from '@ai-application-toolkit/core'
import type { ToolDefinition } from '@ai-application-toolkit/tool'
import type { TraceSink } from '@ai-application-toolkit/trace'

export interface RuntimeOptions {
  tools?: ToolDefinition[]
  trace?: TraceSink
}

export interface ExecuteToolInput {
  toolId: string
  input: unknown
  runId?: string
}

export function createRuntime(options: RuntimeOptions = {}) {
  const tools = new Map((options.tools ?? []).map((tool) => [tool.id, tool]))

  async function executeTool({ toolId, input, runId = crypto.randomUUID() }: ExecuteToolInput) {
    const tool = tools.get(toolId)

    if (!tool) {
      throw new ToolkitError({
        code: 'TOOL_NOT_FOUND',
        message: `Tool not found: ${toolId}`
      })
    }

    options.trace?.emit({
      type: 'tool:start',
      timestamp: Date.now(),
      runId,
      data: { toolId }
    })

    try {
      const output = await tool.execute(input)

      options.trace?.emit({
        type: 'tool:end',
        timestamp: Date.now(),
        runId,
        data: { toolId }
      })

      return output
    } catch (cause) {
      options.trace?.emit({
        type: 'tool:error',
        timestamp: Date.now(),
        runId,
        data: { toolId, cause }
      })

      throw new ToolkitError({
        code: 'TOOL_EXECUTION_FAILED',
        message: `Tool execution failed: ${toolId}`,
        cause
      })
    }
  }

  return {
    executeTool
  }
}
