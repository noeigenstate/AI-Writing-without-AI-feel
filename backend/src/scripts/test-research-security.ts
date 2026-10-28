import assert from "node:assert/strict";
import * as http from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { deflateSync } from "node:zlib";
import {
  buildMcporterInvocation,
  mcporterExecOptions,
  parseAgentReachSearchOutput,
} from "../services/research/agentReach.js";
import {
  enrichResearchImages,
  fetchSafeImageBinary,
  isSourcePageEligibleForImageDiscovery,
  validateDecodableRasterImage,
  validateGifStructure,
  validateJpegStructure,
  validatePngStructure,
  validateWebpStructure,
} from "../services/research/images.js";
import {
  buildPinnedRequestPlan,
  fetchBinaryWithOutboundPolicy,
  isBlockedOutboundAddress,
  isBlockedOutboundHostname,
  validateOutboundUrl,
} from "../services/research/networkSafety.js";
import type { ResearchItem } from "../services/research/types.js";

assert.equal(
  isSourcePageEligibleForImageDiscovery("https://news.google.com/rss/articles/encoded-story?oc=5"),
  false,
  "Google News wrappers must never lend their shared product thumbnail to a publisher article"
);
assert.equal(
  isSourcePageEligibleForImageDiscovery("https://news.google.com/articles/encoded-story"),
  false
);
assert.equal(
  isSourcePageEligibleForImageDiscovery("https://www.cmu.edu/news/stories/real-article"),
  true,
  "a resolved publisher article remains eligible for source-image discovery"
);

const blockedIpv4 = [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "198.18.0.1",
  "224.0.0.1",
  "240.0.0.1",
  "168.63.129.16",
];
for (const address of blockedIpv4) {
  assert.equal(isBlockedOutboundAddress(address), true, `${address} must be blocked`);
}

const blockedIpv6 = [
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:168.63.129.16",
  "64:ff9b::7f00:1",
  "2001:db8::1",
  "2002:7f00:1::",
  "fc00::1",
  "fe80::1",
  "ff02::1",
];
for (const address of blockedIpv6) {
  assert.equal(isBlockedOutboundAddress(address), true, `${address} must be blocked`);
}
assert.equal(isBlockedOutboundAddress("8.8.8.8"), false);
assert.equal(isBlockedOutboundAddress("2606:4700:4700::1111"), false);

for (const hostname of [
  "localhost",
  "api.localhost",
  "printer.local",
  "metadata.google.internal",
  "service.home.arpa",
]) {
  assert.equal(isBlockedOutboundHostname(hostname), true, `${hostname} must be blocked`);
}
assert.equal(isBlockedOutboundHostname("example.com"), false);

