/**
 * Port availability helpers for `codegraph serve`.
 *
 * Node's default (wildcard) bind can silently coexist with an existing listener
 * on a *specific* loopback address (e.g. Nuxt on `[::1]:3001`), so a bare
 * `listen()` succeeds yet clients hitting `localhost` reach the other process.
 * We therefore probe by *connecting* to both loopback stacks: if anything
 * accepts a connection on the port, it is already in use.
 */
import { createConnection } from 'node:net'

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const
const PROBE_TIMEOUT_MS = 300

/** True if a TCP connection to `host:port` succeeds (i.e. someone is serving). */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (inUse: boolean) => {
      socket.destroy()
      resolve(inUse)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    // ECONNREFUSED / EADDRNOTAVAIL → nothing listening on this stack.
    socket.once('error', () => finish(false))
  })
}

/** True if the port is already accepting connections on either loopback stack. */
export async function isPortInUse(port: number): Promise<boolean> {
  const results = await Promise.all(LOOPBACK_HOSTS.map((host) => canConnect(host, port)))
  return results.some(Boolean)
}

/**
 * Return the first free port at or after `preferred`, probing up to `maxTries`
 * ports. Falls back to `0` (let the OS assign a free port) if none are free.
 */
export async function findAvailablePort(preferred: number, maxTries = 20): Promise<number> {
  for (let port = preferred; port < preferred + maxTries; port++) {
    if (port > 65535) break
    if (!(await isPortInUse(port))) return port
  }
  return 0
}
