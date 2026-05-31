import { createInterface } from 'node:readline';

export async function runProxy(apiKey: string, url: string): Promise<void> {
  if (!apiKey) {
    process.stderr.write(
      'Error: QUALITYMAX_API_KEY is required.\n' +
      'Set it via the env var or pass --api-key <key>.\n' +
      'Get a key at https://app.qualitymax.io/settings/api-tokens\n'
    );
    process.exit(1);
  }

  process.stderr.write(`qmax-mcp: proxying stdio → ${url}\n`);

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
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json, text/event-stream',
        },
        body: trimmed,
      });

      if (!isRequest) continue;

      const contentType = res.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        await forwardSse(res, parsed);
      } else {
        const text = await res.text();
        if (text.trim()) process.stdout.write(text.trim() + '\n');
      }
    } catch (err) {
      if (isRequest) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const rpcError = {
          jsonrpc: '2.0',
          error: { code: -32603, message: `Transport error: ${errMsg}` },
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
