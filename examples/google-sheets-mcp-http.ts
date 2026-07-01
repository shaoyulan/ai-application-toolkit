/**
 * A remote (Streamable HTTP) MCP server that exposes Google Sheets operations
 * as toolkit tools — read ranges, append rows, and inspect a spreadsheet.
 *
 * Best-practice layering, matching the MCP authorization spec's separation of
 * concerns:
 *
 *   1. WHO MAY CALL THE SERVER — `createBearerVerifier` validates the caller's
 *      OAuth 2.1 JWT at the transport boundary (this process is a *resource
 *      server*; it does not issue tokens). `defineScopeGuardrail` then gates the
 *      write tool behind a "sheets:write" scope. Both are opt-in via env so you
 *      can run unprotected on localhost during development.
 *
 *   2. HOW THE SERVER REACHES GOOGLE — a *Service Account* (server-to-server,
 *      no interactive consent). Its credentials come from the environment, never
 *      from source. Share each target spreadsheet with the service account's
 *      email, and minimise its OAuth scopes.
 *
 * Defense in depth: an optional `ALLOWED_SPREADSHEET_IDS` allowlist means even a
 * valid caller can only touch spreadsheets you've explicitly approved.
 *
 * Required env:
 *   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account JSON key
 * Optional env:
 *   PORT                            default 3000
 *   ALLOWED_SPREADSHEET_IDS         comma-separated allowlist (recommended)
 *   OAUTH_JWKS_URI / OAUTH_ISSUER / OAUTH_AUDIENCE   enable bearer protection
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
 *   ALLOWED_SPREADSHEET_IDS=1AbC...,1XyZ... \
 *   pnpm --filter @ai-application-toolkit/examples google-sheets-mcp-http
 */
import { google } from 'googleapis'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail, defineScopeGuardrail } from '@ai-application-toolkit/guardrail'
import { startHttpMcpServer, createBearerVerifier } from '@ai-application-toolkit/mcp'
import { ToolkitError } from '@ai-application-toolkit/core'

// --- Google client (Service Account, lazily-built singleton) ----------------
// Minimal scopes: read + write to spreadsheet *content* only. No Drive access,
// so this server can never list, move, or delete files.
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
  // keyFile is read from GOOGLE_APPLICATION_CREDENTIALS automatically.
})
const sheets = google.sheets({ version: 'v4', auth })

// --- Spreadsheet allowlist (defense in depth) -------------------------------
const allowed = new Set(
  (process.env.ALLOWED_SPREADSHEET_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

function assertAllowed(spreadsheetId: string): void {
  if (allowed.size > 0 && !allowed.has(spreadsheetId)) {
    // Surfaces to the model as a tool error, not a crash.
    throw new ToolkitError({ code: 'FORBIDDEN', message: `spreadsheet not in allowlist: ${spreadsheetId}` })
  }
}

// --- Tools ------------------------------------------------------------------
const readRange = defineTool({
  id: 'sheets_read_range',
  description: 'Read cell values from an A1 range, e.g. "Sheet1!A1:C10".',
  input: {
    type: 'object',
    properties: {
      spreadsheetId: { type: 'string' },
      range: { type: 'string' }
    },
    required: ['spreadsheetId', 'range'],
    additionalProperties: false
  },
  execute: async (input: { spreadsheetId: string; range: string }) => {
    assertAllowed(input.spreadsheetId)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: input.spreadsheetId,
      range: input.range
    })
    return res.data.values ?? []
  }
})

const appendRows = defineTool({
  id: 'sheets_append_rows',
  description: 'Append rows of values after the last row of a range. Write op.',
  input: {
    type: 'object',
    properties: {
      spreadsheetId: { type: 'string' },
      range: { type: 'string', description: 'Anchor range, e.g. "Sheet1!A1".' },
      values: {
        type: 'array',
        description: '2D array: one inner array per row.',
        items: { type: 'array', items: {} }
      }
    },
    required: ['spreadsheetId', 'range', 'values'],
    additionalProperties: false
  },
  execute: async (input: { spreadsheetId: string; range: string; values: unknown[][] }) => {
    assertAllowed(input.spreadsheetId)
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: input.values }
    })
    return { updatedRange: res.data.updates?.updatedRange, updatedRows: res.data.updates?.updatedRows }
  }
})

const describeSpreadsheet = defineTool({
  id: 'sheets_describe',
  description: 'List the sheet (tab) names and dimensions of a spreadsheet.',
  input: {
    type: 'object',
    properties: { spreadsheetId: { type: 'string' } },
    required: ['spreadsheetId'],
    additionalProperties: false
  },
  execute: async (input: { spreadsheetId: string }) => {
    assertAllowed(input.spreadsheetId)
    const res = await sheets.spreadsheets.get({
      spreadsheetId: input.spreadsheetId,
      fields: 'properties.title,sheets.properties(title,gridProperties)'
    })
    return {
      title: res.data.properties?.title,
      sheets: (res.data.sheets ?? []).map((s) => ({
        title: s.properties?.title,
        rows: s.properties?.gridProperties?.rowCount,
        columns: s.properties?.gridProperties?.columnCount
      }))
    }
  }
})

// --- Optional bearer protection ---------------------------------------------
const protect = Boolean(process.env.OAUTH_JWKS_URI)
const authenticate = protect
  ? createBearerVerifier({
      jwksUri: process.env.OAUTH_JWKS_URI!,
      issuer: process.env.OAUTH_ISSUER,
      audience: process.env.OAUTH_AUDIENCE
    })
  : undefined

// Write tool requires the "sheets:write" scope; reads are open to any verified
// caller. With no bearer protection, this guardrail simply lets everything
// through (no scopes present, but the write tool then has nothing to check).
const guardrails = protect
  ? [defineScopeGuardrail({ required: { sheets_append_rows: ['sheets:write'] } })]
  : []

const port = Number(process.env.PORT ?? 3000)

await startHttpMcpServer({
  name: 'google-sheets-mcp',
  version: '1.0.0',
  tools: [readRange, appendRows, describeSpreadsheet],
  port,
  authenticate,
  resourceMetadataUrl: process.env.OAUTH_RESOURCE_METADATA_URL,
  runtime: { guardrails }
})

console.log(`Google Sheets MCP listening on http://localhost:${port}/mcp`)
console.log(`  auth:      ${protect ? 'OAuth bearer (verified)' : 'OPEN — localhost only!'}`)
console.log(`  allowlist: ${allowed.size > 0 ? [...allowed].join(', ') : 'none (all spreadsheets)'}`)
