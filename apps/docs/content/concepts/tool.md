# Tool

A Tool is a typed executable function.

```ts
import { defineTool } from '@ai-application-toolkit/tool'

export const searchTool = defineTool({
  id: 'search',
  description: 'Search public documents',
  input: {
    query: 'string'
  },
  execute: async (input) => {
    return { results: [] }
  }
})
```

## Rules

- Tools must not depend on provider SDKs.
- Tools must validate inputs.
- Tools should be deterministic when possible.
