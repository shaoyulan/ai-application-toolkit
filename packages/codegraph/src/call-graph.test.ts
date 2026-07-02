import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCodeGraph } from './build.js'
import type { CodeGraph, GraphEdge } from './graph.js'

const dirs: string[] = []

async function buildProject(files: Record<string, string>): Promise<CodeGraph> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-calls-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return buildCodeGraph({ dir })
}

/** The `calls` edge from a symbol named `from` to one named `to`, if any. */
function callEdge(g: CodeGraph, from: string, to: string): GraphEdge | undefined {
  return g
    .edges()
    .find((e) => e.kind === 'calls' && node(g, e.from)?.name === from && node(g, e.to)?.name === to)
}
function node(g: CodeGraph, id: string) {
  const n = g.getNode(id)
  return n && n.kind === 'symbol' ? n : undefined
}
function callsTo(g: CodeGraph, toName: string): GraphEdge[] {
  return g.edges().filter((e) => e.kind === 'calls' && node(g, e.to)?.name === toName)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('call graph — resolution', () => {
  it('resolves a direct function chain a→b→c (exact, same file)', async () => {
    const g = await buildProject({
      'a.ts': 'export function a() { return b() }\nfunction b() { return c() }\nfunction c() { return 1 }\n'
    })
    expect(callEdge(g, 'a', 'b')?.meta?.confidence).toBe(1)
    expect(callEdge(g, 'b', 'c')?.meta?.confidence).toBe(1)
  })

  it('resolves this.method() to the enclosing class method (exact)', async () => {
    const g = await buildProject({
      'k.ts': 'export class K {\n  run() { return this.helper() }\n  helper() { return 1 }\n}\n'
    })
    expect(callEdge(g, 'run', 'helper')?.meta?.confidence).toBe(1)
  })

  it('resolves an imported function (high)', async () => {
    const g = await buildProject({
      'util.ts': 'export function helper() { return 1 }\n',
      'main.ts': "import { helper } from './util'\nexport function run() { return helper() }\n"
    })
    const e = callEdge(g, 'run', 'helper')
    expect(e?.meta?.confidence).toBe(0.8)
    expect(node(g, e!.to)?.file).toBe('util.ts')
  })

  it('type-tracks new X() then x.method() to the class method (high)', async () => {
    const g = await buildProject({
      'widget.ts': 'export class Widget { render() { return 1 } }\n',
      'app.ts':
        "import { Widget } from './widget'\nexport function run() { const w = new Widget(); return w.render() }\n"
    })
    const e = callEdge(g, 'run', 'render')
    expect(e?.meta?.confidence).toBe(0.8)
    expect(e?.meta?.receiverType).toBe('Widget')
    // constructor call is marked kind:'new'
    expect(callEdge(g, 'run', 'Widget')?.meta?.kind).toBe('new')
  })
})

describe('call graph — adversarial (no mis-wire)', () => {
  it('skips a bare call whose name is defined in two files (ambiguous)', async () => {
    const g = await buildProject({
      'x.ts': 'export function helper() { return 1 }\n',
      'y.ts': 'export function helper() { return 2 }\n',
      'z.ts': 'export function caller() { return helper() }\n' // no import — ambiguous
    })
    expect(callEdge(g, 'caller', 'helper')).toBeUndefined()
  })

  it('never resolves a call across languages', async () => {
    const g = await buildProject({
      'a.ts': 'export function run() { return greet() }\n',
      'b.py': 'def greet():\n    return 1\n'
    })
    // `greet` only exists in Python; the TS call must not wire to it.
    expect(callsTo(g, 'greet').some((e) => node(g, e.from)?.name === 'run')).toBe(false)
  })

  it('does not emit a high-confidence edge for an unknown-receiver method with a colliding name', async () => {
    const g = await buildProject({
      'a.ts': 'export class A { save() { return 1 } }\nexport class B { save() { return 2 } }\n',
      'b.ts': 'export function run(x: unknown) { return (x as any).save() }\n'
    })
    const e = callEdge(g, 'run', 'save')
    expect(e === undefined || (e.meta?.confidence ?? 1) < 0.8).toBe(true)
  })
})

describe('call graph — impact', () => {
  it('groups the blast radius by depth with confidence', async () => {
    const g = await buildProject({
      'chain.ts':
        'export function a() { return b() }\nfunction b() { return c() }\nfunction c() { return 1 }\n'
    })
    const result = g.impact('c', { direction: 'callers' })
    const names = (depth: number) =>
      result.groups.find((gr) => gr.depth === depth)!.nodes.map((n) => (n.node.kind === 'symbol' ? n.node.name : ''))
    expect(names(1)).toEqual(['b'])
    expect(names(2)).toEqual(['a'])
  })

  it('minConfidence filters weak edges', async () => {
    const g = await buildProject({
      'util.ts': 'export function helper() { return 1 }\n',
      'main.ts': "import { helper } from './util'\nexport function run() { return helper() }\n"
    })
    expect(g.impact('helper', { minConfidence: 0.9 }).groups).toHaveLength(0) // edge is 0.8
    expect(g.impact('helper', { minConfidence: 0.8 }).groups).toHaveLength(1)
  })
})

describe('call graph — precision harness', () => {
  it('every high-confidence (≥0.8) calls edge is a true call (precision = 1.0)', async () => {
    const g = await buildProject({
      'util.ts': 'export function helper() { return 1 }\nexport class Widget { render() { return 1 } }\n',
      'main.ts':
        "import { helper, Widget } from './util'\n" +
        'export function run() {\n' +
        '  const w = new Widget()\n' +
        '  helper()\n' +
        '  return w.render()\n' +
        '}\n',
      'self.ts': 'export class K { run() { return this.helper() } helper() { return 1 } }\n'
    })
    // Ground truth of real high-confidence calls in this fixture.
    const truth = new Set(['run->helper', 'run->render', 'run->Widget', 'run->helper'])
    const highConf = g
      .edges()
      .filter((e) => e.kind === 'calls' && (e.meta?.confidence ?? 0) >= 0.8)
      .map((e) => `${node(g, e.from)?.name ?? g.getNode(e.from)?.id}->${node(g, e.to)?.name}`)
    // Precision: every emitted high-confidence edge is in the ground-truth set.
    for (const edge of highConf) expect(truth.has(edge)).toBe(true)
    // Recall sanity: the obvious ones are present.
    expect(highConf).toContain('run->helper')
    expect(highConf).toContain('run->render')
  })
})
