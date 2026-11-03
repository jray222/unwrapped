import net from 'node:net';
import dns from 'node:dns';
import * as cheerio from 'cheerio';
import { config } from '../config.js';

export class SsrfBlockedError extends Error {
  code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
    Object.defineProperty(this, 'code', {
      value: 'SSRF_BLOCKED',
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/** The remote site answered, but with an HTTP error status (e.g. 403 bot-block, 404). */
export class FetchHttpError extends Error {
  constructor(public status: number, statusText: string) {
    super(`Fetch failed with HTTP status ${status} (${statusText})`);
    this.name = 'FetchHttpError';
  }
}

/** The fetch exceeded the configured timeout. */
export class FetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Fetch timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

/** The site served a bot-check / captcha page instead of the product page. */
export class BotWallError extends Error {
  constructor(message = 'The site served a bot-check page instead of the product page.') {
    super(message);
    this.name = 'BotWallError';
  }
}

/** Honest, identifiable request headers. We do not impersonate a browser to get past a site's bot protection. */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'Unwrapped/2.0 (self-hosted family wish list; product-autofill)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/*;q=0.8,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Expands an IPv6 address string into 8 16-bit numerical hextets,
 * resolving double colons (::) and embedded IPv4 dotted quad notations.
 */
function parseIpv6Hextets(ip: string): number[] | null {
  const norm = ip.toLowerCase().trim();
  const lastColon = norm.lastIndexOf(':');
  if (lastColon === -1) return null;
  const suffix = norm.slice(lastColon + 1);
  let prefix = norm;
  let ipv4Hextets: number[] = [];

  if (suffix.includes('.')) {
    const parts = suffix.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map(p => parseInt(p, 10));
    if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return null;
    ipv4Hextets = [
      (nums[0] << 8) | nums[1],
      (nums[2] << 8) | nums[3],
    ];
    prefix = norm.slice(0, lastColon);
  }

  const doubleColonCount = (prefix.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let leftParts: string[] = [];
  let rightParts: string[] = [];

  if (doubleColonCount === 1) {
    const [left, right] = prefix.split('::');
    leftParts = left ? left.split(':') : [];
    rightParts = right ? right.split(':') : [];
  } else {
    leftParts = prefix.split(':');
  }

  const targetLength = 8 - ipv4Hextets.length;
  if (doubleColonCount === 0) {
    if (leftParts.length !== targetLength) return null;
  } else {
    const missing = targetLength - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    const zeros = new Array(missing).fill('0');
    leftParts = [...leftParts, ...zeros, ...rightParts];
  }

  const fullParts = [...leftParts.map(p => parseInt(p || '0', 16)), ...ipv4Hextets];
  if (fullParts.length !== 8 || fullParts.some(n => isNaN(n) || n < 0 || n > 0xffff)) {
    return null;
  }
  return fullParts;
}

/**
 * Validates whether an IP address is a public, globally-routable address.
 * Rejects private, loopback, link-local, multicast, documentation, broadcast,
 * CGNAT, and cloud metadata ranges for both IPv4 and IPv6.
 */
export function isPublicIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  const ipType = net.isIP(trimmed);
  if (ipType === 0) return false;

  if (ipType === 4) {
    const parts = trimmed.split('.');
    if (parts.length !== 4) return false;
    const octets = parts.map(p => {
      if (!/^\d+$/.test(p)) return -1;
      if (p.length > 1 && p.startsWith('0')) return -1;
      const n = parseInt(p, 10);
      return n >= 0 && n <= 255 ? n : -1;
    });
    if (octets.some(o => o === -1)) return false;

    const [o0, o1, o2] = octets;

    // 0.0.0.0/8 (Current network)
    if (o0 === 0) return false;

    // 10.0.0.0/8 (Private network)
    if (o0 === 10) return false;

    // 100.64.0.0/10 (CGNAT: 100.64.0.0 - 100.127.255.255)
    if (o0 === 100 && o1 >= 64 && o1 <= 127) return false;

    // 127.0.0.0/8 (Loopback)
    if (o0 === 127) return false;

    // 169.254.0.0/16 (Link-local & AWS/GCP/Azure cloud metadata 169.254.169.254)
    if (o0 === 169 && o1 === 254) return false;

    // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
    if (o0 === 172 && o1 >= 16 && o1 <= 31) return false;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (o0 === 192 && o1 === 0 && o2 === 0) return false;

    // 192.0.2.0/24 (TEST-NET-1 documentation)
    if (o0 === 192 && o1 === 0 && o2 === 2) return false;

    // 192.168.0.0/16 (Private network)
    if (o0 === 192 && o1 === 168) return false;

    // 198.18.0.0/15 (Benchmarking: 198.18.0.0 - 198.19.255.255)
    if (o0 === 198 && (o1 === 18 || o1 === 19)) return false;

    // 198.51.100.0/24 (TEST-NET-2 documentation)
    if (o0 === 198 && o1 === 51 && o2 === 100) return false;

    // 203.0.113.0/24 (TEST-NET-3 documentation)
    if (o0 === 203 && o1 === 0 && o2 === 113) return false;

    // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
    if (o0 >= 224 && o0 <= 239) return false;

    // 240.0.0.0/4 (Reserved / Broadcast: 240.0.0.0 - 255.255.255.255)
    if (o0 >= 240) return false;

    return true;
  }

  if (ipType === 6) {
    const norm = trimmed.toLowerCase();
    const hextets = parseIpv6Hextets(norm);
    if (!hextets) return false;

    const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

    // :: (Unspecified address)
    if (hextets.every(h => h === 0)) return false;

    // ::1 (Loopback)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
      return false;
    }

    // fe80::/10 (Link-local unicast: 0xfe80 - 0xfebf)
    if ((h0 & 0xffc0) === 0xfe80) return false;

    // fc00::/7 (Unique local address: 0xfc00 - 0xfdff)
    if ((h0 & 0xfe00) === 0xfc00) return false;

    // ff00::/8 (Multicast)
    if ((h0 & 0xff00) === 0xff00) return false;

    // 2001:db8::/32 (Documentation)
    if (h0 === 0x2001 && h1 === 0x0db8) return false;

    // 100::/64 (Discard prefix)
    if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return false;

    // IPv4-mapped IPv6: ::ffff:a.b.c.d (0:0:0:0:0:ffff:xxxx:xxxx)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      const o1 = (h6 >> 8) & 0xff;
      const o2 = h6 & 0xff;
      const o3 = (h7 >> 8) & 0xff;
      const o4 = h7 & 0xff;
      return isPublicIp(`${o1}.${o2}.${o3}.${o4}`);
    }

    // IPv4-compatible IPv6 (deprecated): ::a.b.c.d (0:0:0:0:0:0:xxxx:xxxx)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && (h6 !== 0 || h7 > 1)) {
      const o1 = (h6 >> 8) & 0xff;
      const o2 = h6 & 0xff;
      const o3 = (h7 >> 8) & 0xff;
      const o4 = h7 & 0xff;
      return isPublicIp(`${o1}.${o2}.${o3}.${o4}`);
    }

    // 64:ff9b::/96 (IPv4/IPv6 translation)
    if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
      const o1 = (h6 >> 8) & 0xff;
      const o2 = h6 & 0xff;
      const o3 = (h7 >> 8) & 0xff;
      const o4 = h7 & 0xff;
      return isPublicIp(`${o1}.${o2}.${o3}.${o4}`);
    }

