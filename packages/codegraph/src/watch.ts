/**
 * Debounced recursive directory watcher for `serve --watch`.
 *
 * On any change under `dir` (excluding ignored segments) it schedules a single
 * flush after a quiet period, collapsing edit bursts into one incremental
 * rebuild. Runs are never overlapped: a change arriving mid-rebuild queues
 * exactly one follow-up.
 *
 * The pure pieces ({@link createDebouncer}, {@link isIgnoredPath}) are exported
 * and unit-tested; `watchDirectory` is the thin `fs.watch` glue around them.
 * Recursive `fs.watch` is native on macOS/Windows; on Linux it is not
 * universally supported, so a start failure calls `onError` and the watcher
 * becomes a no-op (fall back to explicit `codegraph sync`).
 */
import { watch, type FSWatcher } from 'node:fs'

const DEFAULT_DEBOUNCE_MS = 300

/** Path segments whose changes never trigger a rebuild. */
const DEFAULT_WATCH_IGNORE = ['node_modules', '.git', '.codegraph', 'dist', 'build', '.turbo']

export interface WatchOptions {
  /** Debounce window in ms. Default 300. */
  debounceMs?: number
  /** Extra path segments to ignore (merged with defaults). */
  ignore?: string[]
  /** Reported when the watcher cannot start or a flush throws. */
  onError?: (error: unknown) => void
}

export interface Watcher {
  /** Whether the underlying watch actually started (false if the platform
   * rejected recursive watching — callers should fall back to manual `sync`). */
  started: boolean
  close(): void
}

/** True if any path segment of `filename` is in the ignore set. */
export function isIgnoredPath(filename: string | null, ignore: Set<string>): boolean {
  if (!filename) return false
  return filename.split(/[/\\]/).some((segment) => ignore.has(segment))
}

export interface Debouncer {
  /** Note a change; schedules a flush after the quiet window. */
  trigger(): void
  /** Cancel any pending flush. */
  cancel(): void
}

/**
 * Coalesce rapid `trigger()` calls into a single `onFlush` after `debounceMs` of
 * quiet, never overlapping runs: a trigger during an in-flight flush queues
 * exactly one follow-up. `onFlush` may be async; rejections go to `onError`.
 */
export function createDebouncer(
  debounceMs: number,
  onFlush: () => void | Promise<void>,
  onError: (error: unknown) => void = () => {}
): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pending = false

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), debounceMs)
  }

  const flush = async () => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      await onFlush()
    } catch (error) {
      onError(error)
    } finally {
      running = false
      if (pending) {
        pending = false
        schedule()
      }
    }
  }

  return {
    trigger: schedule,
    cancel: () => {
      if (timer) clearTimeout(timer)
    }
  }
}

/**
 * Watch `dir` and invoke `onFlush` (debounced) whenever a non-ignored file
 * changes. `onFlush` may be async; its rejections are routed to `onError`.
 */
export function watchDirectory(
  dir: string,
  onFlush: () => void | Promise<void>,
  options: WatchOptions = {}
): Watcher {
  const ignore = new Set([...DEFAULT_WATCH_IGNORE, ...(options.ignore ?? [])])
  const onError = options.onError ?? (() => {})
  const debouncer = createDebouncer(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, onFlush, onError)

  let watcher: FSWatcher | undefined
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (!isIgnoredPath(filename, ignore)) debouncer.trigger()
    })
    watcher.on('error', onError)
  } catch (error) {
    onError(error)
  }

  return {
    started: watcher !== undefined,
    close() {
      debouncer.cancel()
      watcher?.close()
    }
  }
}
