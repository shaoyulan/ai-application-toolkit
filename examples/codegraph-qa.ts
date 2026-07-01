/**
 * "Ask questions about your codebase" — codegraph-powered retrieval + Claude.
 *
 * Pipeline (the whole toolkit in one flow):
 *   Tool -> Runtime -> [codegraph retrieval] -> Adapter -> Provider
 *
 * The code graph selects the most relevant symbols for a question (personalized
 * PageRank), their source is read and packed into a grounded prompt, and the
 * Anthropic adapter answers. Run:
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @ai-application-toolkit/examples codegraph-qa "How does ranking work?"
 *
 * Without an API key it still runs the retrieval and prints the context it
 * would have sent, so the codegraph half is demonstrable offline.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnthropicAdapter } from '@ai-application-toolkit/anthropic'
import { collectCapabilityTools } from '@ai-application-toolkit/capability'
import { buildCodeGraph, defineCodegraphCapability } from '@ai-application-toolkit/codegraph'
import { createRuntime } from '@ai-application-toolkit/runtime'

interface RankedSymbol {
  node: {
    kind: 'symbol' | 'file'
    name?: string
    symbolKind?: string
    file?: string
    startLine?: number
    endLine?: number
  }
  score: number
}

const MAX_SNIPPETS = 6
const MAX_SNIPPET_LINES = 60

const dir = fileURLToPath(new URL('../packages/codegraph/src', import.meta.url))
const question = process.argv.slice(2).join(' ') || 'How does context ranking work, and what drives it?'

// 1. Build the graph and expose it as tools behind a runtime.
const graph = await buildCodeGraph({ dir })
const codegraph = defineCodegraphCapability(graph)
const runtime = createRuntime({ tools: collectCapabilityTools([codegraph]) })

// 2. Turn the question into seeds: symbol names whose text overlaps a word in
//    the question (e.g. "PageRank" -> computePageRank, "rank" -> rankedContext).
const symbolNames = [...new Set(graph.symbols().map((s) => s.name))]
const words = [...new Set(question.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].filter(
  (w) => w.length >= 4
)
const seeds = [
  ...new Set(
    words.flatMap((word) => {
      const w = word.toLowerCase()
      return symbolNames.filter((name) => {
        const n = name.toLowerCase()
        return n.includes(w) || w.includes(n)
      })
    })
  )
]

// 3. Retrieve the most relevant symbols through the codegraph tool.
const ranked = (await runtime.executeTool({
  toolId: 'codegraph_relevant_context',
  input: { seeds, kind: 'symbol', limit: MAX_SNIPPETS }
})) as RankedSymbol[]

// 4. Read the source for each ranked symbol.
const fileCache = new Map<string, string[]>()
async function lines(relPath: string): Promise<string[]> {
  let cached = fileCache.get(relPath)
  if (!cached) {
    cached = (await readFile(join(dir, relPath), 'utf8')).split('\n')
    fileCache.set(relPath, cached)
  }
  return cached
}

const snippets: string[] = []
const citations: string[] = []
for (const { node } of ranked) {
  if (node.kind !== 'symbol' || !node.file || !node.startLine) continue
  const all = await lines(node.file)
  const end = Math.min(node.endLine ?? node.startLine, node.startLine + MAX_SNIPPET_LINES - 1)
  const slice = all.slice(node.startLine - 1, end).join('\n')
  const where = `${node.file}:${node.startLine}-${end}`
  snippets.push(`// ${where} — ${node.name} (${node.symbolKind})\n${slice}`)
  citations.push(`${node.name} [${where}]`)
}

const context = snippets.join('\n\n---\n\n')

console.log(`Q: ${question}`)
console.log(`Seeds: ${seeds.length ? seeds.join(', ') : '(none — using global importance)'}`)
console.log(`Context: ${citations.length} symbols\n  ${citations.join('\n  ')}\n`)

// 5. Answer through the Anthropic adapter (or show the context offline).
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY not set — printing the retrieved context instead of calling Claude:\n')
  console.log(context)
} else {
  const claude = createAnthropicAdapter()
  const result = await claude.generate({
    system:
      'You answer questions about a codebase. Use ONLY the provided source excerpts. ' +
      'Cite the symbols and file:line ranges you rely on. If the answer is not in the ' +
      'excerpts, say so.',
    prompt: `Question: ${question}\n\nRelevant source excerpts:\n\n${context}`
  })
  console.log('Answer:\n')
  console.log(result.text)
  console.log(`\n[${result.model}] tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens}`)
}
