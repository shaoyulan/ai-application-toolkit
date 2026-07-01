---
"@ai-application-toolkit/mcp": minor
---

Three additions to the MCP integration:

- **Streamable HTTP server** — `startHttpMcpServer` / `createHttpMcpHandler`
  serve tools over the MCP Streamable HTTP transport, stateless by default for
  horizontal scaling. The handler is framework-agnostic (`(req, res)`).
- **MCP client** — `connectMcpClient` connects to an external MCP server (stdio
  or HTTP) and wraps its tools as toolkit tools, so they run through the runtime
  with the same validation, guardrails, timeout, and tracing as local tools.
- **OAuth 2.1** — `createBearerVerifier` verifies bearer JWTs against a remote
  JWKS at the transport boundary and places the caller on `context.metadata.auth`
  for `defineScopeGuardrail` to authorize against.