await assert.rejects(() => validateOutboundUrl("file:///etc/passwd"), /仅允许 http\(s\)/);
await assert.rejects(() => validateOutboundUrl("http://user:pass@example.com"), /不允许包含凭据/);
await assert.rejects(() => validateOutboundUrl("https://example.com:8443/image.png"), /仅允许标准/);
await assert.rejects(() => validateOutboundUrl("http://2130706433/admin"), /安全策略阻止/);
await assert.rejects(() => validateOutboundUrl("http://[::1]/admin"), /安全策略阻止/);
await assert.rejects(
  () =>
    validateOutboundUrl("https://mixed.example", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  /DNS 结果包含受限地址/
);

const pinnedPlanController = new AbortController();
const pinnedPlan = buildPinnedRequestPlan(
  new URL("https://public.example/assets/photo.jpg?size=large"),
  { address: "93.184.216.34", family: 4 },
  { Accept: "image/*", HOST: "attacker.internal" },
  pinnedPlanController.signal
);
assert.equal(pinnedPlan.url.toString(), "https://93.184.216.34/assets/photo.jpg?size=large");
assert.equal(pinnedPlan.hostHeader, "public.example");
assert.equal(pinnedPlan.options.servername, "public.example");
assert.equal(pinnedPlan.options.rejectUnauthorized, true);
assert.equal(Object.hasOwn(pinnedPlan.options, "agent"), false, "the current global agent must remain available");
assert.deepEqual(pinnedPlan.options.headers, { Accept: "image/*" });

const pinnedIpv6Plan = buildPinnedRequestPlan(
  new URL("https://public.example/v6.png"),
  { address: "2606:4700:4700::1111", family: 6 },
  {},
  pinnedPlanController.signal
);
assert.equal(pinnedIpv6Plan.url.toString(), "https://[2606:4700:4700::1111]/v6.png");
await assert.rejects(
  async () =>
    buildPinnedRequestPlan(
      new URL("https://public.example/bad.png"),
      { address: "93.184.216.34", family: 6 },
      {},
      pinnedPlanController.signal
    ),
  /Invalid vetted outbound address/
);

let directRequestUrl = "";
let directRequestOptions: HttpsRequestOptions | undefined;
const directRequestHeaders = new Map<string, string>();
const directResult = await fetchBinaryWithOutboundPolicy(
  "https://public.example/direct",
  {
    label: "pinned-direct-test",
    timeoutMs: 1_000,
    maxBytes: 32,
    headers: { Host: "attacker.internal", "X-Test": "preserved" },
  },
  {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    nativeRequest: (url, options, onResponse) => {
      directRequestUrl = url.toString();
      directRequestOptions = options;
      const handle = {
        setHeader: (name: string, value: string) => {
          directRequestHeaders.set(name.toLowerCase(), value);
        },
        once: () => handle,
        end: () => {
          const body = bodyFrom(Buffer.from("direct-ok"));
          onResponse({
            statusCode: 200,
            headers: { "content-type": "text/plain" },
            destroy: () => undefined,
            [Symbol.asyncIterator]: () => body[Symbol.asyncIterator](),
          });
        },
      };
      return handle;
    },
  }
);
assert.equal(directResult.bytes.toString("utf8"), "direct-ok");
assert.equal(directRequestUrl, "https://93.184.216.34/direct");
assert.equal(directRequestOptions?.servername, "public.example");
assert.equal(directRequestOptions?.rejectUnauthorized, true);
assert.equal(Object.hasOwn(directRequestOptions ?? {}, "agent"), false, "the no-proxy path must use the normal global agent");
assert.deepEqual(directRequestOptions?.headers, {
  "User-Agent": "SpeakPlainlyResearch/0.1 (+local development)",
  Accept: "*/*",
  "Accept-Encoding": "identity",
  "X-Test": "preserved",
});
assert.equal(directRequestHeaders.get("host"), "public.example", "caller Host must be replaced by the validated origin");

await testNodeGlobalProxyWithPinnedTargets();

let postBody = "";
const postRequests: string[] = [];
await assert.rejects(() => fetchBinaryWithOutboundPolicy(
  "https://public.example/search",
  {
    label: "authenticated-post-test",
    method: "POST",
    body: JSON.stringify({ query: "night running" }),
    headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
    maxRedirects: 0,
    timeoutMs: 1_000,
    maxBytes: 32,
  },
  {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    nativeRequest: (url, options, onResponse) => {
      postRequests.push(url.toString());
      assert.equal(options.method, "POST");
      assert.equal(options.servername, "public.example");
      assert.equal((options.headers as Record<string, string>).Authorization, "Bearer fixture-key");
      const handle = {
        setHeader: () => undefined,
        once: () => handle,
        end: (body?: string) => {
          postBody = body ?? "";
          const responseBody = emptyBody();
          onResponse({
            statusCode: 307,
            headers: { location: "https://other.example/key-trap" },
            destroy: () => undefined,
            [Symbol.asyncIterator]: () => responseBody[Symbol.asyncIterator](),
          });
        },
      };
      return handle;
    },
  }
), /重定向次数过多/);
assert.equal(postBody, JSON.stringify({ query: "night running" }));
assert.deepEqual(postRequests, ["https://93.184.216.34/search"], "authenticated POST must never follow a redirect");

const lookupCalls: string[] = [];
const transportCalls: string[] = [];
let redirectClosed = false;
const redirected = await fetchBinaryWithOutboundPolicy(
  "https://public.example/start",
  { label: "redirect-test", timeoutMs: 1_000, maxBytes: 32 },
  {
    lookup: async (hostname) => {
      lookupCalls.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
    transport: async (url) => {
      transportCalls.push(url.toString());
      if (url.pathname === "/start") {
        return {
          status: 302,
          headers: { location: "https://cdn.example/final" },
          body: emptyBody(),
          close: () => {
            redirectClosed = true;
          },
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: bodyFrom(Buffer.from("ok")),
        close: () => undefined,
      };
    },
  }
);
assert.equal(redirected.bytes.toString("utf8"), "ok");
assert.deepEqual(lookupCalls, ["public.example", "cdn.example"]);
assert.equal(transportCalls.length, 2);
assert.equal(redirectClosed, true);

const downgradeLookupCalls: string[] = [];
let downgradeTransportCalls = 0;
await assert.rejects(
  () =>
    fetchBinaryWithOutboundPolicy(
      "https://public.example/start",
      { label: "https-downgrade-test", timeoutMs: 1_000, maxBytes: 32 },
      {
        lookup: async (hostname) => {
          downgradeLookupCalls.push(hostname);
          return [{ address: "93.184.216.34", family: 4 }];
        },
        transport: async () => {
          downgradeTransportCalls += 1;
          return {
            status: 302,
            headers: { location: "http://cdn.example/final" },
            body: emptyBody(),
            close: () => undefined,
          };
        },
      }
    ),
  /must not downgrade to HTTP/
);
assert.equal(downgradeTransportCalls, 1, "the downgraded target must never reach transport");
assert.deepEqual(downgradeLookupCalls, ["public.example"], "the downgraded target must not be resolved");

const upgradeTransportProtocols: string[] = [];
const upgraded = await fetchBinaryWithOutboundPolicy(
  "http://public.example/start",
  { label: "http-upgrade-test", timeoutMs: 1_000, maxBytes: 32 },
  {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (url) => {
      upgradeTransportProtocols.push(url.protocol);
      if (url.protocol === "http:") {
        return {
          status: 301,
          headers: { location: "https://cdn.example/final" },
          body: emptyBody(),
          close: () => undefined,
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: bodyFrom(Buffer.from("upgraded")),
        close: () => undefined,
      };
    },
  }
);
assert.equal(upgraded.bytes.toString("utf8"), "upgraded");
assert.deepEqual(upgradeTransportProtocols, ["http:", "https:"]);

let unsafeRedirectTransportCalls = 0;
await assert.rejects(
  () =>
    fetchBinaryWithOutboundPolicy(
      "https://public.example/start",
      { label: "unsafe-redirect-test", timeoutMs: 1_000, maxBytes: 32 },
      {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => {
          unsafeRedirectTransportCalls += 1;
          return {
            status: 302,
            headers: { location: "https://169.254.169.254/latest/meta-data" },
            body: emptyBody(),
            close: () => undefined,
          };
        },
      }
    ),
  /安全策略阻止/
);
assert.equal(unsafeRedirectTransportCalls, 1, "blocked redirect must not reach a second transport call");

let yieldedChunks = 0;
let oversizedResponseClosed = false;
await assert.rejects(
  () =>
    fetchBinaryWithOutboundPolicy(
      "https://public.example/large",
      { label: "stream-limit-test", timeoutMs: 1_000, maxBytes: 8 },
      {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => ({
          status: 200,
          headers: {},
          body: (async function* () {
            for (let i = 0; i < 4; i += 1) {
              yieldedChunks += 1;
              yield Buffer.alloc(4, i);
            }
          })(),
          close: () => {
            oversizedResponseClosed = true;
          },
        }),
      }
    ),
  /响应过大/
);
assert.equal(yieldedChunks, 3, "stream reader must stop as soon as the cap is crossed");
assert.equal(oversizedResponseClosed, true);

const dangerousQuery = `topic & calc.exe | whoami > pwned.txt %PATH% $(touch /tmp/pwned) "quoted"`;
const windowsInvocation = buildMcporterInvocation(
  dangerousQuery,
  6,
  "win32",
  { executable: "C:\\node.exe", cliPath: "C:\\node_modules\\mcporter\\dist\\cli.js" }
);
assert.ok(windowsInvocation);
assert.equal(windowsInvocation.executable, "C:\\node.exe");
assert.equal(windowsInvocation.options.shell, false);
assert.equal(windowsInvocation.args.length, 5);
assert.equal(windowsInvocation.args[0], "C:\\node_modules\\mcporter\\dist\\cli.js");
assert.equal(windowsInvocation.args[1], "call");
assert.match(windowsInvocation.args[2], /& calc\.exe/);
assert.match(windowsInvocation.args[2], /numResults: 6/);
assert.deepEqual(windowsInvocation.args.slice(3), ["--output", "json"]);
assert.equal(mcporterExecOptions("win32").shell, false);
const unixInvocation = buildMcporterInvocation(dangerousQuery, 6, "linux");
assert.ok(unixInvocation);
assert.equal(unixInvocation.options.shell, false);
assert.equal(unixInvocation.args.length, 4);
assert.equal(unixInvocation.args[0], "call");
assert.match(unixInvocation.args[1], /& calc\.exe/);
assert.match(unixInvocation.args[1], /numResults: 6/);
assert.deepEqual(unixInvocation.args.slice(2), ["--output", "json"]);

const parsedPublisher = parseAgentReachSearchOutput(
  JSON.stringify({ results: [{ title: "A domestic source", url: "https://www.36kr.com/p/123" }] }),
  "test"
)[0];
assert.equal(parsedPublisher.sourceName, "36kr.com");
assert.equal(parsedPublisher.region, "domestic");

const safeStaticGif = buildGifFixture({
  width: 1,
  height: 1,
  frames: [{ delayCentiseconds: 5 }],
});
assert.deepEqual(validateGifStructure(safeStaticGif), {
  width: 1,
  height: 1,
  frameCount: 1,
  totalFramePixels: 1,
  durationMs: 50,
});

const safeAnimatedGif = buildGifFixture({
  width: 2,
  height: 1,
  frames: [
    { delayCentiseconds: 0 },
    { delayCentiseconds: 3 },
  ],
});
assert.deepEqual(validateGifStructure(safeAnimatedGif), {
  width: 2,
  height: 1,
  frameCount: 2,
  totalFramePixels: 4,
  durationMs: 50,
});
assert.ok(
  validateGifStructure(
    buildGifFixture({
      width: 4,
      height: 1,
      // Valid dictionary-using stream for four black pixels. Unlike the fixture
      // encoder below, this crosses from 3-bit to 4-bit LZW codes.
      frames: [{ compressed: Buffer.from([0x84, 0x51]) }],
    })
  ),
  "ordinary GIF LZW dictionary growth must remain supported"
);
const encoderPaddedGif = buildGifFixture({
  width: 3,
  height: 1,
  // Some mainstream encoders (including FFmpeg) flush one zero byte after
  // the LZW end code. It carries no additional code and remains tightly bounded.
  // This clear/literal stream ends exactly on a byte boundary before padding.
  frames: [{ compressed: Buffer.from([0x04, 0x41, 0xb0, 0x00]) }],
});
assert.ok(validateGifStructure(encoderPaddedGif), "one zero encoder-flush byte must remain compatible");
const nonZeroPaddedGif = buildGifFixture({
  width: 3,
  height: 1,
  frames: [{ compressed: Buffer.from([0x04, 0x41, 0xb0, 0x01]) }],
});
assert.equal(validateGifStructure(nonZeroPaddedGif), undefined, "non-zero data after the LZW end code must be rejected");
const overPaddedGif = buildGifFixture({
  width: 3,
  height: 1,
  frames: [{ compressed: Buffer.from([0x04, 0x41, 0xb0, 0x00, 0x00]) }],
});
assert.equal(validateGifStructure(overPaddedGif), undefined, "GIF encoder padding must stay bounded to one byte");

assert.equal(
  validateGifStructure(buildGifFixture({ width: 2_561, height: 1, frames: [{ compressed: tinyGifFrameData() }] })),
  undefined,
  "GIF dimensions above the per-axis cap must be rejected"
);
assert.equal(
  validateGifStructure(buildGifFixture({ width: 2_500, height: 2_000, frames: [{ compressed: tinyGifFrameData() }] })),
  undefined,
  "GIF logical canvases above the pixel budget must be rejected"
);
assert.equal(
  validateGifStructure(buildGifFixture({ width: 2_000, height: 2_000, frames: [{ compressed: tinyGifFrameData() }] })),
  undefined,
  "a tiny LZW stream must not be accepted for a huge declared frame"
);
assert.equal(
  validateGifStructure(
    buildGifFixture({
      width: 1,
      height: 1,
      frames: Array.from({ length: 121 }, () => ({ compressed: tinyGifFrameData() })),
    })
  ),
  undefined,
  "GIF frame-count bombs must be rejected before decoding"
);
const twoMillionPixelFrame = encodeExpandingSolidGifFrame(2_000);
assert.equal(
  validateGifStructure(
    buildGifFixture({
      width: 2_001,
      height: 1_000,
      frames: Array.from({ length: 24 }, () => ({ compressed: twoMillionPixelFrame })),
    })
  ),
  undefined,
  "GIF cumulative compositing pixels must stay inside the decode-work budget"
);
assert.equal(
  validateGifStructure(
    buildGifFixture({
      width: 2_000,
      height: 2_000,
      frames: Array.from({ length: 120 }, () => ({
        width: 1,
        height: 1,
        compressed: tinyGifFrameData(),
      })),
    })
  ),
  undefined,
  "tiny subrect frames on a large canvas must be budgeted as full-canvas composites"
);
assert.deepEqual(
  validateGifStructure(
    buildGifFixture({
      width: 64,
      height: 64,
      frames: Array.from({ length: 10 }, () => ({
        width: 1,
        height: 1,
        compressed: tinyGifFrameData(),
      })),
    })
  ),
  { width: 64, height: 64, frameCount: 10, totalFramePixels: 10, durationMs: 500 },
  "ordinary small-canvas GIFs with subrect updates must remain compatible"
);
assert.equal(
  validateGifStructure(
    buildGifFixture({ width: 1, height: 1, frames: [{ delayCentiseconds: 6_001 }] })
  ),
  undefined,
  "GIF animation duration must be bounded"
);
assert.equal(
  validateGifStructure(buildGifFixture({ width: 1, height: 1, loopCount: 0, frames: [{}] })),
  undefined,
  "infinite NETSCAPE GIF loops must be rejected"
);
assert.ok(
  validateGifStructure(
    buildGifFixture({ width: 1, height: 1, loopCount: 1, loopApplication: "ANIMEXTS1.0", frames: [{}] })
  ),
  "finite ANIMEXTS GIF loops must be parsed"
);
assert.equal(
  validateGifStructure(
    buildGifFixture({ width: 1, height: 1, loopCount: 2, frames: [{ delayCentiseconds: 6_000 }] })
  ),
  undefined,
  "finite GIF loops must obey the total playback-duration budget"
);
assert.ok(
  validateGifStructure(
    buildGifFixture({
      width: 2_001,
      height: 1_000,
      loopCount: 46,
      frames: [{ compressed: twoMillionPixelFrame }],
    })
  ),
  "finite GIF loops inside the total decode budget must remain valid"
);
assert.equal(
  validateGifStructure(
    buildGifFixture({
      width: 2_001,
      height: 1_000,
      loopCount: 47,
      frames: [{ compressed: twoMillionPixelFrame }],
    })
  ),
  undefined,
  "finite GIF loops must obey the total decoded-pixel budget"
);
assert.equal(validateGifStructure(safeStaticGif.subarray(0, safeStaticGif.length - 1)), undefined);
assert.equal(validateGifStructure(Buffer.concat([safeStaticGif, Buffer.from("appended")])), undefined);
assert.equal(
  validateGifStructure(buildGifFixture({ width: 1, height: 1, frames: [{ compressed: Buffer.from([0xff]) }] })),
  undefined,
  "malformed LZW data must be rejected"
);
assert.equal(
  validateGifStructure(
    buildGifFixture({ width: 1, height: 1, frames: [{ width: 2, height: 1, compressed: tinyGifFrameData() }] })
  ),
  undefined,
  "frames extending outside the logical screen must be rejected"
);
const oversizedGif = Buffer.alloc(3 * 1024 * 1024 + 1);
safeStaticGif.copy(oversizedGif);
assert.equal(validateGifStructure(oversizedGif), undefined, "GIF bytes must obey the hard size cap");

const safePng = buildPngFixture(2, 1);
assert.deepEqual(validatePngStructure(safePng), { width: 2, height: 1 });
// A compact, genuine CIE RGB ICC profile (552 bytes), not a synthetic header.
const smallIccProfile = Buffer.from(
  "AAACKEFEQkUCEAAAbW50clJHQiBYWVogB9AACAALABMANAA7YWNzcEFQUEwAAAAAbm9uZQAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1BREJFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKY3BydAAAAPwAAAAyZGVzYwAAATAAAABid3RwdAAAAZQAAAAUYmtwdAAAAagAAAAUclRSQwAAAbwAAAAOZ1RSQwAAAcwAAAAOYlRSQwAAAdwAAAAOclhZWgAAAewAAAAUZ1hZWgAAAgAAAAAUYlhZWgAAAhQAAAAUdGV4dAAAAABDb3B5cmlnaHQgMjAwMCBBZG9iZSBTeXN0ZW1zIEluY29ycG9yYXRlZAAAAGRlc2MAAAAAAAAACENJRSBSR0IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYWVogAAAAAAABAAAAAQAAAAEAFFhZWiAAAAAAAAAAAAAAAAAAAAAAY3VydgAAAAAAAAABAjMAAGN1cnYAAAAAAAAAAQIzAABjdXJ2AAAAAAAAAAECMwAAWFlaIAAAAAAAAHyjAAAstv///61YWVogAAAAAAAATm0AANMlAAAEWlhZWiAAAAAAAAArxgAAACUAAM8l",
  "base64"
);
assert.deepEqual(
  validatePngStructure(
    buildPngFixture(1, 1, { ancillaryChunks: [buildPngIccChunk(smallIccProfile)] })
  ),
  { width: 1, height: 1 },
  "a small structurally valid iCCP profile must remain compatible"
);
const hugeIccProfile = buildIccProfile(2 * 1024 * 1024);
assert.equal(
  validatePngStructure(
    buildPngFixture(1, 1, { ancillaryChunks: [buildPngIccChunk(hugeIccProfile)] })
  ),
  undefined,
  "a tiny compressed iCCP that inflates beyond the profile budget must be rejected"
);
const compressedMetadataBomb = deflateSync(Buffer.alloc(2 * 1024 * 1024));
const ztxtBomb = buildPngChunk(
  "zTXt",
  Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.from([0]), compressedMetadataBomb])
);
assert.equal(
  validatePngStructure(buildPngFixture(1, 1, { ancillaryChunks: [ztxtBomb] })),
  undefined,
  "zTXt compressed-text payloads must be rejected"
);
const compressedItxtBomb = buildPngChunk(
  "iTXt",
  Buffer.concat([
    Buffer.from("Comment\0", "latin1"),
    Buffer.from([1, 0]),
    Buffer.from([0, 0]),
    compressedMetadataBomb,
  ])
);
assert.equal(
  validatePngStructure(buildPngFixture(1, 1, { ancillaryChunks: [compressedItxtBomb] })),
  undefined,
  "compressed iTXt payloads must be rejected"
);
const validIccChunk = buildPngIccChunk(smallIccProfile);
assert.equal(
  validatePngStructure(
    buildPngFixture(1, 1, { ancillaryChunks: [buildPngIccChunk(smallIccProfile, 1)] })
  ),
  undefined,
  "unsupported iCCP compression methods must be rejected"
);
assert.equal(
  validatePngStructure(
    buildPngFixture(1, 1, { ancillaryChunks: [validIccChunk, validIccChunk] })
  ),
  undefined,
  "duplicate iCCP chunks must be rejected"
);
const largeTextChunk = buildPngChunk(
  "tEXt",
  Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.alloc(270 * 1024)])
);
assert.equal(
  validatePngStructure(
    buildPngFixture(1, 1, { ancillaryChunks: [largeTextChunk, largeTextChunk] })
  ),
  undefined,
  "cumulative ancillary metadata must obey the total byte budget"
);
assert.equal(validatePngStructure(buildPngFixture(8_193, 1, { raw: Buffer.from([0]) })), undefined);
assert.equal(
  validatePngStructure(buildPngFixture(4_000, 4_000, { raw: Buffer.from([0]) })),
  undefined,
  "PNG pixel declarations above the cap must be rejected before inflation"
);
assert.equal(validatePngStructure(buildPngFixture(2, 1, { animated: true })), undefined, "APNG must be rejected");
assert.equal(validatePngStructure(safePng.subarray(0, safePng.length - 1)), undefined, "truncated PNG must be rejected");
assert.equal(validatePngStructure(Buffer.concat([safePng, Buffer.from([0])])), undefined, "PNG trailing data must be rejected");
const badCrcPng = Buffer.from(safePng);
badCrcPng[badCrcPng.length - 1] ^= 1;
assert.equal(validatePngStructure(badCrcPng), undefined, "PNG chunk CRC mismatches must be rejected");
const invalidFilterPng = buildPngFixture(1, 1, { raw: Buffer.from([5, 0, 0, 0]) });
assert.equal(validatePngStructure(invalidFilterPng), undefined, "invalid PNG scanline filters must be rejected");

const safeJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIcA2D3/2Q==",
  "base64"
);
assert.deepEqual(validateJpegStructure(safeJpeg), { width: 2, height: 1 });
assert.equal(validateJpegStructure(withJpegDimensions(safeJpeg, 8_193, 1)), undefined, "huge JPEG SOF must be rejected");
assert.equal(validateJpegStructure(withJpegDimensions(safeJpeg, 4_000, 4_000)), undefined, "JPEG pixel caps must be enforced");
assert.equal(validateJpegStructure(safeJpeg.subarray(0, safeJpeg.length - 1)), undefined, "truncated JPEG must be rejected");
assert.equal(validateJpegStructure(Buffer.concat([safeJpeg, Buffer.from([0])])), undefined, "JPEG trailing data must be rejected");

const safeLosslessWebp = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAQAAAAdQs840s/+BiOh/AAA=", "base64");
const safeLossyWebp = Buffer.from(
  "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAEAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==",
  "base64"
);
assert.deepEqual(validateWebpStructure(safeLosslessWebp), { width: 2, height: 1 });
assert.deepEqual(validateWebpStructure(safeLossyWebp), { width: 2, height: 1 });
const safeAlphaWebp = Buffer.from(
  "UklGRmYAAABXRUJQVlA4WAoAAAAQAAAAHwAAHwAAQUxQSAoAAAABB1DAiAhERP8DVlA4IDYAAAAQAwCdASogACAAPm0ylkekIyIhKAgAgA2JZQB2AACQ7IgA/u4KZ//cGZ9XY4f/4tz9uuXwAAA=",
  "base64"
);
assert.deepEqual(validateWebpStructure(safeAlphaWebp), { width: 32, height: 32 });
assert.equal(validateWebpStructure(withLosslessWebpDimensions(safeLosslessWebp, 8_193, 1)), undefined, "huge WebP canvas must be rejected");
assert.equal(validateWebpStructure(withLosslessWebpDimensions(safeLosslessWebp, 4_000, 4_000)), undefined, "WebP pixel caps must be enforced");
assert.equal(validateWebpStructure(safeLosslessWebp.subarray(0, safeLosslessWebp.length - 1)), undefined, "truncated WebP must be rejected");
assert.equal(validateWebpStructure(Buffer.concat([safeLosslessWebp, Buffer.from([0])])), undefined, "WebP trailing data must be rejected");
const animatedWebp = Buffer.from(
  "UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAAAAQU5JTQYAAAD/////AQBBTk1GSAAAAAAAAAAAAAEAAAAAAGQAAAJWUDggMAAAANABAJ0BKgIAAQACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAQAAAAAAZAAAAFZQOCAsAAAAlAEAnQEqAgABAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=",
  "base64"
);
assert.equal(validateWebpStructure(animatedWebp), undefined, "animated WebP must be rejected");

