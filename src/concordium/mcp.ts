// src/concordium/mcp.ts
// Minimal client for Concordium's hosted Agent Registry MCP server (JSON-RPC 2.0 over HTTP)
// and its REST twins. The server holds no keys: builders return { hex, schema_json } to sign locally.
import { MCP_URL } from './config';

export class McpError extends Error {}

let nextId = 1;

/** Calls an MCP tool and returns its result, parsed from JSON when the text is JSON. */
export async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  if (!res.ok) throw new McpError(`MCP ${name}: HTTP ${res.status} ${raw.slice(0, 300)}`);
  const body = JSON.parse(extractJson(raw));
  if (body.error) throw new McpError(`MCP ${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
  const text: string | undefined = body.result?.content?.[0]?.text;
  if (body.result?.isError) throw new McpError(`MCP ${name}: ${text ?? 'tool error'}`);
  if (text === undefined) throw new McpError(`MCP ${name}: empty result`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Plain GET on the REST endpoints (/v1/check-badge/{badge}, /v1/get-badge-JSON/{badge}, ...). */
export async function rest<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${MCP_URL}${path}`, { headers: { accept: 'application/json' } });
  const raw = await res.text();
  if (!res.ok) throw new McpError(`GET ${path}: HTTP ${res.status} ${raw.slice(0, 300)}`);
  return JSON.parse(raw) as T;
}

/** The server may answer as SSE ("data: {...}"); keep the JSON part. */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const line = trimmed.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new McpError(`Unexpected MCP response: ${trimmed.slice(0, 200)}`);
  return line.slice(5).trim();
}

/** Shape returned by every build_* tool, per the MCP service docs. */
export interface BuiltPayload {
  hex: string;
  schema_json?: unknown;
  // Possibly more fields (entrypoint, contract, energy...). Unverified: logged on first real run.
  [key: string]: unknown;
}