    // 2002::/16 (6to4 translation: hextets 1 and 2 are embedded IPv4)
    if (h0 === 0x2002) {
      const o1 = (h1 >> 8) & 0xff;
      const o2 = h1 & 0xff;
      const o3 = (h2 >> 8) & 0xff;
      const o4 = h2 & 0xff;
      return isPublicIp(`${o1}.${o2}.${o3}.${o4}`);
    }

    return true;
  }

  return false;
}

/**
 * Validates a target URL against SSRF vulnerabilities:
 * - Checks scheme (only http/https allowed)
 * - Disallows credentials in URL
 * - Restricts to default ports (80/443 or none)
 * - Blocks internal hostnames
 * - Resolves DNS and verifies every resolved IP is public
 */
export async function validateTargetUrl(
  rawUrl: string,
  customResolver?: (hostname: string) => Promise<string[]>
): Promise<{ url: URL; pinnedIp: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err: any) {
    throw new SsrfBlockedError(`Invalid URL: ${err.message}`);
  }

  // Only allow http: and https: protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Forbidden protocol: ${url.protocol}. Only http and https are allowed.`);
  }

  // Reject credentials in URL
  if (url.username || url.password) {
    throw new SsrfBlockedError('Credentials in URL are not allowed.');
  }

  // Only allow default ports: '', '80', '443'
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new SsrfBlockedError(`Non-standard port ${url.port} is not allowed.`);
  }

  const rawHost = url.hostname.trim();
  const lowerHost = rawHost.toLowerCase().replace(/^\[|\]$/g, '');

  if (!lowerHost) {
    throw new SsrfBlockedError('Empty hostname is not allowed.');
  }

  // Reject forbidden hostnames
  const forbiddenExact = new Set([
    'localhost',
    'metadata.google.internal',
    'metadata',
    'host.docker.internal',
  ]);
  if (forbiddenExact.has(lowerHost)) {
    throw new SsrfBlockedError(`Forbidden hostname: ${lowerHost}`);
  }

  if (
    lowerHost.endsWith('.local') ||
    lowerHost.endsWith('.internal') ||
    lowerHost.endsWith('.localhost') ||
    lowerHost.endsWith('.lan') ||
    lowerHost.endsWith('.home.arpa')
  ) {
    throw new SsrfBlockedError(`Forbidden domain suffix: ${lowerHost}`);
  }

  // If hostname is an IP literal
  const ipType = net.isIP(lowerHost);
  if (ipType !== 0) {
    if (!isPublicIp(lowerHost)) {
      throw new SsrfBlockedError(`SSRF protection: IP literal ${lowerHost} is not a public IP address.`);
    }
    return { url, pinnedIp: lowerHost };
  }

  // Resolve DNS
  let addresses: string[] = [];
  if (customResolver) {
    try {
      addresses = await customResolver(url.hostname);
    } catch (err: any) {
      if ((err as any).code === 'SSRF_BLOCKED') throw err;
      throw new SsrfBlockedError(`DNS resolution failed for ${url.hostname}: ${err.message}`);
    }
  } else {
    try {
      const lookups = await dns.promises.lookup(url.hostname, { all: true });
      addresses = lookups.map(l => l.address);
    } catch (err: any) {
      throw new SsrfBlockedError(`DNS resolution failed for ${url.hostname}: ${err.message}`);
    }
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError(`No IP addresses resolved for hostname: ${url.hostname}`);
  }

  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new SsrfBlockedError(
        `SSRF protection: IP ${addr} resolved for ${url.hostname} is not a public IP address.`
      );
    }
  }

  return { url, pinnedIp: addresses[0] };
}

