import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort, isPortInUse } from './port.js'

/** Listen on a loopback host and resolve the bound port. */
function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, port })
    })
  })
}

describe('port helpers', () => {
  const servers: Server[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  it('reports a free port as available', async () => {
    // Bind an ephemeral port, close it, then check it reads as free.
    const { server, port } = await listen('127.0.0.1')
    await new Promise<void>((r) => server.close(() => r()))
    expect(await isPortInUse(port)).toBe(false)
  })

  it('detects a port taken on the IPv4 loopback', async () => {
    const { server, port } = await listen('127.0.0.1')
    servers.push(server)
    expect(await isPortInUse(port)).toBe(true)
  })

  it('detects a port taken only on the IPv6 loopback (the shadowing case)', async () => {
    let bound: { server: Server; port: number }
    try {
      bound = await listen('::1')
    } catch {
      return // Host has no IPv6 loopback; nothing to assert.
    }
    servers.push(bound.server)
    expect(await isPortInUse(bound.port)).toBe(true)
  })

  it('falls back past a busy port to the next free one', async () => {
    const { server, port } = await listen('127.0.0.1')
    servers.push(server)
    const chosen = await findAvailablePort(port)
    expect(chosen).not.toBe(port)
    expect(chosen === 0 || chosen > port).toBe(true)
  })
})