const headerOnlyJpeg = Buffer.from("/9j/wAALCAABAAIBAREA/9oACAEBAAA/AAD/2Q==", "base64");
assert.equal(
  await validateDecodableRasterImage(headerOnlyJpeg, "image/jpeg"),
  undefined,
  "the fetch and downstream decoder boundary must reject an unreadable JPEG"
);

const invalidLosslessWebp = Buffer.from("UklGRhYAAABXRUJQVlA4TAkAAAAvAQAAAP////8A", "base64");
assert.equal(
  await validateDecodableRasterImage(invalidLosslessWebp, "image/webp"),
  undefined,
  "the fetch and downstream decoder boundary must reject an unreadable WebP"
);

assert.equal(await fetchSafeImageBinary("http://127.0.0.1/private.png", 100, 100), undefined);
const unsafeImageItem: ResearchItem = {
  id: "unsafe-image",
  sourceKind: "article",
  sourceName: "Example",
  sourceId: "example",
  region: "global",
  title: "Unsafe image",
  summary: "",
  url: "https://example.com/article",
  imageUrl: "http://169.254.169.254/image.png",
  publishedAt: "",
  authors: [],
  query: "test",
};
const [sanitizedImageItem] = await enrichResearchImages([unsafeImageItem], 1);
assert.equal(sanitizedImageItem.imageUrl, undefined);

