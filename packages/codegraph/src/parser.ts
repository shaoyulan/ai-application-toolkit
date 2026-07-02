/**
 * Multi-language parsing via tree-sitter (WASM). Grammars are loaded lazily
 * from `tree-sitter-wasms` and symbol/reference/import facts are extracted with
 * tree-sitter tag queries — the same approach Sourcegraph and Aider's repo-map
 * use.
 *
 * Robustness note: each query pattern is compiled independently and patterns
 * that fail to compile against a given grammar are skipped. This lets one
 * shared pattern set serve several related grammars (e.g. the JS family covers
 * javascript/typescript/tsx) and tolerates grammar-version differences without
 * crashing the whole build.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Language, Parser, Query, type Node } from 'web-tree-sitter'
import { ToolkitError } from '@ai-application-toolkit/core'
import type { SymbolKind } from './graph.js'

const require = createRequire(import.meta.url)

/** How a language's import specifiers map to other files in the scan set. */
export type ImportStyle = 'esm-relative' | 'python' | 'none'

export interface LanguageSpec {
  id: string
  /** File name inside `tree-sitter-wasms/out`, without directory. */
  wasm: string
  /** File extensions (with leading dot) that select this language. */
  extensions: string[]
  /** Tag-query patterns; compiled individually, incompatible ones skipped. */
  patterns: string[]
  importStyle: ImportStyle
}

const SYMBOL_KINDS: ReadonlySet<string> = new Set<SymbolKind>([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'field',
  'variable'
])

// One pattern set for the whole JS family. Patterns referencing node types that
// don't exist in a given grammar (e.g. `type_identifier` in plain JavaScript)
// are dropped at compile time, so this safely covers javascript/typescript/tsx.
const JS_FAMILY: string[] = [
  '(function_declaration name: (identifier) @name) @definition.function',
  '(generator_function_declaration name: (identifier) @name) @definition.function',
  '(class_declaration name: (identifier) @name) @definition.class',
  '(class_declaration name: (type_identifier) @name) @definition.class',
  '(abstract_class_declaration name: (type_identifier) @name) @definition.class',
  '(interface_declaration name: (type_identifier) @name) @definition.interface',
  '(type_alias_declaration name: (type_identifier) @name) @definition.type',
  '(enum_declaration name: (identifier) @name) @definition.enum',
  '(method_definition name: (property_identifier) @name) @definition.method',
  '(public_field_definition name: (property_identifier) @name) @definition.field',
  '(field_definition property: (property_identifier) @name) @definition.field',
  '(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function',
  '(variable_declarator name: (identifier) @name value: (function_expression)) @definition.function',
  '(call_expression function: (identifier) @name) @reference.call',
  '(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call',
  '(new_expression constructor: (identifier) @name) @reference.call',
  '(new_expression constructor: (type_identifier) @name) @reference.call',
  // Type bindings for method-call resolution (TS-only node types compile out for JS).
  '(variable_declarator name: (identifier) @bind.name value: (new_expression constructor: (identifier) @bind.type))',
  '(variable_declarator name: (identifier) @bind.name value: (new_expression constructor: (type_identifier) @bind.type))',
  '(required_parameter pattern: (identifier) @bind.name type: (type_annotation (type_identifier) @bind.type))',
  '(variable_declarator name: (identifier) @bind.name type: (type_annotation (type_identifier) @bind.type))',
  '(import_statement source: (string) @import)',
  '(export_statement source: (string) @import)'
]

const PYTHON: string[] = [
  '(function_definition name: (identifier) @name) @definition.function',
  '(class_definition name: (identifier) @name) @definition.class',
  '(call function: (identifier) @name) @reference.call',
  '(call function: (attribute attribute: (identifier) @name)) @reference.call',
  '(assignment left: (identifier) @bind.name right: (call function: (identifier) @bind.type))',
  '(typed_parameter (identifier) @bind.name type: (type (identifier) @bind.type))',
  '(import_from_statement module_name: (dotted_name) @import)',
  '(import_from_statement module_name: (relative_import) @import)',
  '(import_statement name: (dotted_name) @import)',
  '(import_statement name: (aliased_import name: (dotted_name) @import))'
]

const GO: string[] = [
  '(function_declaration name: (identifier) @name) @definition.function',
  '(method_declaration name: (field_identifier) @name) @definition.method',
  '(type_declaration (type_spec name: (type_identifier) @name)) @definition.type',
  '(call_expression function: (identifier) @name) @reference.call',
  '(call_expression function: (selector_expression field: (field_identifier) @name)) @reference.call',
  '(import_spec path: (interpreted_string_literal) @import)'
]

