import { defineTool } from '@ai-application-toolkit/tool'
import { defineScopeGuardrail } from '@ai-application-toolkit/guardrail'
import { startHttpMcpServer, createBearerVerifier } from '@ai-application-toolkit/mcp'

// A remote MCP server protected with OAuth 2.1. Two layers, matching the spec's
// separation of concerns:
//   1. createBearerVerifier validates the incoming JWT against the issuer's JWKS
//      at the transport boundary (a resource server — it does not issue tokens).
//   2. defineScopeGuardrail authorizes each tool against the caller's scopes,
//      which the verifier places on context.metadata.auth.
const deleteUser = defineTool({
  id: 'delete-user',
  description: 'Delete a user by id',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false
  },
  execute: (input: { id: string }) => `Deleted ${input.id}`
})

await startHttpMcpServer({
  name: 'ai-toolkit-oauth-example',
  version: '1.0.0',
  tools: [deleteUser],
  port: 3000,
  authenticate: createBearerVerifier({
    jwksUri: 'https://issuer.example.com/.well-known/jwks.json',
    issuer: 'https://issuer.example.com/',
    audience: 'https://my-mcp-server.example.com'
  }),
  resourceMetadataUrl:
    'https://my-mcp-server.example.com/.well-known/oauth-protected-resource',
  runtime: {
    // delete-user requires the "admin" scope; callers without it are blocked.
    guardrails: [defineScopeGuardrail({ required: { 'delete-user': ['admin'] } })]
  }
})

console.log('Protected MCP server listening on http://localhost:3000/mcp')