console.log("Research network security tests passed.");

async function testNodeGlobalProxyWithPinnedTargets(): Promise<void> {
  type RuntimeProxySetter = (proxyEnv: NodeJS.ProcessEnv) => () => void;
  const setter = (http as typeof http & { setGlobalProxyFromEnv?: RuntimeProxySetter })
    .setGlobalProxyFromEnv;
  if (typeof setter !== "function") return;

  let observedHttpTarget = "";
  let observedHttpHost = "";
  let observedConnectTarget = "";
  const proxy = http.createServer((request, response) => {
    observedHttpTarget = request.url ?? "";
    observedHttpHost = request.headers.host ?? "";
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("proxy-ok");
  });
  proxy.on("connect", (request, socket) => {
    observedConnectTarget = request.url ?? "";
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.removeListener("error", reject);
      resolve();
    });
  });
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const restoreProxy = setter({
    HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
    NO_PROXY: "",
  });

  try {
    const proxiedHttpResult = await fetchBinaryWithOutboundPolicy(
      "http://public.example/proxy-path?x=1",
      {
        label: "global-http-proxy-test",
        timeoutMs: 2_000,
        maxBytes: 32,
        headers: { Host: "attacker.internal" },
      },
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] }
    );
    assert.equal(proxiedHttpResult.bytes.toString("utf8"), "proxy-ok");
    assert.equal(observedHttpTarget, "http://93.184.216.34/proxy-path?x=1");
    assert.equal(observedHttpHost, "public.example");

    await assert.rejects(() =>
      fetchBinaryWithOutboundPolicy(
        "https://public.example/proxy-path",
        { label: "global-https-proxy-test", timeoutMs: 2_000, maxBytes: 32 },
        { lookup: async () => [{ address: "93.184.216.34", family: 4 }] }
      )
    );
    assert.equal(
      observedConnectTarget,
      "93.184.216.34:443",
      "HTTPS proxy CONNECT must target the vetted IP instead of resolving the origin hostname"
    );
  } finally {
    restoreProxy();
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => error ? reject(error) : resolve());
    });
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return bodyFrom();
}

