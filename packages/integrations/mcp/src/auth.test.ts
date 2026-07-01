import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { createBearerVerifier } from './auth'

const ISSUER = 'https://issuer.test/'
const AUDIENCE = 'https://resource.test'

let jwksServer: HttpServer
let jwksUri: string
let privateKey: CryptoKey

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair('RS256')
  privateKey = priv
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => jwksServer.listen(0, resolve))
  const { port } = jwksServer.address() as AddressInfo
  jwksUri = `http://127.0.0.1:${port}/jwks.json`
})

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()))
})

async function sign(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(privateKey)
}

const reqWith = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as IncomingMessage

describe('createBearerVerifier', () => {
  it('verifies a valid token and extracts subject + space-delimited scopes', async () => {
    const verify = createBearerVerifier({ jwksUri, issuer: ISSUER, audience: AUDIENCE })
    const token = await sign({ sub: 'user-1', scope: 'read write' })

    const auth = await verify(reqWith(`Bearer ${token}`))
    expect(auth?.subject).toBe('user-1')
    expect(auth?.scopes).toEqual(['read', 'write'])
  })

  it('reads scopes from a "scopes" array claim', async () => {
    const verify = createBearerVerifier({ jwksUri, issuer: ISSUER, audience: AUDIENCE })
    const token = await sign({ sub: 'user-1', scopes: ['admin'] })
    const auth = await verify(reqWith(`Bearer ${token}`))
    expect(auth?.scopes).toEqual(['admin'])
  })

  it('returns null when the Authorization header is missing', async () => {
    const verify = createBearerVerifier({ jwksUri })
    expect(await verify(reqWith(undefined))).toBeNull()
  })

  it('returns null for a malformed / unverifiable token', async () => {
    const verify = createBearerVerifier({ jwksUri, issuer: ISSUER, audience: AUDIENCE })
    expect(await verify(reqWith('Bearer not-a-jwt'))).toBeNull()
  })

  it('returns null when the audience does not match', async () => {
    const verify = createBearerVerifier({ jwksUri, issuer: ISSUER, audience: 'https://other.test' })
    const token = await sign({ sub: 'user-1', scope: 'read' })
    expect(await verify(reqWith(`Bearer ${token}`))).toBeNull()
  })
})