const CSHARP: string[] = [
  '(class_declaration name: (identifier) @name) @definition.class',
  '(record_declaration name: (identifier) @name) @definition.class',
  '(struct_declaration name: (identifier) @name) @definition.class',
  '(interface_declaration name: (identifier) @name) @definition.interface',
  '(enum_declaration name: (identifier) @name) @definition.enum',
  '(delegate_declaration name: (identifier) @name) @definition.type',
  '(method_declaration name: (identifier) @name) @definition.method',
  '(constructor_declaration name: (identifier) @name) @definition.method',
  '(property_declaration name: (identifier) @name) @definition.field',
  '(invocation_expression function: (identifier) @name) @reference.call',
  '(invocation_expression function: (member_access_expression name: (identifier) @name)) @reference.call',
  '(object_creation_expression type: (identifier) @name) @reference.call',
  '(using_directive (qualified_name) @import)',
  '(using_directive (identifier) @import)'
]

const JAVA: string[] = [
  '(class_declaration name: (identifier) @name) @definition.class',
  '(interface_declaration name: (identifier) @name) @definition.interface',
  '(enum_declaration name: (identifier) @name) @definition.enum',
  '(record_declaration name: (identifier) @name) @definition.class',
  '(method_declaration name: (identifier) @name) @definition.method',
  '(constructor_declaration name: (identifier) @name) @definition.method',
  '(method_invocation name: (identifier) @name) @reference.call',
  '(object_creation_expression type: (type_identifier) @name) @reference.call',
  '(import_declaration (scoped_identifier) @import)'
]

const RUST: string[] = [
  '(function_item name: (identifier) @name) @definition.function',
  '(struct_item name: (type_identifier) @name) @definition.class',
  '(enum_item name: (type_identifier) @name) @definition.enum',
  '(union_item name: (type_identifier) @name) @definition.class',
  '(trait_item name: (type_identifier) @name) @definition.interface',
  '(type_item name: (type_identifier) @name) @definition.type',
  '(call_expression function: (identifier) @name) @reference.call',
  '(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call',
  '(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call'
]

const SPECS: LanguageSpec[] = [
  { id: 'javascript', wasm: 'tree-sitter-javascript.wasm', extensions: ['.js', '.jsx', '.mjs', '.cjs'], patterns: JS_FAMILY, importStyle: 'esm-relative' },
  { id: 'typescript', wasm: 'tree-sitter-typescript.wasm', extensions: ['.ts', '.mts', '.cts'], patterns: JS_FAMILY, importStyle: 'esm-relative' },
  { id: 'tsx', wasm: 'tree-sitter-tsx.wasm', extensions: ['.tsx'], patterns: JS_FAMILY, importStyle: 'esm-relative' },
  { id: 'python', wasm: 'tree-sitter-python.wasm', extensions: ['.py', '.pyi'], patterns: PYTHON, importStyle: 'python' },
  { id: 'go', wasm: 'tree-sitter-go.wasm', extensions: ['.go'], patterns: GO, importStyle: 'none' },
  { id: 'csharp', wasm: 'tree-sitter-c-sharp.wasm', extensions: ['.cs'], patterns: CSHARP, importStyle: 'none' },
  { id: 'java', wasm: 'tree-sitter-java.wasm', extensions: ['.java'], patterns: JAVA, importStyle: 'none' },
  { id: 'rust', wasm: 'tree-sitter-rust.wasm', extensions: ['.rs'], patterns: RUST, importStyle: 'none' }
]

const specByExtension = new Map<string, LanguageSpec>()
for (const spec of SPECS) {
  for (const ext of spec.extensions) specByExtension.set(ext, spec)
}

export function languageForExtension(ext: string): LanguageSpec | undefined {
  return specByExtension.get(ext.toLowerCase())
}

export function supportedExtensions(): string[] {
  return [...specByExtension.keys()]
}

let parserInit: Promise<void> | undefined
function initParser(): Promise<void> {
  parserInit ??= Parser.init({
    locateFile: (file: string) => require.resolve(`web-tree-sitter/${file}`)
  })
  return parserInit
}

interface CompiledLanguage {
  language: Language
  queries: Query[]
}

const compiledByLanguage = new Map<string, Promise<CompiledLanguage>>()

async function loadLanguage(spec: LanguageSpec): Promise<CompiledLanguage> {
  await initParser()

  let wasmPath: string
  try {
    wasmPath = require.resolve(`@vscode/tree-sitter-wasm/wasm/${spec.wasm}`)
  } catch (cause) {
    throw new ToolkitError({
      code: 'CODEGRAPH_GRAMMAR_NOT_FOUND',
      message: `Grammar wasm "${spec.wasm}" for language "${spec.id}" is not installed`,
      cause
    })
  }

  const bytes = new Uint8Array(await readFile(wasmPath))
  const language = await Language.load(bytes)

  const queries: Query[] = []
  for (const pattern of spec.patterns) {
    try {
      queries.push(new Query(language, pattern))
    } catch {
      // Pattern references a node type this grammar doesn't have — expected for
      // the shared JS-family set. Skip it.
    }
  }
  return { language, queries }
}

function compileLanguage(spec: LanguageSpec): Promise<CompiledLanguage> {
  let entry = compiledByLanguage.get(spec.id)
  if (!entry) {
    entry = loadLanguage(spec)
    compiledByLanguage.set(spec.id, entry)
  }
  return entry
}

export interface DefinitionFact {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  /** Byte offsets of the whole declaration, used to find enclosing symbols. */
  startIndex: number
  endIndex: number
}

