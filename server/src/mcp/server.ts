import { AppError } from '../lib/errors';
import { isRecord } from '../lib/values';
import type { MandateRequest } from '../mandates/draft';
import type { MandateRequestResult, RequestStatus } from '../mandates/service';
import type { PurchaseRequest } from '../purchases/order';
import type { PurchaseResult, PurchaseStatusView } from '../purchases/service';
import {
  ProtocolError,
  ToolError,
  mandateArguments,
  noArguments,
  purchaseArguments,
  purchaseIdArgument,
  requestIdArgument,
} from './arguments';
import { INSTRUCTIONS, TOOLS } from './tools';

/**
 * A stateless MCP server over Streamable HTTP. Each POST carries one JSON-RPC message and gets one
 * JSON response; there is no server-initiated stream or session. The callbacks are already bound
 * to the authenticated agent, and none of them can approve anything.
 */

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MAX_BODY_BYTES = 64 * 1024;
const SERVER_INFO = { name: 'acme-pay', title: 'Acme Pay', version: '0.1.0' };

export interface McpCallbacks {
  requestMandate(input: MandateRequest): Promise<MandateRequestResult>;
  requestStatus(requestId: string): Promise<{ status: RequestStatus; approvalUrl?: string; expiresAt?: string }>;
  listMandates(): Promise<{
    mandates: readonly Record<string, unknown>[];
    approvals: readonly { kind: string; summary: string; approval_url: string; expires_at: string }[];
  }>;
  purchase(input: PurchaseRequest): Promise<PurchaseResult>;
  purchaseStatus(purchaseId: string): Promise<PurchaseStatusView>;
}

interface ToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

function success(body: Record<string, unknown>, lead?: string): ToolResult {
  const json = JSON.stringify(body);
  return {
    content: [{ type: 'text', text: lead === undefined ? json : `${lead}\n\n${json}` }],
    structuredContent: body,
  };
}

function linkLead(url: string | undefined): string | undefined {
  return url === undefined ? undefined : `Approve here: ${url} . Show this link to the person exactly as written.`;
}

function failure(error: unknown): ToolResult {
  const message =
    error instanceof ToolError || (error instanceof AppError && error.status < 500)
      ? error.message
      : 'Acme Pay could not complete the request. Nothing was charged. Try again.';
  return { content: [{ type: 'text', text: message.slice(0, 1_000) }], isError: true };
}

function withoutUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

async function runTool(name: string, args: Record<string, unknown>, callbacks: McpCallbacks): Promise<ToolResult> {
  switch (name) {
    case 'acme_request_mandate': {
      const input = mandateArguments(args);
      const result = await callbacks.requestMandate(input);
      return success(
        {
          request_id: result.requestId,
          status: result.status,
          approval_url: result.approvalUrl,
          expires_at: result.expiresAt,
          summary: result.summary,
        },
        linkLead(result.approvalUrl),
      );
    }
    case 'acme_request_status': {
      const requestId = requestIdArgument(args);
      const result = await callbacks.requestStatus(requestId);
      return success(
        withoutUndefined({
          request_id: requestId,
          status: result.status,
          approval_url: result.approvalUrl,
          expires_at: result.expiresAt,
        }),
        linkLead(result.approvalUrl),
      );
    }
    case 'acme_list_mandates': {
      noArguments(args);
      const result = await callbacks.listMandates();
      const links = result.approvals.map((approval) => `${approval.summary}: ${approval.approval_url}`);
      return success(
        { mandates: [...result.mandates], approvals: [...result.approvals] },
        links.length === 0
          ? undefined
          : `Waiting for the person (show each link exactly as written):\n${links.join('\n')}`,
      );
    }
    case 'acme_purchase': {
      const result = await callbacks.purchase(purchaseArguments(args));
      const body = withoutUndefined({
        purchase_id: result.purchaseId,
        status: result.status,
        reason: result.reason,
        approval_url: result.approvalUrl,
        expires_at: result.expiresAt,
        summary: result.summary,
      });
      if (result.status === 'unconfirmed') {
        return success(
          body,
          `The issuer has not confirmed this payment yet. Poll acme_purchase_status with purchase_id ${result.purchaseId} every 5 seconds for up to 2 minutes. Do not retry the purchase.`,
        );
      }
      return success(body, linkLead(result.approvalUrl));
    }
    case 'acme_purchase_status': {
      const result = await callbacks.purchaseStatus(purchaseIdArgument(args));
      return success(
        withoutUndefined({
          purchase_id: result.purchaseId,
          status: result.status,
          reason: result.reason,
          charged: result.charged,
          approval_url: result.approvalUrl,
          remaining_minor: result.remainingMinor,
        }),
        linkLead(result.approvalUrl),
      );
    }
    default:
      throw new ProtocolError(-32602, `Unknown tool: ${name}`);
  }
}

async function callTool(params: unknown, callbacks: McpCallbacks): Promise<ToolResult> {
  if (!isRecord(params) || typeof params.name !== 'string')
    throw new ProtocolError(-32602, 'tools/call params.name is required');
  const args = params.arguments ?? {};
  if (!isRecord(args)) throw new ProtocolError(-32602, 'arguments must be an object');
  try {
    return await runTool(params.name, args, callbacks);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    return failure(error);
  }
}

export async function dispatch(method: string, params: unknown, callbacks: McpCallbacks): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = isRecord(params) ? params.protocolVersion : undefined;
      if (typeof requested !== 'string') throw new ProtocolError(-32602, 'protocolVersion is required');
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(params, callbacks);
    default:
      throw new ProtocolError(-32601, `Unknown method: ${method}`);
  }
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, status, headers);
}

function accepts(header: string | null, type: string): boolean {
  return (header ?? '').split(',').some((part) => part.split(';')[0]?.trim().toLowerCase() === type);
}

/** Handles one Streamable HTTP request for an already authenticated agent. */
export async function handleMcpRequest(
  request: Request,
  callbacks: McpCallbacks,
  allowedOrigin: string,
): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== allowedOrigin) return rpcError(null, -32600, 'Origin not allowed', 403);
  if (request.method !== 'POST') return rpcError(null, -32600, 'Method not allowed; use POST', 405, { allow: 'POST' });
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(null, -32600, 'Unsupported MCP-Protocol-Version', 400);
  }
  const accept = request.headers.get('accept');
  if (!accepts(accept, 'application/json') || !accepts(accept, 'text/event-stream')) {
    return rpcError(null, -32600, 'Accept must include application/json and text/event-stream', 406);
  }
  if (!accepts(request.headers.get('content-type'), 'application/json')) {
    return rpcError(null, -32600, 'Content-Type must be application/json', 415);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return rpcError(null, -32600, 'Request body too large', 413);
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  if (!('id' in message)) return new Response(null, { status: 202 });
  const id = message.id;
  if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  try {
    return json({ jsonrpc: '2.0', id, result: await dispatch(message.method, message.params, callbacks) }, 200);
  } catch (error) {
    if (error instanceof ProtocolError) return rpcError(id, error.code, error.message, 200);
    return rpcError(id, -32603, 'Internal error', 200);
  }
}
