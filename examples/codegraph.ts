import { fileURLToPath } from 'node:url'
import { buildCodeGraph, defineCodegraphCapability } from '@ai-application-toolkit/codegraph'
import { collectCapabilityTools } from '@ai-application-toolkit/capability'
import { createRuntime } from '@ai-application-toolkit/runtime'

// Build a code graph for the codegraph package's own source — a folder with
// plenty of functions and classes to rank.
const dir = fileURLToPath(new URL('../packages/codegraph/src', import.meta.url))
const graph = await buildCodeGraph({ dir })

console.log(`Indexed ${graph.files().length} files, ${graph.symbols().length} symbols.`)

// Direct library queries.
console.log('\nMost important symbols (PageRank):')
for (const { node, score } of graph.rankedContext({ kind: 'symbol', limit: 5 })) {
  if (node.kind === 'symbol') {
    console.log(`  ${node.name} (${node.symbolKind}) — ${score.toFixed(4)}  [${node.file}]`)
  }
}

// Expose the graph as tools the runtime/LLM can call.
const codegraph = defineCodegraphCapability(graph)
const runtime = createRuntime({ tools: collectCapabilityTools([codegraph]) })

const result = await runtime.executeTool({
  toolId: 'codegraph_relevant_context',
  input: { seeds: ['buildCodeGraph'], limit: 5 }
})

console.log('\ncodegraph_relevant_context(seeds=["buildCodeGraph"]):')
console.log(result)
