# @ai-application-toolkit/mcp

## 0.1.0

### Minor Changes

- b556a67: Initial public release of the AI Application Toolkit.

  Ships the core primitives (tool, runtime, context, capability, workflow,
  guardrail, trace, cache), provider adapters for Anthropic (Claude) and OpenAI,
  and integrations for the Model Context Protocol (expose tools as an MCP server)
  and the Vercel AI SDK (use tools with `generateText`/`streamText`).

- ef4faa4: Three additions to the MCP integration:

  - **Streamable HTTP server** — `startHttpMcpServer` / `createHttpMcpHandler`
    serve tools over the MCP Streamable HTTP transport, stateless by default for
    horizontal scaling. The handler is framework-agnostic (`(req, res)`).
  - **MCP client** — `connectMcpClient` connects to an external MCP server (stdio
    or HTTP) and wraps its tools as toolkit tools, so they run through the runtime
    with the same validation, guardrails, timeout, and tracing as local tools.
  - **OAuth 2.1** — `createBearerVerifier` verifies bearer JWTs against a remote
    JWKS at the transport boundary and places the caller on `context.metadata.auth`
    for `defineScopeGuardrail` to authorize against.

### Patch Changes

- ef4faa4: Add explicit `.js` extensions to relative imports so the emitted ESM resolves
  under plain Node (not just bundlers/tsx). Previously `tool` and `mcp` emitted
  extensionless relative imports (e.g. `export * from './schema'`), which Node's
  native ESM loader rejects — breaking `node dist/...` and any consumer that runs
  the built output directly (such as a CLI bin). No API changes.
- Updated dependencies [ef4faa4]
- Updated dependencies [ef4faa4]
- Updated dependencies [b556a67]
  - @ai-application-toolkit/tool@0.1.0
  - @ai-application-toolkit/core@0.1.0
  - @ai-application-toolkit/runtime@0.1.0
