import { createInterface } from 'node:readline';

/**
 * The only endpoint to which this process may send a hosted bearer token.
 *
 * The trailing slash is load-bearing. The host answers `/api/mcp` with a 308 to
 * `/api/mcp/`, and `forwardProxyRequest` refuses redirects on purpose, so the
 * unslashed form makes every proxied request fail before it is ever sent.
 */
export const HOSTED_MCP_ENDPOINT = 'https://app.qualitymax.io/api/mcp/';

type FetchLike = typeof fetch;

/**
 * Do not make the bearer destination configurable. A redirect can otherwise
 * turn a convenience proxy into a credential-forwarding primitive.
 */
export function assertPinnedHostedEndpoint(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Hosted proxy endpoint is invalid.');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'app.qualitymax.io' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/api/mcp/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Hosted proxy endpoint is not the pinned QualityMax MCP endpoint.');
  }
  return parsed;
}

export async function forwardProxyRequest(
  apiKey: string,
  request: string,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  const endpoint = assertPinnedHostedEndpoint(HOSTED_MCP_ENDPOINT);
  return fetchImpl(endpoint, {
    method: 'POST',
    // Never follow redirects while an Authorization header is present.
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json, text/event-stream',
    },
    body: request,
  });
}

export async function runProxy(apiKey: string): Promise<void> {
  if (!apiKey) {
    process.stderr.write(
      'Error: QUALITYMAX_API_KEY is required.\n' +
      'Set it via the env var or pass --api-key <key>.\n' +
      'Get a key at https://app.qualitymax.io/settings/api-tokens\n'
    );
    process.exit(1);
  }

  process.stderr.write(`qmax-mcp: proxying stdio to ${HOSTED_MCP_ENDPOINT}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Notifications (no `id`) are fire-and-forget — forward but skip the response write.
    const isRequest = 'id' in parsed;

    try {
      const res = await forwardProxyRequest(apiKey, trimmed);

      if (!isRequest) continue;

      const contentType = res.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        await forwardSse(res, parsed);
      } else {
        const text = await res.text();
        if (text.trim()) process.stdout.write(text.trim() + '\n');
      }
    } catch {
      if (isRequest) {
        const rpcError = {
          jsonrpc: '2.0',
          // Deliberately generic: network errors can contain internal endpoint details.
          error: { code: -32603, message: 'Hosted proxy transport failed.' },
          id: parsed['id'] ?? null,
        };
        process.stdout.write(JSON.stringify(rpcError) + '\n');
      }
    }
  }
}

async function forwardSse(res: Response, req: Record<string, unknown>): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  let gotResponse = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.startsWith('data: ')) continue;
        const data = l.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        process.stdout.write(data + '\n');
        gotResponse = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  // If we got no SSE data, send a generic error response so the client
  // doesn't hang waiting for a reply to the request.
  if (!gotResponse) {
    const rpcError = {
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Empty SSE response from server' },
      id: req['id'] ?? null,
    };
    process.stdout.write(JSON.stringify(rpcError) + '\n');
  }
}
