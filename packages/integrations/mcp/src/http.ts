import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Awaitable, ToolkitAuthInfo, ToolkitContextData } from '@ai-application-toolkit/core'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { buildMcpServer, type CreateMcpServerOptions } from './server.js'

/** Verifies an incoming request and resolves the authenticated caller, or
 * `null` to reject with `401`. Run at the transport boundary, before any tool
 * executes. See `createBearerVerifier` for a JWT/JWKS implementation. */
export type AuthenticateFn = (req: IncomingMessage) => Awaitable<ToolkitAuthInfo | null>

export interface HttpMcpServerOptions extends CreateMcpServerOptions {
  /**
   * Session id generator. Omit (the default) for **stateless** mode: no session
   * is bound to the connection, so the server scales horizontally behind a load
   * balancer. Provide one only if you need stateful sessions.
   */
  sessionIdGenerator?: () => string
  /** Optional bearer-token verification. When set, a `null` result yields `401`. */
  authenticate?: AuthenticateFn
  /**
   * Maps the authenticated caller to per-run context. Defaults to placing it on
   * `metadata.auth`, where `defineScopeGuardrail` reads it.
   */
  contextFromAuth?: (auth: ToolkitAuthInfo) => ToolkitContextData
  /** Value advertised in the `WWW-Authenticate` header on `401` (e.g. the
   * protected-resource metadata URL), per the MCP authorization spec. */
  resourceMetadataUrl?: string
}

function unauthorized(res: ServerResponse, resourceMetadataUrl?: string): void {
  const challenge = resourceMetadataUrl
    ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
    : 'Bearer error="invalid_token"'
  res.writeHead(401, { 'WWW-Authenticate': challenge, 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'invalid_token' }))
}

/**
 * Builds a framework-agnostic Node `(req, res)` handler that serves the toolkit
 * tools over the MCP Streamable HTTP transport. The runtime is created once and
 * shared; each request gets its own short-lived stateless server + transport,
 * which is the pattern the MCP SDK recommends for concurrency-safe stateless
 * operation. Mount it under any framework, or use {@link startHttpMcpServer}.
 */
export function createHttpMcpHandler(
  options: HttpMcpServerOptions
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const runtime = createRuntime({ tools: options.tools, ...options.runtime })

  return async (req, res) => {
    let context: ToolkitContextData | undefined
    if (options.authenticate) {
      const auth = await options.authenticate(req)
      if (!auth) {
        unauthorized(res, options.resourceMetadataUrl)
        return
      }
      context = options.contextFromAuth?.(auth) ?? { metadata: { auth } }
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: options.sessionIdGenerator
    })
    const server = buildMcpServer(options, runtime, () => context)

    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}

export interface StartHttpMcpServerOptions extends HttpMcpServerOptions {
  port: number
  hostname?: string
  /** Path the MCP endpoint is served on. Requests to other paths get `404`. */
  path?: string
}

/**
 * Convenience: builds the handler and serves it on a `node:http` server. Point
 * a Streamable HTTP MCP client at `http://<host>:<port><path>`.
 */
export function startHttpMcpServer(
  options: StartHttpMcpServerOptions
): Promise<HttpServer> {
  const path = options.path ?? '/mcp'
  const handler = createHttpMcpHandler(options)

  const httpServer = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.split('?')[0] !== path) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }
    handler(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal_error', message: String(error) }))
      }
    })
  })

  return new Promise((resolve) => {
    httpServer.listen(options.port, options.hostname, () => resolve(httpServer))
  })
}
