import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export type NetworkPolicyOptions = {
  allowPrivateNetwork?: boolean;
  /** When set, private access is restricted to this one explicitly approved origin. */
  privateNetworkOrigin?: string;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
};

const SAFE_REJECTION = 'The requested network destination is not permitted by the local safety policy.';

/** Validate a network target immediately before a browser or fetch request. */
export async function assertSafeNetworkUrl(input: string | URL, options: NetworkPolicyOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    throw new Error('URL must be a valid http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not permitted.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await resolveHost(hostname, options.lookup);

  const privateAccessApproved =
    Boolean(options.allowPrivateNetwork) && (!options.privateNetworkOrigin || url.origin === options.privateNetworkOrigin);
  if (!addresses.length || addresses.some(({ address }) => !isPermittedAddress(address, privateAccessApproved))) {
    throw new Error(SAFE_REJECTION);
  }
  return url;
}

export function safeUrlForDisplay(input: string | URL): string {
  try {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'unavailable URL';
  }
}

export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: NetworkPolicyOptions & { maxRedirects?: number; timeoutMs?: number; maxResponseBytes?: number } = {}
): Promise<Response> {
  let current = await assertSafeNetworkUrl(input, options);
  const maxRedirects = options.maxRedirects ?? 5;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await fetch(current, { ...init, redirect: 'manual', signal: controller.signal });
    } catch {
      throw new Error('Network request failed.');
    } finally {
      clearTimeout(timeout);
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(contentLength) && contentLength > (options.maxResponseBytes ?? 2_000_000)) {
      await response.body?.cancel();
      throw new Error('Network response exceeded the safety size limit.');
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return withBoundResponseBody(response, options.maxResponseBytes ?? 2_000_000);
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === maxRedirects) {
      throw new Error('Network redirect limit exceeded.');
    }
    current = await assertSafeNetworkUrl(new URL(location, current), options);
  }

  throw new Error('Network redirect limit exceeded.');
}

function withBoundResponseBody(response: Response, maxResponseBytes: number): Response {
  if (!response.body) return response;
  let received = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxResponseBytes) {
          controller.error(new Error('Network response exceeded the safety size limit.'));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
  return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function resolveHost(
  hostname: string,
  resolver: NetworkPolicyOptions['lookup']
): Promise<Array<{ address: string; family: number }>> {
  try {
    if (resolver) return await resolver(hostname, { all: true, verbatim: true });
    return (await dnsLookup(hostname, { all: true, verbatim: true })) as Array<{ address: string; family: number }>;
  } catch {
    throw new Error(SAFE_REJECTION);
  }
}

function isPermittedAddress(address: string, allowPrivateNetwork: boolean): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPermittedIpv4(address, allowPrivateNetwork);
  if (family === 6) return isPermittedIpv6(address, allowPrivateNetwork);
  return false;
}

function isPermittedIpv4(address: string, allowPrivateNetwork: boolean): boolean {
  const [first, second] = address.split('.').map(Number);
  if (
    first === 0 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    isDocumentationIpv4(address)
  ) {
    return false;
  }
  const privateRange =
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  return allowPrivateNetwork || !privateRange;
}

function isDocumentationIpv4(address: string): boolean {
  return address.startsWith('192.0.2.') || address.startsWith('198.51.100.') || address.startsWith('203.0.113.');
}

function isPermittedIpv6(address: string, allowPrivateNetwork: boolean): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || isIpv6LinkLocal(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false;
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return allowPrivateNetwork;

  // Node may return IPv4-mapped IPv6 literals. Re-run their embedded IPv4
  // value through the same policy instead of treating the representation as public.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPermittedIpv4(mapped[1], allowPrivateNetwork);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPermittedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, allowPrivateNetwork);
  }
  return true;
}

function isIpv6LinkLocal(address: string): boolean {
  const firstHextet = Number.parseInt(address.split(':', 1)[0], 16);
  return Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80;
}
