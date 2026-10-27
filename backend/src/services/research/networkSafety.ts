import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

const DEFAULT_MAX_REDIRECTS = 4;
const URL_CONTROL_CHARACTERS = /\p{Cc}/u;
const URL_ENCODED_CONTROL_CHARACTERS = /%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f]|c2%(?:8[0-9a-f]|9[0-9a-f]))/iu;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const blockedAddresses = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
  blockedAddresses.addSubnet(`::ffff:${network}`, 96 + prefix, "ipv6");
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}
blockedAddresses.addAddress("::ffff:168.63.129.16", "ipv6");

export interface SafeFetchOptions {
  label: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  headers: Readonly<Record<string, string>>;
  bytes: Buffer;
}

export interface SafeTextFetchResult extends Omit<SafeFetchResult, "bytes"> {
  text: string;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface SafeTransportResponse {
  status: number;
  headers: IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
}

type LookupHost = (hostname: string) => Promise<ResolvedAddress[]>;
type OpenTransport = (
  url: URL,
  address: ResolvedAddress,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
) => Promise<SafeTransportResponse>;

interface NativeRequestResponse extends AsyncIterable<Uint8Array> {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  destroy: () => void;
}

interface NativeRequestHandle {
  setHeader: (name: string, value: string) => void;
  once: (event: "error", listener: (error: Error) => void) => NativeRequestHandle;
  end: () => void;
}

type OpenNativeRequest = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: NativeRequestResponse) => void
) => NativeRequestHandle;

export interface PinnedRequestPlan {
  /** The actual network endpoint. Its hostname is always the DNS-vetted IP. */
  url: URL;
  /** Options intentionally omit `agent`, so Node's current global proxy agent remains active. */
  options: RequestOptions;
  /** The canonical origin Host header, installed only after proxy routing is fixed to `url`. */
  hostHeader: string;
}

/** Dependency hooks are exported only so the security boundary can be tested without real network access. */
export interface NetworkSafetyTestDependencies {
  lookup?: LookupHost;
  transport?: OpenTransport;
  nativeRequest?: OpenNativeRequest;
}

export class OutboundUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlPolicyError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super("响应超过允许的大小");
    this.name = "ResponseTooLargeError";
  }
}

/** Return true for a hostname that must never be contacted by outbound research fetches. */
export function isBlockedOutboundHostname(value: string): boolean {
  const hostname = normalizeHostname(value);
  return (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".home.arpa")
  );
}

/** Return true for loopback, private, link-local, metadata, multicast, and reserved IP space. */
export function isBlockedOutboundAddress(value: string): boolean {
  const address = stripIpv6Brackets(value.trim().split("%")[0]);
  const family = isIP(address);
  if (family === 4) {
    return blockedAddresses.check(address, "ipv4") || address === "168.63.129.16";
  }
  if (family === 6) {
    return blockedAddresses.check(address, "ipv6");
  }
  return true;
}

/**
 * Normalize one source-page URL without performing DNS or network I/O.
 *
 * Research parsers use this boundary for untrusted provider/feed output. It
 * accepts only credential-free public HTTP(S) URLs on the standard ports and
 * rejects localhost plus private/reserved IP literals. A trusted feed URL may
 * be supplied as the base for a relative RSS/Atom link; the resolved target is
 * subjected to the same policy.
 */
export function normalizePublicSourceUrl(
  value: string | undefined,
  baseUrl?: string
): string | undefined {
  if (!value || hasUnsafeUrlCharacters(value) || (baseUrl && hasUnsafeUrlCharacters(baseUrl))) {
    return undefined;
  }

  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || !url.hostname
      || url.username
      || url.password
      || url.port
    ) {
      return undefined;
    }

    const hostname = normalizeHostname(url.hostname);
    if (!hostname || isBlockedOutboundHostname(hostname)) return undefined;
    if (isIP(hostname) !== 0 && isBlockedOutboundAddress(hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Parse and resolve an outbound URL, rejecting any non-public destination.
 * Every DNS answer is checked, then the transport is pinned to one checked address.
 */
export async function validateOutboundUrl(
  input: string | URL,
  lookupHost: LookupHost = defaultLookupHost
): Promise<{ url: URL; address: ResolvedAddress }> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new OutboundUrlPolicyError("无效的出站 URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlPolicyError("出站请求仅允许 http(s) URL");
  }
  if (url.username || url.password) {
    throw new OutboundUrlPolicyError("出站 URL 不允许包含凭据");
  }
  if (url.port) {
    throw new OutboundUrlPolicyError("出站请求仅允许标准 HTTP/HTTPS 端口");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedOutboundHostname(hostname)) {
    throw new OutboundUrlPolicyError("出站请求目标主机被安全策略阻止");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isBlockedOutboundAddress(hostname)) {
      throw new OutboundUrlPolicyError("出站请求目标地址被安全策略阻止");
    }
    return { url, address: { address: hostname, family: literalFamily as 4 | 6 } };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookupHost(hostname);
  } catch {
    throw new OutboundUrlPolicyError("出站请求目标无法安全解析");
  }
  if (addresses.length === 0) {
    throw new OutboundUrlPolicyError("出站请求目标没有可用地址");
  }
  if (addresses.some((entry) => isBlockedOutboundAddress(entry.address))) {
    throw new OutboundUrlPolicyError("出站请求的 DNS 结果包含受限地址");
  }

  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return { url, address };
}

