# Architecture

```mermaid
flowchart TD
  App[Application] --> Capability
  Capability --> Workflow
  Workflow --> Runtime
  Runtime --> Guardrail
  Guardrail --> Tool
  Runtime --> Trace
  Runtime --> Adapter
  Adapter --> Provider[Model Provider]
  Context --> Runtime
```

## Layer responsibilities

| Layer | Responsibility |
| --- | --- |
| Tool | Defines executable actions |
| Runtime | Executes tools safely |
| Context | Provides immutable execution input |
| Capability | Groups tools by user-facing ability |
| Workflow | Coordinates multi-step execution |
| Adapter | Normalizes model providers |
| Guardrail | Enforces policy |
| Trace | Records lifecycle events |