function bodyFrom(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

interface GifFixtureFrame {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  delayCentiseconds?: number;
  compressed?: Buffer;
}

function buildGifFixture(input: {
  width: number;
  height: number;
  loopCount?: number;
  loopApplication?: "NETSCAPE2.0" | "ANIMEXTS1.0";
  frames: GifFixtureFrame[];
}): Buffer {
  const parts: Buffer[] = [
    Buffer.from("GIF89a", "ascii"),
    littleEndian16(input.width),
    littleEndian16(input.height),
    Buffer.from([0x80, 0x00, 0x00]),
    // Two-entry global palette: black and white.
    Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
  ];

  if (input.loopCount !== undefined) {
    parts.push(
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from(input.loopApplication ?? "NETSCAPE2.0", "ascii"),
      Buffer.from([0x03, 0x01, input.loopCount & 0xff, (input.loopCount >> 8) & 0xff, 0x00])
    );
  }

  for (const frame of input.frames) {
    const frameWidth = frame.width ?? input.width;
    const frameHeight = frame.height ?? input.height;
    const delay = frame.delayCentiseconds ?? 5;
    parts.push(
      Buffer.from([
        0x21,
        0xf9,
        0x04,
        0x00,
        delay & 0xff,
        (delay >> 8) & 0xff,
        0x00,
        0x00,
        0x2c,
      ]),
      littleEndian16(frame.left ?? 0),
      littleEndian16(frame.top ?? 0),
      littleEndian16(frameWidth),
      littleEndian16(frameHeight),
      Buffer.from([0x00, 0x02])
    );
    const compressed = frame.compressed ?? encodeSolidGifFrame(frameWidth * frameHeight);
    for (let offset = 0; offset < compressed.length; offset += 255) {
      const chunk = compressed.subarray(offset, Math.min(compressed.length, offset + 255));
      parts.push(Buffer.from([chunk.length]), chunk);
    }
    parts.push(Buffer.from([0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function tinyGifFrameData(): Buffer {
  return encodeSolidGifFrame(1);
}

/** Encode clear, one black pixel, clear, ... and end using fixed 3-bit codes. */
function encodeSolidGifFrame(pixelCount: number): Buffer {
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 1 || pixelCount > 10_000) {
    throw new Error("Fixture pixel count must be between 1 and 10,000");
  }
  const codes: number[] = [];
  for (let i = 0; i < pixelCount; i += 1) codes.push(4, 0);
  codes.push(5);
  const bytes = Buffer.alloc(Math.ceil((codes.length * 3) / 8));
  let bitOffset = 0;
  for (const code of codes) {
    for (let bit = 0; bit < 3; bit += 1) {
      if ((code & (1 << bit)) !== 0) {
        bytes[bitOffset >> 3] |= 1 << (bitOffset & 7);
      }
      bitOffset += 1;
    }
  }
  return bytes;
}

function littleEndian16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value & 0xffff, 0);
  return bytes;
}

/** Encode black runs of lengths 1..N through the GIF decoder's KwKwK path. */
function encodeExpandingSolidGifFrame(maxExpansionLength: number): Buffer {
  if (!Number.isInteger(maxExpansionLength) || maxExpansionLength < 2 || maxExpansionLength > 4_090) {
    throw new Error("Expansion length must be between 2 and 4,090");
  }
  const clearCode = 4;
  const endCode = 5;
  const codes = [clearCode, 0];
  for (let code = 6; code <= maxExpansionLength + 4; code += 1) codes.push(code);
  codes.push(endCode);

  const output: number[] = [];
  let bitOffset = 0;
  let codeSize = 3;
  let nextCode = 6;
  let hasPrevious = false;
  const writeCode = (code: number) => {
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byteOffset = bitOffset >> 3;
      output[byteOffset] ??= 0;
      if ((code & (1 << bit)) !== 0) output[byteOffset] |= 1 << (bitOffset & 7);
      bitOffset += 1;
    }
  };

  for (const code of codes) {
    writeCode(code);
    if (code === clearCode) {
      codeSize = 3;
      nextCode = 6;
      hasPrevious = false;
    } else if (code !== endCode) {
      if (hasPrevious) {
        nextCode += 1;
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      }
      hasPrevious = true;
    }
  }
  return Buffer.from(output);
}

function buildPngFixture(
  width: number,
  height: number,
  options: { raw?: Buffer; animated?: boolean; ancillaryChunks?: Buffer[] } = {}
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    buildPngChunk("IHDR", header),
  ];
  parts.push(...(options.ancillaryChunks ?? []));
  if (options.animated) {
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(1, 0);
    parts.push(buildPngChunk("acTL", animationControl));
  }
  const raw = options.raw ?? Buffer.alloc((width * 3 + 1) * height);
  parts.push(buildPngChunk("IDAT", deflateSync(raw)), buildPngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function buildPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(fixturePngCrc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function fixturePngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildIccProfile(size: number): Buffer {
  if (!Number.isInteger(size) || size < 132 || size % 4 !== 0) {
    throw new Error("ICC fixture size must be a multiple of four and at least 132 bytes");
  }
  const profile = Buffer.alloc(size);
  profile.writeUInt32BE(size, 0);
  profile.write("acsp", 36, "ascii");
  profile.writeUInt32BE(0, 128);
  return profile;
}

function buildPngIccChunk(profile: Buffer, compressionMethod = 0): Buffer {
  return buildPngChunk(
    "iCCP",
    Buffer.concat([
      Buffer.from("Article profile\0", "latin1"),
      Buffer.from([compressionMethod]),
      deflateSync(profile),
    ])
  );
}

function withJpegDimensions(source: Buffer, width: number, height: number): Buffer {
  const bytes = Buffer.from(source);
  let markerOffset = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  if (markerOffset < 0) markerOffset = bytes.indexOf(Buffer.from([0xff, 0xc2]));
  if (markerOffset < 0) throw new Error("JPEG fixture has no supported SOF marker");
  bytes.writeUInt16BE(height, markerOffset + 5);
  bytes.writeUInt16BE(width, markerOffset + 7);
  return bytes;
}

function withLosslessWebpDimensions(source: Buffer, width: number, height: number): Buffer {
  const bytes = Buffer.from(source);
  const chunkOffset = bytes.indexOf(Buffer.from("VP8L", "ascii"));
  if (chunkOffset < 0 || width < 1 || width > 16_384 || height < 1 || height > 16_384) {
    throw new Error("Invalid lossless WebP fixture");
  }
  const headerOffset = chunkOffset + 9;
  const header = bytes.readUInt32LE(headerOffset);
  bytes.writeUInt32LE(
    ((header & 0xf0000000) | (width - 1) | ((height - 1) << 14)) >>> 0,
    headerOffset
  );
  return bytes;
}
