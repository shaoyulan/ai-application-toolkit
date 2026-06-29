# Runtime

Runtime executes tools and emits trace events.

```ts
const runtime = createRuntime({
  tools: [searchTool],
  middleware: [validateInput(), withTimeout(10_000)]
})
```

## Responsibilities

- timeout
- retry
- validation
- error normalization
- trace event emission