export interface ReferenceFact {
  name: string
  /** Byte offset of the reference, used to find its enclosing symbol. */
  startIndex: number
  /** 1-based line of the call site. */
  line: number
  /** Receiver/qualifier of a member call — e.g. `obj`, `this`, `mod` in
   * `obj.method()` — when it is a simple identifier. Absent for bare calls. */
  receiver?: string
  /** True when the call is a constructor (`new X()` / object creation). */
  isNew?: boolean
}

export interface ImportFact {
  /** Raw specifier text, e.g. `./parse` or `os.path`. */
  raw: string
}

/** A local variable's inferred class type, for resolving `obj.method()`. */
export interface TypeBinding {
  /** Variable/parameter name. */
  name: string
  /** Class/type name it is bound to (via `new X()` or a type annotation). */
  type: string
}

export interface FileFacts {
  definitions: DefinitionFact[]
  references: ReferenceFact[]
  imports: ImportFact[]
  typeBindings: TypeBinding[]
}

function unquote(text: string): string {
  return text.replace(/^['"`]/, '').replace(/['"`]$/, '')
}

/** Parses one source file and extracts definition/reference/import facts. */
export async function parseFile(spec: LanguageSpec, source: string): Promise<FileFacts> {
  const { language, queries } = await compileLanguage(spec)

  const facts: FileFacts = { definitions: [], references: [], imports: [], typeBindings: [] }
  const parser = new Parser()
  let tree: ReturnType<Parser['parse']> = null
  try {
    parser.setLanguage(language)
    tree = parser.parse(source)
    if (!tree) return facts

    extractFacts(queries, tree, facts)
    return facts
  } finally {
    // Always release wasm-heap objects, even if parsing/extraction throws.
    tree?.delete()
    parser.delete()
  }
}

/** Runs the tag queries over the tree and fills `facts`. */
function extractFacts(queries: Query[], tree: NonNullable<ReturnType<Parser['parse']>>, facts: FileFacts): void {
  for (const query of queries) {
    for (const match of query.matches(tree.rootNode)) {
      let nameNode: Node | undefined
      let definitionKind: SymbolKind | undefined
      // The `@definition.*` / `@reference.*` capture spans the whole node; its
      // range becomes the symbol's range.
      let rangeNode: Node | undefined
      let refNode: Node | undefined
      let importNode: Node | undefined
      let bindNameNode: Node | undefined
      let bindTypeNode: Node | undefined

      for (const capture of match.captures) {
        if (capture.name === 'name') {
          nameNode = capture.node
        } else if (capture.name === 'import') {
          importNode = capture.node
        } else if (capture.name === 'bind.name') {
          bindNameNode = capture.node
        } else if (capture.name === 'bind.type') {
          bindTypeNode = capture.node
        } else if (capture.name.startsWith('definition.')) {
          const kind = capture.name.slice('definition.'.length)
          if (SYMBOL_KINDS.has(kind)) definitionKind = kind as SymbolKind
          rangeNode = capture.node
        } else if (capture.name.startsWith('reference.')) {
          refNode = capture.node
        }
      }

      if (importNode) {
        const raw = unquote(importNode.text).trim()
        if (raw) facts.imports.push({ raw })
      }

      if (bindNameNode && bindTypeNode) {
        facts.typeBindings.push({ name: bindNameNode.text, type: bindTypeNode.text })
      }

      if (nameNode && definitionKind && rangeNode) {
        facts.definitions.push({
          name: nameNode.text,
          kind: definitionKind,
          startLine: rangeNode.startPosition.row + 1,
          endLine: rangeNode.endPosition.row + 1,
          startIndex: rangeNode.startIndex,
          endIndex: rangeNode.endIndex
        })
      } else if (nameNode && refNode) {
        const receiver = receiverName(nameNode)
        const isNew = /new_expression|object_creation/.test(refNode.type)
        facts.references.push({
          name: nameNode.text,
          startIndex: nameNode.startIndex,
          line: nameNode.startPosition.row + 1,
          ...(receiver ? { receiver } : {}),
          ...(isNew ? { isNew: true } : {})
        })
      }
    }
  }
}

// Field names that hold the receiver/qualifier across the grammars we support:
// member_expression.object (JS), attribute.object (Py), method_invocation.object
// (Java), selector_expression.operand (Go), member_access_expression.expression
// (C#), field_expression.value (Rust).
const RECEIVER_FIELDS = ['object', 'operand', 'expression', 'value'] as const

/** Simple receiver identifier (`obj`, `this`, `mod`) of a member call, or undefined. */
function receiverName(nameNode: Node): string | undefined {
  const parent = nameNode.parent
  if (!parent) return undefined
  let recv: Node | null = null
  for (const field of RECEIVER_FIELDS) {
    recv = parent.childForFieldName(field)
    if (recv) break
  }
  if (!recv || recv.startIndex === nameNode.startIndex) return undefined
  const text = recv.text
  return /^[A-Za-z_$][\w$]*$/.test(text) ? text : undefined
}
