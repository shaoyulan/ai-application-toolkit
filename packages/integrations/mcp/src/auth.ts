import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { ToolkitAuthInfo } from '@ai-application-toolkit/core'
import type { AuthenticateFn } from './http.js'

export interface BearerVerifierOptions {
  /** JWKS endpoint of the authorization server, used to fetch signing keys. */
  jwksUri: string
  /** Expected `iss`. Recommended — rejects tokens from other issuers. */
  issuer?: string | string[]
  /** Expected `aud` (this resource server). Recommended per OAuth 2.1. */
  audience?: string | string[]
  /**
   * Maps a verified JWT payload to the toolkit caller identity. Defaults to
   * `sub` as subject and scopes from the `scope` (space-delimited) or `scopes`
   * (array) claim.
   */
  mapClaims?: (payload: JWTPayload) => ToolkitAuthInfo
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer (.+)$/i.exec(header.trim())
  return match?.[1]
}

function defaultScopes(payload: JWTPayload): string[] {
  const scope = payload.scope
  if (typeof scope === 'string') return scope.split(' ').filter(Boolean)
  const scopes = (payload as { scopes?: unknown }).scopes
  if (Array.isArray(scopes)) return scopes.filter((s): s is string => typeof s === 'string')
  return []
}

/**
 * Builds an {@link AuthenticateFn} that verifies an OAuth 2.1 bearer JWT against
 * a remote JWKS. Pass it to `startHttpMcpServer({ authenticate })`. Verification
 * follows the gateway model — this is a resource server that validates tokens;
 * it does not issue them. The JWKS is fetched once and cached/rotated by `jose`.
 *
 * @example
 * startHttpMcpServer({
 *   name, version, tools, port,
 *   authenticate: createBearerVerifier({
 *     jwksUri: 'https://issuer.example.com/.well-known/jwks.json',
 *     issuer: 'https://issuer.example.com/',
 *     audience: 'https://my-mcp-server.example.com'
 *   }),
 *   runtime: { guardrails: [defineScopeGuardrail({ required: { 'delete-user': ['admin'] } })] }
 * })
 */
export function createBearerVerifier(options: BearerVerifierOptions): AuthenticateFn {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri))
  const map =
    options.mapClaims ??
    ((payload: JWTPayload): ToolkitAuthInfo => ({
      subject: payload.sub,
      scopes: defaultScopes(payload),
      claims: payload
    }))

  return async (req) => {
    const token = bearerToken(req.headers.authorization)
    if (!token) return null
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience
      })
      return map(payload)
    } catch {
      // Any verification failure (bad signature, expired, wrong aud/iss) → 401.
      return null
    }
  }
}
