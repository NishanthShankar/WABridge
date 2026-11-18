import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector } from 'undici';

/**
 * Outbound requests to URLs a client gave us (media, pictures, webhooks) must not reach this
 * machine or its private network: otherwise anyone with an API key could make the bridge read
 * http://127.0.0.1:4000/admin, a router page or a cloud metadata endpoint (SSRF).
 *
 * The check is in the DNS lookup of the connection itself, so it covers every redirect hop and
 * a hostname that resolves to a public address once and a private one the next time.
 *
 * Self-hosters who serve media from their own LAN can set WABRIDGE_ALLOW_PRIVATE_URLS=1.
 */

const blocked = new BlockList();
// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this" network
blocked.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, cloud metadata
blocked.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blocked.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
blocked.addSubnet('192.0.2.0', 24, 'ipv4'); // documentation
blocked.addSubnet('192.168.0.0', 16, 'ipv4'); // private
blocked.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blocked.addSubnet('198.51.100.0', 24, 'ipv4'); // documentation
blocked.addSubnet('203.0.113.0', 24, 'ipv4'); // documentation
blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, broadcast
// IPv6
blocked.addAddress('::', 'ipv6'); // unspecified
blocked.addAddress('::1', 'ipv6'); // loopback
blocked.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 (embeds IPv4)
blocked.addSubnet('100::', 64, 'ipv6'); // discard
blocked.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blocked.addSubnet('fc00::', 7, 'ipv6'); // unique local
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** true for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible (::10.0.0.1) forms: judge the IPv4 inside.
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !blocked.check(address, 'ipv6');
}

export const allowPrivateUrls = () =>
  process.env.WABRIDGE_ALLOW_PRIVATE_URLS === '1';

export class PrivateAddressError extends Error {
  code = 'EPRIVATEADDRESS';
  statusCode = 400;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup that refuses private addresses. Same signature, so it drops into a socket connect. */
export function safeLookup(
  hostname: string,
  options: object,
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (!allowPrivateUrls()) {
      const bad = list.find((a) => !isPublicAddress(a.address));
      if (bad || list.length === 0)
        return callback(
          new PrivateAddressError(
            `${hostname} is not a public internet address`,
          ),
          [],
        );
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const connector = buildConnector({
  lookup: safeLookup,
} as buildConnector.BuildOptions);

/**
 * Connections made through this refuse private addresses, on every redirect hop: a hostname is
 * checked when it resolves, a literal IP (which skips DNS) before connecting.
 */
export const safeDispatcher = new Agent({
  connect: (opts, callback) => {
    const host = opts.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivateUrls() && isIP(host) && !isPublicAddress(host)) {
      callback(
        new PrivateAddressError(`${host} is not a public internet address`),
        null,
      );
      return;
    }
    connector(opts, callback);
  },
});

/**
 * A literal IP in the URL never goes through DNS, so check it here too. Throws
 * PrivateAddressError for a URL that isn't http(s) or names a private address.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PrivateAddressError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new PrivateAddressError('URL must be http or https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateUrls() && isIP(host) && !isPublicAddress(host))
    throw new PrivateAddressError(`${host} is not a public internet address`);
  return url;
}

/** fetch for client-supplied URLs: public addresses only, redirects checked hop by hop. */
export const safeFetch: typeof fetch = async (input, init) => {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  assertPublicUrl(raw); // rejects, like fetch does, rather than throwing
  return fetch(input, { ...init, dispatcher: safeDispatcher } as RequestInit);
};

/** "fetch failed" hides the reason in err.cause: return the most specific message. */
export function errorMessage(err: unknown): string {
  let e = err as { message?: string; cause?: unknown } | undefined;
  let msg = e?.message ?? String(err);
  while (e?.cause) {
    e = e.cause as { message?: string; cause?: unknown };
    if (e?.message) msg = e.message;
  }
  return msg;
}
