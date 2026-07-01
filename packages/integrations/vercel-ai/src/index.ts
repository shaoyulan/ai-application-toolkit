import { tool, jsonSchema, type ToolSet } from 'ai'
import { createRuntime, type RuntimeOptions } from '@ai-application-toolkit/runtime'
import type { AnyToolDefinition } from '@ai-application-toolkit/tool'

type JsonSchemaArg = Parameters<typeof jsonSchema>[0]

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} }

export interface ToVercelToolsOptions {
  /** Extra runtime configuration (guardrails, context, trace, timeout). */
  runtime?: Omit<RuntimeOptions, 'tools'>
}

/**
 * Converts toolkit tools into a Vercel AI SDK {@link ToolSet}, ready to pass to
 * `generateText` / `streamText` as `tools`. Each tool's JSON Schema becomes the
 * AI SDK `inputSchema`, and `execute` runs through the toolkit runtime — so
 * input validation, guardrails, context, and tracing all apply.
 */
export function toVercelTools(
  tools: AnyToolDefinition[],
  options: ToVercelToolsOptions = {}
): ToolSet {
  const runtime = createRuntime({ tools, ...options.runtime })
  const set: ToolSet = {}

  for (const definition of tools) {
    set[definition.id] = tool({
      ...(definition.description ? { description: definition.description } : {}),
      inputSchema: jsonSchema((definition.input ?? EMPTY_OBJECT_SCHEMA) as JsonSchemaArg),
      execute: async (input) => runtime.executeTool({ toolId: definition.id, input })
    })
  }

  return set
}