/**
 * Safely fetches a remote URL buffer with strict SSRF defenses on every redirect hop,
 * byte limit enforcement, and timeout handling.
 */
export async function safeFetchBuffer(
  rawUrl: string,
  options?: {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    /** When true, stop reading at maxBytes and return what was read instead of throwing (for HTML, where metadata is near the top). */
    truncate?: boolean;
    customResolver?: (hostname: string) => Promise<string[]>;
    customFetch?: typeof fetch;
  }
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  const maxBytes = options?.maxBytes ?? config.autofillMaxHtmlBytes;
  const timeoutMs = options?.timeoutMs ?? config.autofillTimeoutMs;
  const maxRedirects = options?.maxRedirects ?? config.autofillMaxRedirects;
  const truncate = options?.truncate ?? false;
  const customResolver = options?.customResolver;
  const fetchFn = options?.customFetch ?? fetch;

  let currentUrl = rawUrl;
  let redirectCount = 0;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(currentUrl)) {
      throw new SsrfBlockedError(`Redirect loop detected at ${currentUrl}`);
    }
    visited.add(currentUrl);

    // Validate on EVERY hop:
    const { url: validatedUrl } = await validateTargetUrl(currentUrl, customResolver);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(validatedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: REQUEST_HEADERS,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw new FetchTimeoutError(timeoutMs);
      }
      throw err;
    }

    // Check for redirects: 301, 302, 303, 307, 308
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timer);
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new SsrfBlockedError(`Exceeded maximum allowed redirects (${maxRedirects})`);
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`HTTP ${response.status} redirect without Location header`);
      }
      const nextUrl = new URL(location, validatedUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      clearTimeout(timer);
      throw new FetchHttpError(response.status, response.statusText);
    }

    // Check Content-Length header if present
    const clHeader = response.headers.get('content-length');
    if (clHeader) {
      const cl = parseInt(clHeader, 10);
      if (!truncate && !isNaN(cl) && cl > maxBytes) {
        clearTimeout(timer);
        throw new Error(`Payload size ${cl} exceeds maximum limit of ${maxBytes} bytes`);
      }
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      if (response.body && typeof (response.body as any).getReader === 'function') {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.length;
              if (totalBytes > maxBytes) {
                await reader.cancel();
                if (truncate) {
                  chunks.push(Buffer.from(value.subarray(0, value.length - (totalBytes - maxBytes))));
                  break;
                }
                throw new Error(`Payload size exceeded limit of ${maxBytes} bytes`);
              }
              chunks.push(Buffer.from(value));
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        const ab = await response.arrayBuffer();
        if (ab.byteLength > maxBytes && !truncate) {
          throw new Error(`Payload size exceeded limit of ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(ab).subarray(0, maxBytes));
      }
      clearTimeout(timer);
      return {
        buffer: Buffer.concat(chunks),
        contentType,
        finalUrl: validatedUrl.toString(),
      };
    } catch (err: any) {
      clearTimeout(timer);
      throw err;
    }
  }
}

export interface AutofillResult {
  name: string;
  price_cents: number | null;
  store_name: string;
  store_url: string;
  image_url: string | null;
  sanitized_domain: string;
  description?: string | null;
}

function parsePriceToCents(raw: any): number | null {
  if (typeof raw === 'number') {
    if (isNaN(raw) || raw < 0) return null;
    return Math.round(raw * 100);
  }
  if (typeof raw !== 'string') return null;
  const str = raw.trim();
  if (!str) return null;

  const numMatch = str.match(/[\d.,]+/);
  if (!numMatch) return null;
  let candidate = numMatch[0];

  if (candidate.includes('.') && candidate.includes(',')) {
    if (candidate.lastIndexOf('.') > candidate.lastIndexOf(',')) {
      candidate = candidate.replace(/,/g, '');
    } else {
      candidate = candidate.replace(/\./g, '').replace(',', '.');
    }
  } else if (candidate.includes(',')) {
    const afterComma = candidate.slice(candidate.lastIndexOf(',') + 1);
    if (afterComma.length === 2) {
      candidate = candidate.replace(',', '.');
    } else {
      candidate = candidate.replace(/,/g, '');
    }
  }

  const val = parseFloat(candidate);
  if (isNaN(val) || val < 0) return null;
  return Math.round(val * 100);
}

const BOT_WALL_PATTERN =
  /robot or human|are you a (human|robot)|captcha|access denied|just a moment|verify you are (a )?human|unusual traffic|pardon our interruption/i;

function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates a product URL, safely fetches and parses HTML metadata (OpenGraph, JSON-LD, title, price, store),
 * and returns structured product info.
 */
export async function autofillProductUrl(
  rawUrl: string,
  options?: {
    customResolver?: (hostname: string) => Promise<string[]>;
    customFetch?: typeof fetch;
    htmlOverride?: string;
  }
): Promise<AutofillResult> {
  const { url } = await validateTargetUrl(rawUrl, options?.customResolver);

  let html: string;
  let finalUrl: string;

  if (options?.htmlOverride !== undefined) {
    html = options.htmlOverride;
    finalUrl = url.toString();
  } else {
    const result = await safeFetchBuffer(rawUrl, {
      maxBytes: config.autofillMaxHtmlBytes,
      timeoutMs: config.autofillTimeoutMs,
      maxRedirects: config.autofillMaxRedirects,
      truncate: true,
      customResolver: options?.customResolver,
      customFetch: options?.customFetch,
    });
    html = result.buffer.toString('utf8');
    finalUrl = result.finalUrl;
  }

  const parsedFinal = new URL(finalUrl);
  const sanitized_domain = parsedFinal.hostname.replace(/^www\./i, '').toLowerCase();

  const $ = cheerio.load(html);

  let jsonLdName: string | null = null;
  let jsonLdPrice: number | null = null;
  let jsonLdImage: string | null = null;
  let jsonLdBrand: string | null = null;

  $('script[type="application/ld+json"]').each((_, elem) => {
    try {
      const rawText = $(elem).text().trim();
      if (!rawText) return;
      const parsed = JSON.parse(rawText);

      const inspectObject = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        const type = obj['@type'];
        const isProduct = Array.isArray(type)
          ? type.some(t => String(t).toLowerCase() === 'product')
          : typeof type === 'string' && type.toLowerCase() === 'product';

        if (isProduct) {
          if (!jsonLdName && obj.name && typeof obj.name === 'string') {
            jsonLdName = obj.name;
          }
          if (jsonLdPrice === null && obj.offers) {
            const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
            if (offers) {
              const p = offers.price ?? offers.lowPrice;
              if (p !== undefined && p !== null) {
                const parsedPrice = parsePriceToCents(p);
                if (parsedPrice !== null) jsonLdPrice = parsedPrice;
              }
            }
          }
          if (!jsonLdImage && obj.image) {
            if (typeof obj.image === 'string') {
              jsonLdImage = obj.image;
            } else if (Array.isArray(obj.image) && typeof obj.image[0] === 'string') {
              jsonLdImage = obj.image[0];
            } else if (obj.image.url && typeof obj.image.url === 'string') {
              jsonLdImage = obj.image.url;
            }
          }
          if (!jsonLdBrand && obj.brand) {
            if (typeof obj.brand === 'string') {
              jsonLdBrand = obj.brand;
            } else if (typeof obj.brand.name === 'string') {
              jsonLdBrand = obj.brand.name;
            }
          }
        }
      };

      if (Array.isArray(parsed)) {
        parsed.forEach(inspectObject);
      } else if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
        parsed['@graph'].forEach(inspectObject);
      } else {
        inspectObject(parsed);
      }
    } catch {
      // Ignore JSON-LD parsing errors
    }
  });

  const ogTitle = $('meta[property="og:title"]').attr('content');
  const twitterTitle = $('meta[name="twitter:title"]').attr('content');
  const metaTitle = $('meta[name="title"]').attr('content');
  const pageTitle = $('title').first().text();

  const metaDesc =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content');
  const cleanDescription = metaDesc ? cleanText(metaDesc) : null;

  const rawName = jsonLdName || ogTitle || twitterTitle || metaTitle || pageTitle || '';
  const cleanName = cleanText(rawName);

  const ogPrice =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('meta[property="og:price:amount"]').attr('content') ||
    $('meta[name="twitter:data1"]').attr('content') ||
    $('meta[itemprop="price"]').attr('content');

  const price_cents = jsonLdPrice ?? (ogPrice ? parsePriceToCents(ogPrice) : null);

  const ogSiteName = $('meta[property="og:site_name"]').attr('content');
  const twitterSite = $('meta[name="twitter:site"]').attr('content');
  let storeNameCandidate = ogSiteName || jsonLdBrand || twitterSite || '';
  if (storeNameCandidate) {
    storeNameCandidate = cleanText(storeNameCandidate);
  }
  if (!storeNameCandidate) {
    storeNameCandidate = sanitized_domain;
  }

  const ogImage =
    $('meta[property="og:image:secure_url"]').attr('content') ||
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('link[rel="image_src"]').attr('href');

  const rawImage = jsonLdImage || ogImage || null;
  let image_url: string | null = null;
  if (rawImage && typeof rawImage === 'string') {
    const trimmedImg = rawImage.trim();
    if (trimmedImg) {
      try {
        const resolved = new URL(trimmedImg, finalUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
          image_url = resolved.toString();
        }
      } catch {
        image_url = null;
      }
    }
  }

  const foundProductData = jsonLdName !== null || Boolean(ogTitle) || price_cents !== null;
  if (!foundProductData && BOT_WALL_PATTERN.test(`${pageTitle} ${$('body').text().slice(0, 2000)}`)) {
    throw new BotWallError();
  }
  if (!cleanName) {
    throw new Error('No product details found on that page.');
  }

  return {
    name: cleanName,
    price_cents,
    store_name: storeNameCandidate,
    store_url: finalUrl,
    image_url,
    sanitized_domain,
    description: cleanDescription,
  };
}