/** Fetch a binary body through the reusable outbound URL policy. */
export async function fetchBinaryWithOutboundPolicy(
  input: string | URL,
  options: SafeFetchOptions,
  dependencies: NetworkSafetyTestDependencies = {}
): Promise<SafeFetchResult> {
  assertFetchBounds(options);
  const lookupHost = dependencies.lookup ?? defaultLookupHost;
  const transport = dependencies.transport ?? (
    (url, address, headers, signal) =>
      openNativeTransport(url, address, headers, signal, dependencies.nativeRequest)
  );
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let current = input instanceof URL ? new URL(input.toString()) : new URL(input);
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (controller.signal.aborted) {
        throw new Error(`${options.label} 请求超时`);
      }

      const hop = await fetchOutboundHop(current, options, lookupHost, transport, controller.signal);
      if (hop.kind === "response") return hop.result;

      if (redirectCount >= maxRedirects) {
        throw new OutboundUrlPolicyError("出站请求重定向次数过多");
      }
      const next = new URL(hop.location, hop.from);
      if (hop.from.protocol === "https:" && next.protocol === "http:") {
        throw new OutboundUrlPolicyError("HTTPS redirects must not downgrade to HTTP");
      }
      current = next;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${options.label} 请求超时`);
    }
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`${options.label} 响应过大`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type OutboundHop =
  | { kind: "redirect"; location: string; from: URL }
  | { kind: "response"; result: SafeFetchResult };

/**
 * Validate and fetch exactly one URL. A redirect is returned (with its
 * response already closed) so the caller can apply the redirect policy;
 * any other answer is read within the size limit.
 */
async function fetchOutboundHop(
  current: URL,
  options: SafeFetchOptions,
  lookupHost: LookupHost,
  transport: OpenTransport,
  signal: AbortSignal
): Promise<OutboundHop> {
  const validated = await raceWithAbort(
    validateOutboundUrl(current, lookupHost),
    signal,
    `${options.label} 请求超时`
  );
  const response = await transport(
    validated.url,
    validated.address,
    {
      "User-Agent": "SpeakPlainlyResearch/0.1 (+local development)",
      Accept: "*/*",
      "Accept-Encoding": "identity",
      ...options.headers,
    },
    signal
  );

  const headers = normalizeHeaders(response.headers);
  let location: string | undefined;
  try {
    location = redirectLocation(response.status, headers);
  } catch (error) {
    response.close();
    throw error;
  }
  if (location) {
    response.close();
    return { kind: "redirect", location, from: validated.url };
  }

  try {
    const bytes = await readLimitedBody(response, options.maxBytes, signal);
    return {
      kind: "response",
      result: {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        url: validated.url.toString(),
        headers,
        bytes,
      },
    };
  } catch (error) {
    response.close();
    throw error;
  }
}

/** Fetch UTF-8 text through the same SSRF and streaming-size boundary. */
export async function fetchTextWithOutboundPolicy(
  input: string | URL,
  options: SafeFetchOptions,
  dependencies: NetworkSafetyTestDependencies = {}
): Promise<SafeTextFetchResult> {
  const result = await fetchBinaryWithOutboundPolicy(input, options, dependencies);
  const { bytes, ...rest } = result;
  return { ...rest, text: bytes.toString("utf8") };
}

async function defaultLookupHost(hostname: string): Promise<ResolvedAddress[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("DNS lookup timeout")), 5_000);
      }),
    ]);
    return entries
      .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
      .map((entry) => ({ address: entry.address, family: entry.family }));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function openNativeTransport(
  url: URL,
  address: ResolvedAddress,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  requestOverride?: OpenNativeRequest
): Promise<SafeTransportResponse> {
  return new Promise((resolve, reject) => {
    const request = requestOverride ?? (
      (url.protocol === "https:" ? httpsRequest : httpRequest) as OpenNativeRequest
    );
    const plan = buildPinnedRequestPlan(url, address, headers, signal);
    const req = request(plan.url, plan.options, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        close: () => response.destroy(),
      });
    });
    // Node's built-in HTTP proxy derives its absolute request target (or HTTPS
    // CONNECT endpoint) while constructing ClientRequest. Install the original
    // Host only afterwards so proxy/direct routing stays pinned to the vetted
    // IP, while the origin still receives the correct virtual-host header.
    req.setHeader("Host", plan.hostHeader);
    req.once("error", reject);
    req.end();
  });
}

/**
 * Build a request that is safe both with and without Node's environment proxy.
 *
 * The URL used by `http(s).request` contains the vetted IP. Consequently a
 * direct connection cannot re-resolve the untrusted hostname, and Node's global
 * proxy CONNECT/absolute-form target is also the vetted IP. The original
 * hostname is retained separately for HTTP virtual hosting plus HTTPS SNI and
 * certificate identity verification. `agent` is deliberately absent: when
 * `configureEnvProxy()` has installed a proxy-aware global agent it is used;
 * otherwise Node's ordinary global agent connects directly to the same IP.
 */
export function buildPinnedRequestPlan(
  url: URL,
  address: ResolvedAddress,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal
): PinnedRequestPlan {
  if (isIP(address.address) !== address.family) {
    throw new OutboundUrlPolicyError("Invalid vetted outbound address");
  }

  const pinnedUrl = new URL(url.toString());
  pinnedUrl.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  if (normalizeHostname(pinnedUrl.hostname) !== normalizeHostname(address.address)) {
    throw new OutboundUrlPolicyError("Unable to pin outbound request address");
  }

  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // Host is a security invariant derived from the validated origin URL. A
    // caller must never be able to replace it through SafeFetchOptions.headers.
    if (name.trim().toLowerCase() === "host") continue;
    safeHeaders[name] = value;
  }

  const originalHostname = normalizeHostname(url.hostname);
  const servername = url.protocol === "https:" && isIP(originalHostname) === 0
    ? originalHostname
    : undefined;
  return {
    url: pinnedUrl,
    options: {
      method: "GET",
      headers: safeHeaders,
      servername,
      rejectUnauthorized: true,
      signal,
    },
    hostHeader: url.host,
  };
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) {
    throw new Error(message);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(message));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function readLimitedBody(
  response: SafeTransportResponse,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const declaredLength = Number(firstHeaderValue(response.headers["content-length"]) ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ResponseTooLargeError();
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of response.body) {
    if (signal.aborted) {
      throw new Error("请求已中止");
    }
    const chunk = Buffer.from(rawChunk);
    total += chunk.length;
    if (total > maxBytes) {
      throw new ResponseTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function redirectLocation(status: number, headers: Readonly<Record<string, string>>): string | undefined {
  if (![301, 302, 303, 307, 308].includes(status)) {
    return undefined;
  }
  const location = headers.location?.trim();
  if (!location) {
    throw new OutboundUrlPolicyError("重定向响应缺少 Location");
  }
  return location;
}

function normalizeHeaders(
  headers: IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const first = firstHeaderValue(value);
    if (first !== undefined) {
      normalized[name.toLowerCase()] = first;
    }
  }
  return normalized;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function assertFetchBounds(options: SafeFetchOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError("maxBytes 必须是正整数");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("timeoutMs 必须是正整数");
  }
  if (
    options.maxRedirects !== undefined &&
    (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0)
  ) {
    throw new TypeError("maxRedirects 必须是非负整数");
  }
}

function normalizeHostname(value: string): string {
  return stripIpv6Brackets(value.trim().toLowerCase().replace(/\.$/, ""));
}

function hasUnsafeUrlCharacters(value: string): boolean {
  return URL_CONTROL_CHARACTERS.test(value) || URL_ENCODED_CONTROL_CHARACTERS.test(value);
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
