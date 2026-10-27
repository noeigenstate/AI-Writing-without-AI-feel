import { TextDecoder } from "node:util";
import { inflateSync } from "node:zlib";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import sharp from "sharp";
import { cached } from "./cache.js";
import {
  fetchBinaryWithOutboundPolicy,
  fetchTextWithOutboundPolicy,
} from "./networkSafety.js";
import { asString, isRecord } from "./parse.js";
import type { ResearchItem } from "./types.js";

const SOURCE_PAGE_MAX_BYTES = 700_000;
const SOURCE_IMAGE_MAX_CANDIDATES = 18;
const SOURCE_IMAGE_MAX_VALIDATION_ATTEMPTS = 6;
const SOURCE_IMAGE_VALIDATION_DEADLINE_MS = 12_000;
const SOURCE_IMAGE_PER_CANDIDATE_TIMEOUT_MS = 4_000;
const SOURCE_IMAGE_SELECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SAFE_IMAGE_BINARY_CACHE_TTL_MS = 10 * 60 * 1000;
const SAFE_IMAGE_BINARY_CACHE_MAX_ENTRIES = 24;
const SOURCE_IMAGE_MAX_URL_CHARS = 4_096;
const SOURCE_IMAGE_MIN_WIDTH_HINT = 160;
const SOURCE_IMAGE_MIN_HEIGHT_HINT = 90;
const SOURCE_IMAGE_MIN_AREA_HINT = 40_000;
const SOURCE_IMAGE_JSON_LD_MAX_NODES = 2_048;
const SOURCE_IMAGE_JSON_LD_MAX_DEPTH = 24;
const ARTICLE_CONTENT_CONTAINER_EXACT_NAMES: ReadonlySet<string> = new Set([
  "paragraph",
  "articlebody",
  "postbody",
  "entrybody",
  "storybody",
  "newsbody",
]);
const ARTICLE_CONTENT_CONTAINER_NAME_PATTERN =
  /^(?:(?:article|post|entry|story|news)-(?:body|content|detail|text|paragraphs?)|(?:body|content|detail|text)-(?:article|post|entry|story|news))$/;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const STATIC_IMAGE_DECODE_CONCURRENCY = 2;
const STATIC_MAX_DIMENSION = 8_192;
const STATIC_MAX_PIXELS = 12_000_000;
const PNG_MAX_INFLATED_BYTES = 48 * 1024 * 1024;
const PNG_MAX_ANCILLARY_CHUNKS = 64;
const PNG_MAX_ANCILLARY_BYTES = 512 * 1024;
const PNG_MAX_ICC_PROFILE_BYTES = 256 * 1024;
const PNG_MAX_TOTAL_METADATA_BYTES = 512 * 1024;
const IMAGE_MAX_CONTAINER_BLOCKS = 4_096;
const GIF_MAX_DIMENSION = 2_560;
const GIF_MAX_CANVAS_PIXELS = 4_000_000;
const GIF_MAX_FRAMES = 120;
const GIF_MAX_COMPOSITED_PIXELS = 48_000_000;
const GIF_MAX_DURATION_MS = 60_000;
const GIF_MAX_TOTAL_PLAYBACK_DURATION_MS = 120_000;
const GIF_MAX_TOTAL_PLAYBACK_COMPOSITED_PIXELS = 96_000_000;
const GIF_MIN_FRAME_DURATION_MS = 20;
const GIF_MAX_LZW_CODES = 1_000_000;
const PNG_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface SafeGifMetadata {
  width: number;
  height: number;
  frameCount: number;
  totalFramePixels: number;
  durationMs: number;
}

export interface SafeImageBinary {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  finalUrl: string;
  width: number;
  height: number;
}

interface SafeImageBinaryCacheEntry {
  expiresAt: number;
  value: SafeImageBinary;
}

const safeImageBinaryCache = new Map<string, SafeImageBinaryCacheEntry>();
let activeStaticImageDecodes = 0;
const staticImageDecodeWaiters: Array<() => void> = [];

export interface SafeRasterMetadata {
  width: number;
  height: number;
}

/** Validate the full container for every raster format accepted downstream. */
export function validateRasterImageStructure(
  bytes: Buffer,
  mimeType: SafeImageBinary["mimeType"]
): SafeRasterMetadata | undefined {
  switch (mimeType) {
    case "image/png":
      return validatePngStructure(bytes);
    case "image/jpeg":
      return validateJpegStructure(bytes);
    case "image/gif":
      return validateGifStructure(bytes);
    case "image/webp":
      return validateWebpStructure(bytes);
  }
}

/**
 * Attach a representative image URL to the first few items that lack one.
 *
 * Fetches each source page and discovers attributable preview/article images;
 * failures are ignored so enrichment never blocks generation.
 *
 * @param items Research items.
 * @param limit Max items to attempt (default 16, matching the article evidence window).
 * @returns The items, with `imageUrl` filled in where found.
 */
export async function enrichResearchImages(items: ResearchItem[], limit = 16): Promise<ResearchItem[]> {
  const candidates = items.slice(0, limit);
  const imageEntries = await Promise.all(
    candidates.map(async (item) => {
      const preferredCandidate = item.imageUrl
        ? resolveSourceImageCandidate({ rawUrl: item.imageUrl }, item.url)
        : undefined;
      const imageUrl = await fetchSourceImage(item.url, preferredCandidate).catch(() => undefined);
      return [item.id, imageUrl] as const;
    })
  );
  const seenImageUrls = new Set<string>();
  const imageMap = new Map<string, string | undefined>();
  for (const [itemId, imageUrl] of imageEntries) {
    if (!imageUrl || seenImageUrls.has(imageUrl)) {
      imageMap.set(itemId, undefined);
      continue;
    }
    seenImageUrls.add(imageUrl);
    imageMap.set(itemId, imageUrl);
  }

  return items.map((item) => {
    if (!imageMap.has(item.id)) {
      return item;
    }
    const imageUrl = imageMap.get(item.id);
    return { ...item, imageUrl };
  });
}

/** Fetch a page and select its first fully validated source-image candidate. */
async function fetchSourceImage(
  url: string,
  preferredCandidate?: string
): Promise<string | undefined> {
  if (!isSourcePageEligibleForImageDiscovery(url)) return undefined;
  const cacheKey = `source-image:v4:${url}\n${preferredCandidate ?? ""}`;
  return cached(cacheKey, SOURCE_IMAGE_SELECTION_CACHE_TTL_MS, async () => {
    let discoveredCandidates: string[] = [];
    try {
      const res = await fetchTextWithOutboundPolicy(
        url,
        {
          label: "source image",
          timeoutMs: 8_000,
          maxBytes: SOURCE_PAGE_MAX_BYTES,
          headers: {
            "User-Agent": "SpeakPlainlyResearch/0.1 (+local development)",
            Accept: "text/html,application/xhtml+xml",
          },
        }
      );
      if (res.ok) {
        discoveredCandidates = extractSourceImageCandidatesFromHtml(res.text, res.url);
      }
    } catch {
      // A provider thumbnail can still be valid when the source page is down.
    }
    const imageCandidates = [
      ...(preferredCandidate ? [preferredCandidate] : []),
      ...discoveredCandidates,
    ];
    return selectFirstSafeSourceImageCandidate([...new Set(imageCandidates)]);
  });
}

/**
 * Aggregator pages do not own the articles they list and often expose one
 * shared product thumbnail as `og:image`. A Google News wrapper therefore must
 * be resolved to its publisher article before any image can be attributed.
 */
export function isSourcePageEligibleForImageDiscovery(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLocaleLowerCase().replace(/\.$/u, "") !== "news.google.com";
  } catch {
    return false;
  }
}

/**
 * Download a raster image through the SSRF-safe outbound policy.
 *
 * This is the single binary-image fetch entry point intended for article.ts:
 * it revalidates every redirect, pins the checked DNS result, streams with a
 * hard byte cap, and rejects SVG or MIME-spoofed content.
 */
export async function fetchSafeImageBinary(
  url: string,
  timeoutMs = 8_000,
  maxBytes = IMAGE_MAX_BYTES
): Promise<SafeImageBinary | undefined> {
  const cacheKey = `${maxBytes}:${url}`;
  const cachedImage = readSafeImageBinaryCache(cacheKey, maxBytes);
  if (cachedImage) return cachedImage;

  try {
    const res = await fetchBinaryWithOutboundPolicy(url, {
      label: "source image binary",
      timeoutMs,
      maxBytes,
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9" },
    });
    if (!res.ok || res.bytes.length === 0) {
      return undefined;
    }

    const declaredMime = normalizeImageMime(res.headers["content-type"]);
    const detectedMime = detectRasterImageMime(res.bytes);
    if (!declaredMime || !detectedMime || declaredMime !== detectedMime) {
      return undefined;
    }
    const metadata = await validateDecodableRasterImage(res.bytes, detectedMime);
    if (!metadata) {
      return undefined;
    }
    const safeImage: SafeImageBinary = {
      bytes: res.bytes,
      mimeType: detectedMime,
      finalUrl: res.url,
      width: metadata.width,
      height: metadata.height,
    };
    writeSafeImageBinaryCache(cacheKey, safeImage);
    return safeImage;
  } catch {
    return undefined;
  }
}

function readSafeImageBinaryCache(key: string, maxBytes: number): SafeImageBinary | undefined {
  const entry = safeImageBinaryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now() || entry.value.bytes.length > maxBytes) {
    safeImageBinaryCache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the bounded map behaves as a small LRU cache.
  safeImageBinaryCache.delete(key);
  safeImageBinaryCache.set(key, entry);
  return entry.value;
}

function writeSafeImageBinaryCache(key: string, value: SafeImageBinary): void {
  const now = Date.now();
  for (const [cacheKey, entry] of safeImageBinaryCache) {
    if (entry.expiresAt <= now) safeImageBinaryCache.delete(cacheKey);
  }
  safeImageBinaryCache.delete(key);
  while (safeImageBinaryCache.size >= SAFE_IMAGE_BINARY_CACHE_MAX_ENTRIES) {
    const oldestKey = safeImageBinaryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    safeImageBinaryCache.delete(oldestKey);
  }
  safeImageBinaryCache.set(key, {
    expiresAt: now + SAFE_IMAGE_BINARY_CACHE_TTL_MS,
    value,
  });
}

/**
 * Force a full pixel decode for media entering a downstream document decoder.
 * GIF already receives complete LZW validation; static formats additionally go
 * through sharp so a header-shaped but unreadable JPEG/WebP cannot enter DOCX.
 */
export async function validateDecodableRasterImage(
  bytes: Buffer,
  mimeType: SafeImageBinary["mimeType"]
): Promise<SafeRasterMetadata | undefined> {
  const structural = validateRasterImageStructure(bytes, mimeType);
  if (!structural || mimeType === "image/gif") return structural;
  try {
    return await withStaticImageDecodeLimit(async () => {
      const image = sharp(bytes, {
        failOn: "warning",
        limitInputPixels: STATIC_MAX_PIXELS,
        sequentialRead: true,
      });
      const metadata = await image.metadata();
      const expectedFormat = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpeg" : "webp";
      if (
        metadata.format !== expectedFormat
        || metadata.width !== structural.width
        || metadata.height !== structural.height
        || (metadata.pages ?? 1) !== 1
        || metadata.channels === undefined
        || metadata.channels < 1
        || metadata.channels > 4
      ) {
        return undefined;
      }

      // stats() walks the complete decoded pixel stream but does not copy a
      // potentially 48 MiB raw raster into a JavaScript Buffer for every image.
      const stats = await image.stats();
      if (stats.channels.length !== metadata.channels) return undefined;
      return structural;
    });
  } catch {
    return undefined;
  }
}

/**
 * Run one complete static-image decode under the process-wide memory gate.
 * Exported so the concurrency invariant can be tested without weakening or
 * replacing the real Sharp validation path.
 */
export async function withStaticImageDecodeLimit<T>(task: () => Promise<T>): Promise<T> {
  await acquireStaticImageDecodeSlot();
  try {
    return await task();
  } finally {
    releaseStaticImageDecodeSlot();
  }
}

async function acquireStaticImageDecodeSlot(): Promise<void> {
  if (activeStaticImageDecodes < STATIC_IMAGE_DECODE_CONCURRENCY) {
    activeStaticImageDecodes += 1;
    return;
  }
  // A released slot is transferred directly to the oldest waiter; the active
  // count intentionally stays unchanged during that handoff.
  await new Promise<void>((resolve) => staticImageDecodeWaiters.push(resolve));
}

function releaseStaticImageDecodeSlot(): void {
  const next = staticImageDecodeWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeStaticImageDecodes = Math.max(0, activeStaticImageDecodes - 1);
}

/** Parse a complete, non-animated PNG and bound both pixels and inflation. */
export function validatePngStructure(bytes: Buffer): SafeRasterMetadata | undefined {
  try {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (
      bytes.length < 45 ||
      bytes.length > IMAGE_MAX_BYTES ||
      !bytes.subarray(0, signature.length).equals(signature)
    ) {
      return undefined;
    }

    let offset = signature.length;
    let chunkCount = 0;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlaceMethod = -1;
    let paletteEntries = 0;
    let sawHeader = false;
    let sawPalette = false;
    let sawImageData = false;
    let endedImageData = false;
    let sawEnd = false;
    let sawIccProfile = false;
    let ancillaryChunkCount = 0;
    let ancillaryBytes = 0;
    let decodedMetadataBytes = 0;
    let compressedLength = 0;
    const compressedChunks: Buffer[] = [];

    while (offset < bytes.length) {
      chunkCount += 1;
      if (chunkCount > IMAGE_MAX_CONTAINER_BLOCKS || offset + 12 > bytes.length) return undefined;
      const chunkLength = bytes.readUInt32BE(offset);
      const typeOffset = offset + 4;
      const dataOffset = typeOffset + 4;
      const dataEnd = dataOffset + chunkLength;
      const chunkEnd = dataEnd + 4;
      if (dataEnd < dataOffset || chunkEnd > bytes.length || !isPngChunkType(bytes, typeOffset)) {
        return undefined;
      }
      if (pngCrc32(bytes, typeOffset, dataEnd) !== bytes.readUInt32BE(dataEnd)) return undefined;
      const chunkType = bytes.toString("ascii", typeOffset, typeOffset + 4);
      offset = chunkEnd;

      if (chunkType === "IHDR") {
        if (chunkCount !== 1 || sawHeader || chunkLength !== 13) return undefined;
        width = bytes.readUInt32BE(dataOffset);
        height = bytes.readUInt32BE(dataOffset + 4);
        bitDepth = bytes[dataOffset + 8];
        colorType = bytes[dataOffset + 9];
        const compressionMethod = bytes[dataOffset + 10];
        const filterMethod = bytes[dataOffset + 11];
        interlaceMethod = bytes[dataOffset + 12];
        if (
          !isSafeStaticDimensions(width, height) ||
          !isValidPngColorMode(bitDepth, colorType) ||
          compressionMethod !== 0 ||
          filterMethod !== 0 ||
          (interlaceMethod !== 0 && interlaceMethod !== 1)
        ) {
          return undefined;
        }
        sawHeader = true;
        continue;
      }

      if (!sawHeader) return undefined;
      if ((bytes[typeOffset] & 0x20) !== 0) {
        ancillaryChunkCount += 1;
        ancillaryBytes += chunkLength;
        if (
          ancillaryChunkCount > PNG_MAX_ANCILLARY_CHUNKS ||
          ancillaryBytes > PNG_MAX_ANCILLARY_BYTES ||
          ancillaryBytes + decodedMetadataBytes > PNG_MAX_TOTAL_METADATA_BYTES
        ) {
          return undefined;
        }
      }
      // APNG control/frame chunks opt into animation even when only one frame
      // is declared, so reject the animation surface unconditionally.
      if (chunkType === "acTL" || chunkType === "fcTL" || chunkType === "fdAT") return undefined;
      if (sawImageData && chunkType !== "IDAT") endedImageData = true;

      // Compressed article text is never rendered and gives attackers a second
      // independent inflate surface, so do not accept it in PNG metadata.
      if (chunkType === "zTXt") return undefined;
      if (chunkType === "iTXt") {
        if (!validateUncompressedPngInternationalText(bytes, dataOffset, dataEnd)) return undefined;
        continue;
      }
      if (chunkType === "tEXt") {
        if (!validatePngText(bytes, dataOffset, dataEnd)) return undefined;
        continue;
      }
      if (chunkType === "iCCP") {
        if (sawIccProfile || sawPalette || sawImageData) return undefined;
        const profile = inflatePngIccProfile(bytes, dataOffset, dataEnd);
        if (!profile) return undefined;
        decodedMetadataBytes += profile.length;
        if (ancillaryBytes + decodedMetadataBytes > PNG_MAX_TOTAL_METADATA_BYTES) return undefined;
        sawIccProfile = true;
        continue;
      }

      if (chunkType === "PLTE") {
        if (sawPalette || sawImageData || chunkLength === 0 || chunkLength > 768 || chunkLength % 3 !== 0) {
          return undefined;
        }
        paletteEntries = chunkLength / 3;
        sawPalette = true;
        continue;
      }

      if (chunkType === "IDAT") {
        if (endedImageData) return undefined;
        sawImageData = true;
        compressedChunks.push(bytes.subarray(dataOffset, dataEnd));
        compressedLength += chunkLength;
        if (compressedLength > IMAGE_MAX_BYTES) return undefined;
        continue;
      }

      if (sawImageData) endedImageData = true;
      if (chunkType === "IEND") {
        if (chunkLength !== 0 || !sawImageData || offset !== bytes.length) return undefined;
        sawEnd = true;
        break;
      }

      // Unknown critical chunks cannot be safely interpreted by this pipeline.
      if ((bytes[typeOffset] & 0x20) === 0) return undefined;
    }

    if (
      !sawEnd ||
      compressedLength === 0 ||
      (colorType === 3 && (!sawPalette || paletteEntries > 1 << bitDepth)) ||
      ((colorType === 0 || colorType === 4) && sawPalette)
    ) {
      return undefined;
    }

    const scanlines = pngScanlineLayout(width, height, bitDepth, colorType, interlaceMethod);
    const expectedInflatedBytes = scanlines.reduce((total, scanline) => {
      return total + (scanline.rowBytes + 1) * scanline.rows;
    }, 0);
    if (
      !Number.isSafeInteger(expectedInflatedBytes) ||
      expectedInflatedBytes <= 0 ||
      expectedInflatedBytes > PNG_MAX_INFLATED_BYTES
    ) {
      return undefined;
    }
    const inflated = inflateSync(Buffer.concat(compressedChunks, compressedLength), {
      maxOutputLength: expectedInflatedBytes + 1,
    });
    if (inflated.length !== expectedInflatedBytes) return undefined;
    let scanlineOffset = 0;
    for (const scanline of scanlines) {
      for (let row = 0; row < scanline.rows; row += 1) {
        if (inflated[scanlineOffset] > 4) return undefined;
        scanlineOffset += scanline.rowBytes + 1;
      }
    }
    return scanlineOffset === inflated.length ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

interface PngScanlineLayout {
  rows: number;
  rowBytes: number;
}

function pngScanlineLayout(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlaceMethod: number
): PngScanlineLayout[] {
  const samplesPerPixel = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const rowBytes = (pixels: number) => Math.ceil((pixels * samplesPerPixel * bitDepth) / 8);
  if (interlaceMethod === 0) return [{ rows: height, rowBytes: rowBytes(width) }];

  const startsX = [0, 4, 0, 2, 0, 1, 0];
  const startsY = [0, 0, 4, 0, 2, 0, 1];
  const stepsX = [8, 8, 4, 4, 2, 2, 1];
  const stepsY = [8, 8, 8, 4, 4, 2, 2];
  const layouts: PngScanlineLayout[] = [];
  for (let pass = 0; pass < 7; pass += 1) {
    const passWidth = width > startsX[pass] ? Math.ceil((width - startsX[pass]) / stepsX[pass]) : 0;
    const passHeight = height > startsY[pass] ? Math.ceil((height - startsY[pass]) / stepsY[pass]) : 0;
    if (passWidth > 0 && passHeight > 0) layouts.push({ rows: passHeight, rowBytes: rowBytes(passWidth) });
  }
  return layouts;
}

function isValidPngColorMode(bitDepth: number, colorType: number): boolean {
  if (colorType === 0) return bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8 || bitDepth === 16;
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  return colorType === 3 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8);
}

function isPngChunkType(bytes: Buffer, offset: number): boolean {
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index];
    if (!((value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a))) return false;
  }
  // PNG reserves the third type-code bit for future incompatible changes.
  return (bytes[offset + 2] & 0x20) === 0;
}

function pngCrc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= bytes[offset];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePngText(bytes: Buffer, start: number, end: number): boolean {
  const keywordEnd = findPngNull(bytes, start, end);
  return keywordEnd >= 0 && isValidPngKeyword(bytes, start, keywordEnd);
}

/** iTXt is accepted only in its uncompressed, bounded representation. */
function validateUncompressedPngInternationalText(bytes: Buffer, start: number, end: number): boolean {
  const keywordEnd = findPngNull(bytes, start, end);
  if (keywordEnd < 0 || !isValidPngKeyword(bytes, start, keywordEnd)) return false;
  let offset = keywordEnd + 1;
  if (offset + 2 > end) return false;
  const compressionFlag = bytes[offset++];
  const compressionMethod = bytes[offset++];
  if (compressionFlag !== 0 || compressionMethod !== 0) return false;

  const languageEnd = findPngNull(bytes, offset, end);
  if (languageEnd < 0 || !isValidPngLanguageTag(bytes, offset, languageEnd)) return false;
  offset = languageEnd + 1;
  const translatedKeywordEnd = findPngNull(bytes, offset, end);
  if (translatedKeywordEnd < 0) return false;
  try {
    PNG_UTF8_DECODER.decode(bytes.subarray(offset, translatedKeywordEnd));
    PNG_UTF8_DECODER.decode(bytes.subarray(translatedKeywordEnd + 1, end));
    return true;
  } catch {
    return false;
  }
}

function inflatePngIccProfile(bytes: Buffer, start: number, end: number): Buffer | undefined {
  try {
    const profileNameEnd = findPngNull(bytes, start, end);
    if (profileNameEnd < 0 || !isValidPngKeyword(bytes, start, profileNameEnd)) return undefined;
    const compressionMethodOffset = profileNameEnd + 1;
    const compressedOffset = compressionMethodOffset + 1;
    if (
      compressedOffset >= end ||
      bytes[compressionMethodOffset] !== 0
    ) {
      return undefined;
    }
    const profile = inflateSync(bytes.subarray(compressedOffset, end), {
      maxOutputLength: PNG_MAX_ICC_PROFILE_BYTES + 1,
    });
    if (
      profile.length < 132 ||
      profile.length > PNG_MAX_ICC_PROFILE_BYTES ||
      profile.length % 4 !== 0 ||
      profile.readUInt32BE(0) !== profile.length ||
      profile.toString("ascii", 36, 40) !== "acsp"
    ) {
      return undefined;
    }
    return profile;
  } catch {
    return undefined;
  }
}

function findPngNull(bytes: Buffer, start: number, end: number): number {
  const offset = bytes.indexOf(0, start);
  return offset >= start && offset < end ? offset : -1;
}

function isValidPngKeyword(bytes: Buffer, start: number, end: number): boolean {
  const length = end - start;
  if (length < 1 || length > 79 || bytes[start] === 0x20 || bytes[end - 1] === 0x20) return false;
  let previousWasSpace = false;
  for (let offset = start; offset < end; offset += 1) {
    const value = bytes[offset];
    if (!((value >= 0x20 && value <= 0x7e) || (value >= 0xa1 && value <= 0xff))) return false;
    const isSpace = value === 0x20;
    if (isSpace && previousWasSpace) return false;
    previousWasSpace = isSpace;
  }
  return true;
}

function isValidPngLanguageTag(bytes: Buffer, start: number, end: number): boolean {
  for (let offset = start; offset < end; offset += 1) {
    const value = bytes[offset];
    const isAsciiLetter = (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
    if (!isAsciiLetter && !(value >= 0x30 && value <= 0x39) && value !== 0x2d) return false;
  }
  return true;
}

/** Parse JPEG marker segments and every entropy-scan boundary through EOI. */
export function validateJpegStructure(bytes: Buffer): SafeRasterMetadata | undefined {
  try {
    if (
      bytes.length < 14 ||
      bytes.length > IMAGE_MAX_BYTES ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8
    ) {
      return undefined;
    }
    let offset = 2;
    let segmentCount = 0;
    let width = 0;
    let height = 0;
    let componentIds = new Set<number>();
    let sawFrame = false;
    let sawScan = false;

    while (offset < bytes.length) {
      segmentCount += 1;
      if (segmentCount > IMAGE_MAX_CONTAINER_BLOCKS || bytes[offset] !== 0xff) return undefined;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return undefined;
      const marker = bytes[offset++];
      if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        return undefined;
      }
      if (marker === 0xd9) {
        return sawFrame && sawScan && offset === bytes.length ? { width, height } : undefined;
      }
      if (offset + 2 > bytes.length) return undefined;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
      const payloadOffset = offset + 2;
      const segmentEnd = offset + segmentLength;

      if (isJpegStartOfFrame(marker)) {
        if (sawFrame || (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) || segmentLength < 8) {
          return undefined;
        }
        const precision = bytes[payloadOffset];
        height = bytes.readUInt16BE(payloadOffset + 1);
        width = bytes.readUInt16BE(payloadOffset + 3);
        const components = bytes[payloadOffset + 5];
        if (
          precision !== 8 ||
          (components !== 1 && components !== 3 && components !== 4) ||
          segmentLength !== 8 + components * 3 ||
          !isSafeStaticDimensions(width, height)
        ) {
          return undefined;
        }
        componentIds = new Set<number>();
        for (let component = 0; component < components; component += 1) {
          const id = bytes[payloadOffset + 6 + component * 3];
          if (componentIds.has(id)) return undefined;
          componentIds.add(id);
        }
        sawFrame = true;
      } else if (marker === 0xda) {
        if (!sawFrame || segmentLength < 8) return undefined;
        const scanComponents = bytes[payloadOffset];
        if (scanComponents < 1 || scanComponents > componentIds.size || segmentLength !== 6 + scanComponents * 2) {
          return undefined;
        }
        const selectors = new Set<number>();
        for (let component = 0; component < scanComponents; component += 1) {
          const selector = bytes[payloadOffset + 1 + component * 2];
          if (!componentIds.has(selector) || selectors.has(selector)) return undefined;
          selectors.add(selector);
        }
        const nextMarker = findNextJpegMarker(bytes, segmentEnd);
        if (nextMarker <= segmentEnd) return undefined;
        sawScan = true;
        offset = nextMarker;
        continue;
      } else if (marker === 0xdc || marker === 0xde || marker === 0xdf) {
        // DNL/hierarchical JPEG can override the dimensions established above.
        return undefined;
      }
      offset = segmentEnd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function findNextJpegMarker(bytes: Buffer, startOffset: number): number {
  let offset = startOffset;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerOffset = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return -1;
    const marker = bytes[offset];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerOffset;
  }
  return -1;
}

/** Parse a complete RIFF WebP container and accept only one static image. */
export function validateWebpStructure(bytes: Buffer): SafeRasterMetadata | undefined {
  try {
    if (
      bytes.length < 20 ||
      bytes.length > IMAGE_MAX_BYTES ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    ) {
      return undefined;
    }

    let offset = 12;
    let chunkCount = 0;
    let primaryChunkIndex = 0;
    let primaryWidth = 0;
    let primaryHeight = 0;
    let canvasWidth: number | undefined;
    let canvasHeight: number | undefined;
    let sawExtendedHeader = false;
    let sawAlphaChunk = false;
    let primaryType: "VP8 " | "VP8L" | undefined;

    while (offset < bytes.length) {
      chunkCount += 1;
      if (chunkCount > IMAGE_MAX_CONTAINER_BLOCKS || offset + 8 > bytes.length) return undefined;
      const chunkType = bytes.toString("ascii", offset, offset + 4);
      if (!isPrintableFourCc(bytes, offset)) return undefined;
      const chunkLength = bytes.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      const dataEnd = dataOffset + chunkLength;
      const paddedEnd = dataEnd + (chunkLength & 1);
      if (dataEnd < dataOffset || paddedEnd > bytes.length) return undefined;
      if ((chunkLength & 1) !== 0 && bytes[dataEnd] !== 0) return undefined;

      if (chunkType === "VP8X") {
        if (sawExtendedHeader || chunkCount !== 1 || chunkLength !== 10) return undefined;
        const flags = bytes[dataOffset];
        if (
          (flags & 0xc1) !== 0 ||
          bytes[dataOffset + 1] !== 0 ||
          bytes[dataOffset + 2] !== 0 ||
          bytes[dataOffset + 3] !== 0 ||
          (flags & 0x02) !== 0
        ) {
          return undefined;
        }
        canvasWidth = readUInt24LE(bytes, dataOffset + 4) + 1;
        canvasHeight = readUInt24LE(bytes, dataOffset + 7) + 1;
        if (!isSafeStaticDimensions(canvasWidth, canvasHeight)) return undefined;
        sawExtendedHeader = true;
      } else if (chunkType === "ANIM" || chunkType === "ANMF") {
        return undefined;
      } else if (chunkType === "ALPH") {
        if (sawAlphaChunk) return undefined;
        sawAlphaChunk = true;
      } else if (chunkType === "VP8 " || chunkType === "VP8L") {
        if (primaryType !== undefined) return undefined;
        const dimensions =
          chunkType === "VP8 "
            ? parseLossyWebpDimensions(bytes, dataOffset, chunkLength)
            : parseLosslessWebpDimensions(bytes, dataOffset, chunkLength);
        if (!dimensions || !isSafeStaticDimensions(dimensions.width, dimensions.height)) return undefined;
        primaryType = chunkType;
        primaryWidth = dimensions.width;
        primaryHeight = dimensions.height;
        primaryChunkIndex = chunkCount;
      }
      offset = paddedEnd;
    }

    if (offset !== bytes.length || primaryType === undefined) return undefined;
    if (!sawExtendedHeader) {
      if (chunkCount !== 1 || primaryChunkIndex !== 1 || sawAlphaChunk) return undefined;
      return { width: primaryWidth, height: primaryHeight };
    }
    if (
      canvasWidth !== primaryWidth ||
      canvasHeight !== primaryHeight ||
      (sawAlphaChunk && primaryType !== "VP8 ")
    ) {
      return undefined;
    }
    return { width: canvasWidth, height: canvasHeight };
  } catch {
    return undefined;
  }
}

function parseLossyWebpDimensions(
  bytes: Buffer,
  offset: number,
  length: number
): SafeRasterMetadata | undefined {
  if (length < 10) return undefined;
  const frameTag = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  const firstPartitionLength = frameTag >>> 5;
  if (
    (frameTag & 1) !== 0 ||
    ((frameTag >> 1) & 0x07) > 3 ||
    ((frameTag >> 4) & 1) !== 1 ||
    firstPartitionLength > length - 3 ||
    bytes[offset + 3] !== 0x9d ||
    bytes[offset + 4] !== 0x01 ||
    bytes[offset + 5] !== 0x2a
  ) {
    return undefined;
  }
  const width = bytes.readUInt16LE(offset + 6) & 0x3fff;
  const height = bytes.readUInt16LE(offset + 8) & 0x3fff;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseLosslessWebpDimensions(
  bytes: Buffer,
  offset: number,
  length: number
): SafeRasterMetadata | undefined {
  if (length < 5 || bytes[offset] !== 0x2f) return undefined;
  const header = bytes.readUInt32LE(offset + 1);
  if ((header >>> 29) !== 0) return undefined;
  return {
    width: (header & 0x3fff) + 1,
    height: ((header >>> 14) & 0x3fff) + 1,
  };
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function isPrintableFourCc(bytes: Buffer, offset: number): boolean {
  for (let index = 0; index < 4; index += 1) {
    if (bytes[offset + index] < 0x20 || bytes[offset + index] > 0x7e) return false;
  }
  return true;
}

function isSafeStaticDimensions(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= STATIC_MAX_DIMENSION &&
    height <= STATIC_MAX_DIMENSION &&
    width * height <= STATIC_MAX_PIXELS
  );
}

interface GifFrameRecord {
  width: number;
  height: number;
  colorCount: number;
  minimumCodeSize: number;
  compressed: Buffer;
}

interface GifSubBlocks {
  nextOffset: number;
  blockCount: number;
  chunks: Buffer[];
  byteLength: number;
}

/**
 * Parse and validate a GIF before it reaches a browser or document decoder.
 *
 * The network byte cap alone cannot stop a tiny LZW stream from declaring a
 * huge canvas or hundreds of frames. This validator walks the complete GIF
 * container, applies bounded animation budgets, then validates each frame's
 * LZW code stream without materializing decoded pixels.
 */
export function validateGifStructure(bytes: Buffer): SafeGifMetadata | undefined {
  try {
    if (bytes.length < 14 || bytes.length > IMAGE_MAX_BYTES) return undefined;
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;

    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    if (
      width === 0 ||
      height === 0 ||
      width > GIF_MAX_DIMENSION ||
      height > GIF_MAX_DIMENSION ||
      width * height > GIF_MAX_CANVAS_PIXELS
    ) {
      return undefined;
    }

    const logicalPacked = bytes[10];
    const hasGlobalColorTable = (logicalPacked & 0x80) !== 0;
    const globalColorCount = hasGlobalColorTable ? 1 << ((logicalPacked & 0x07) + 1) : 0;
    if (hasGlobalColorTable && bytes[11] >= globalColorCount) return undefined;

    let offset = 13;
    if (hasGlobalColorTable) {
      offset = skipGifBytes(bytes, offset, globalColorCount * 3);
      if (offset < 0) return undefined;
    }

    const frames: GifFrameRecord[] = [];
    let totalFramePixels = 0;
    let durationMs = 0;
    let blockCount = 0;
    let pendingDelayMs: number | undefined;
    let pendingTransparentIndex: number | undefined;
    let loopCount: number | undefined;
    let sawTrailer = false;

    while (offset < bytes.length) {
      blockCount += 1;
      if (blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
      const marker = bytes[offset++];

      if (marker === 0x3b) {
        // Reject both a dangling graphics-control extension and appended data.
        if (pendingDelayMs !== undefined || offset !== bytes.length) return undefined;
        sawTrailer = true;
        break;
      }

      if (marker === 0x21) {
        if (offset >= bytes.length) return undefined;
        const label = bytes[offset++];

        if (label === 0xf9) {
          if (pendingDelayMs !== undefined || offset + 6 > bytes.length) return undefined;
          if (bytes[offset] !== 4 || bytes[offset + 5] !== 0) return undefined;
          const packed = bytes[offset + 1];
          const disposalMethod = (packed >> 2) & 0x07;
          // Reserved bits, user-input waiting, and reserved disposal modes are
          // intentionally unsupported because they create ambiguous playback.
          if ((packed & 0xe0) !== 0 || (packed & 0x02) !== 0 || disposalMethod > 3) return undefined;
          const delayCentiseconds = bytes.readUInt16LE(offset + 2);
          pendingDelayMs = delayCentiseconds * 10;
          pendingTransparentIndex = (packed & 0x01) !== 0 ? bytes[offset + 4] : undefined;
          offset += 6;
          continue;
        }

        if (label === 0xff) {
          // Application extension: exactly 11 bytes of identifier/auth data,
          // followed by ordinary data sub-blocks (e.g. NETSCAPE loop metadata).
          if (offset >= bytes.length || bytes[offset] !== 11) return undefined;
          const applicationId = bytes.subarray(offset + 1, offset + 12).toString("ascii");
          offset = skipGifBytes(bytes, offset + 1, 11);
          if (offset < 0) return undefined;
          const extension = readGifSubBlocks(bytes, offset);
          if (!extension) return undefined;
          blockCount += extension.blockCount;
          if (blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
          offset = extension.nextOffset;
          if (applicationId === "NETSCAPE2.0" || applicationId === "ANIMEXTS1.0") {
            if (frames.length > 0 || loopCount !== undefined) return undefined;
            if (
              extension.chunks.length !== 1 ||
              extension.chunks[0].length !== 3 ||
              extension.chunks[0][0] !== 1
            ) {
              return undefined;
            }
            loopCount = extension.chunks[0].readUInt16LE(1);
            // A zero loop count means unbounded playback in both extensions.
            if (loopCount === 0) return undefined;
          }
          continue;
        }

        if (label === 0xfe) {
          const comment = readGifSubBlocks(bytes, offset);
          if (!comment) return undefined;
          blockCount += comment.blockCount;
          if (blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
          offset = comment.nextOffset;
          continue;
        }

        // Plain-text and unknown extensions expand the decoder surface without
        // helping article media, so reject them rather than interpreting them.
        return undefined;
      }

      if (marker !== 0x2c || offset + 9 > bytes.length) return undefined;
      const left = bytes.readUInt16LE(offset);
      const top = bytes.readUInt16LE(offset + 2);
      const frameWidth = bytes.readUInt16LE(offset + 4);
      const frameHeight = bytes.readUInt16LE(offset + 6);
      const imagePacked = bytes[offset + 8];
      offset += 9;

      if (
        frameWidth === 0 ||
        frameHeight === 0 ||
        left + frameWidth > width ||
        top + frameHeight > height ||
        (imagePacked & 0x18) !== 0
      ) {
        return undefined;
      }

      const hasLocalColorTable = (imagePacked & 0x80) !== 0;
      const localColorCount = hasLocalColorTable ? 1 << ((imagePacked & 0x07) + 1) : 0;
      if (hasLocalColorTable) {
        offset = skipGifBytes(bytes, offset, localColorCount * 3);
        if (offset < 0) return undefined;
      }
      const colorCount = localColorCount || globalColorCount;
      if (colorCount === 0) return undefined;
      if (pendingTransparentIndex !== undefined && pendingTransparentIndex >= colorCount) return undefined;

      if (offset >= bytes.length) return undefined;
      const minimumCodeSize = bytes[offset++];
      if (minimumCodeSize < 2 || minimumCodeSize > 8) return undefined;
      const imageData = readGifSubBlocks(bytes, offset);
      if (!imageData || imageData.byteLength === 0) return undefined;
      blockCount += imageData.blockCount;
      if (blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
      offset = imageData.nextOffset;

      const framePixels = frameWidth * frameHeight;
      totalFramePixels += framePixels;
      const nextFrameCount = frames.length + 1;
      if (
        nextFrameCount > GIF_MAX_FRAMES ||
        width * height * nextFrameCount > GIF_MAX_COMPOSITED_PIXELS
      ) {
        return undefined;
      }
      durationMs += Math.max(pendingDelayMs ?? 0, GIF_MIN_FRAME_DURATION_MS);
      if (durationMs > GIF_MAX_DURATION_MS) return undefined;

      frames.push({
        width: frameWidth,
        height: frameHeight,
        colorCount,
        minimumCodeSize,
        compressed: Buffer.concat(imageData.chunks, imageData.byteLength),
      });
      pendingDelayMs = undefined;
      pendingTransparentIndex = undefined;
    }

    if (!sawTrailer || frames.length === 0) return undefined;
    for (const frame of frames) {
      if (
        !validateGifLzw(
          frame.compressed,
          frame.minimumCodeSize,
          frame.width * frame.height,
          frame.colorCount
        )
      ) {
        return undefined;
      }
    }

    // Netscape's finite loop value is the number of repeats after the first
    // play. Charge every play against bounded wall-clock and decode budgets.
    const totalPlays = loopCount === undefined ? 1 : loopCount + 1;
    const compositedPixels = width * height * frames.length;
    if (
      durationMs * totalPlays > GIF_MAX_TOTAL_PLAYBACK_DURATION_MS ||
      compositedPixels * totalPlays > GIF_MAX_TOTAL_PLAYBACK_COMPOSITED_PIXELS
    ) {
      return undefined;
    }

    return { width, height, frameCount: frames.length, totalFramePixels, durationMs };
  } catch {
    // Bounds checks above should make parser exceptions rare; malformed binary
    // input is still treated as an ordinary rejected image, never a hard error.
    return undefined;
  }
}

function skipGifBytes(bytes: Buffer, offset: number, count: number): number {
  return offset >= 0 && count >= 0 && offset + count <= bytes.length ? offset + count : -1;
}

/** Read a GIF data-sub-block chain, including its mandatory zero terminator. */
function readGifSubBlocks(bytes: Buffer, startOffset: number): GifSubBlocks | undefined {
  let offset = startOffset;
  let blockCount = 0;
  let byteLength = 0;
  const chunks: Buffer[] = [];

  while (offset < bytes.length) {
    const size = bytes[offset++];
    blockCount += 1;
    if (blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
    if (size === 0) return { nextOffset: offset, blockCount, chunks, byteLength };
    if (offset + size > bytes.length) return undefined;
    chunks.push(bytes.subarray(offset, offset + size));
    byteLength += size;
    offset += size;
  }
  return undefined;
}

/**
 * Validate one frame's GIF LZW stream without allocating its decoded pixels.
 * Dictionary entries track only expansion length and first palette index.
 */
function validateGifLzw(
  data: Buffer,
  minimumCodeSize: number,
  expectedPixels: number,
  colorCount: number
): boolean {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const expansionLength = new Uint32Array(4_096);
  const firstColor = new Uint16Array(4_096);
  for (let code = 0; code < clearCode; code += 1) {
    expansionLength[code] = 1;
    firstColor[code] = code;
  }

  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previousCode = -1;
  let decodedPixels = 0;
  let bitOffset = 0;
  let codeCount = 0;
  let sawClear = false;
  let sawEnd = false;

  while (bitOffset + codeSize <= data.length * 8) {
    codeCount += 1;
    if (codeCount > GIF_MAX_LZW_CODES) return false;
    const code = readGifCode(data, bitOffset, codeSize);
    if (code === undefined) return false;
    bitOffset += codeSize;

    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = -1;
      sawClear = true;
      continue;
    }
    if (!sawClear) return false;
    if (code === endCode) {
      sawEnd = true;
      break;
    }

    if (previousCode < 0) {
      if (code >= clearCode || code >= colorCount) return false;
      decodedPixels += 1;
      previousCode = code;
      continue;
    }

    let currentLength = 0;
    if (code < nextCode && expansionLength[code] > 0) {
      currentLength = expansionLength[code];
      if (firstColor[code] >= colorCount) return false;
    } else if (code === nextCode && expansionLength[previousCode] > 0) {
      currentLength = expansionLength[previousCode] + 1;
    } else {
      return false;
    }

    decodedPixels += currentLength;
    if (decodedPixels > expectedPixels) return false;

    if (nextCode < 4_096) {
      const previousLength = expansionLength[previousCode];
      if (previousLength === 0 || previousLength >= expectedPixels) return false;
      expansionLength[nextCode] = previousLength + 1;
      firstColor[nextCode] = firstColor[previousCode];
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previousCode = code;
  }

  if (!sawEnd || decodedPixels !== expectedPixels) return false;
  const paddingBits = data.length * 8 - bitOffset;
  // FFmpeg's GIF encoder can flush one whole zero byte after the end code.
  // Accept that bounded, inert padding while still rejecting hidden codes or
  // arbitrarily padded payloads inside image-data sub-blocks.
  if (paddingBits > 8) return false;
  for (let bit = bitOffset; bit < data.length * 8; bit += 1) {
    if (((data[bit >> 3] >> (bit & 7)) & 1) !== 0) return false;
  }
  return true;
}

/** GIF codes are packed least-significant bit first. */
function readGifCode(data: Buffer, bitOffset: number, width: number): number | undefined {
  if (bitOffset < 0 || width < 1 || bitOffset + width > data.length * 8) return undefined;
  let code = 0;
  for (let bit = 0; bit < width; bit += 1) {
    code |= ((data[(bitOffset + bit) >> 3] >> ((bitOffset + bit) & 7)) & 1) << bit;
  }
  return code;
}

interface SourceImageCandidateHint {
  rawUrl: string;
  width?: number;
  height?: number;
  context?: string;
}

interface SourceImageCandidateGroups {
  openGraph: SourceImageCandidateHint[];
  twitter: SourceImageCandidateHint[];
  genericMeta: SourceImageCandidateHint[];
}

type HtmlAttributes = Record<string, string>;

/**
 * Discover ordered, attributable image candidates from a source page.
 *
 * Social metadata remains the strongest signal, followed by JSON-LD article
 * media and images inside semantic or strongly identified article content.
 * Every candidate is only a URL here: the selected asset still goes through
 * the complete binary/MIME/container/decode validation before it can enter an
 * article.
 */
export function extractSourceImageCandidatesFromHtml(html: string, pageUrl: string): string[] {
  if (!html || !pageUrl) return [];
  const boundedHtml = html.slice(0, SOURCE_PAGE_MAX_BYTES);
  const social = collectSocialImageCandidates(boundedHtml);
  const linkCandidates = collectImageSrcLinkCandidates(boundedHtml);
  const jsonLdCandidates = collectJsonLdImageCandidates(boundedHtml);
  const contentCandidates = collectArticleImageCandidates(boundedHtml);
  const resolvedGroups = [
    social.openGraph,
    jsonLdCandidates,
    contentCandidates,
    social.twitter,
    linkCandidates,
    social.genericMeta,
  ].map((group) => resolveSourceImageCandidateGroup(group, pageUrl));
  // Rotate source families so dozens of stale OG tags cannot consume every
  // bounded validation attempt before JSON-LD or the real article body.
  const ordered = interleaveSourceImageUrlGroups(resolvedGroups);

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const imageUrl of ordered) {
    if (resolved.length >= SOURCE_IMAGE_MAX_CANDIDATES) break;
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    resolved.push(imageUrl);
  }
  return resolved;
}

/**
 * Preserve the original single-result export for callers that only need the
 * highest-ranked candidate. Fetching uses the complete ordered candidate list.
 */
export function extractSourceImageFromHtml(html: string, pageUrl: string): string | undefined {
  return extractSourceImageCandidatesFromHtml(html, pageUrl)[0];
}

/**
 * Download and fully validate a small, deadline-bounded candidate sequence.
 * A public URL that returns HTML, 404, oversized bytes, a spoofed MIME, or an
 * undecodable raster is treated as an ordinary miss and cannot suppress the
 * next real image.
 */
export interface SourceImageCandidateSelectionOptions {
  validator?: (url: string, timeoutMs: number) => Promise<SafeImageBinary | undefined>;
  maxAttempts?: number;
  deadlineMs?: number;
  perCandidateTimeoutMs?: number;
}

export async function selectFirstSafeSourceImageCandidate(
  candidates: readonly string[],
  options: SourceImageCandidateSelectionOptions = {}
): Promise<string | undefined> {
  const validator = options.validator ?? ((candidate, timeoutMs) => fetchSafeImageBinary(candidate, timeoutMs));
  const maxAttempts = boundedPositiveInteger(
    options.maxAttempts,
    SOURCE_IMAGE_MAX_VALIDATION_ATTEMPTS,
    SOURCE_IMAGE_MAX_VALIDATION_ATTEMPTS
  );
  const deadlineMs = boundedPositiveInteger(
    options.deadlineMs,
    SOURCE_IMAGE_VALIDATION_DEADLINE_MS,
    SOURCE_IMAGE_VALIDATION_DEADLINE_MS
  );
  const perCandidateTimeoutMs = boundedPositiveInteger(
    options.perCandidateTimeoutMs,
    SOURCE_IMAGE_PER_CANDIDATE_TIMEOUT_MS,
    SOURCE_IMAGE_PER_CANDIDATE_TIMEOUT_MS
  );
  const deadlineAt = Date.now() + deadlineMs;

  for (const candidate of candidates.slice(0, maxAttempts)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    const attemptTimeoutMs = Math.max(1, Math.min(perCandidateTimeoutMs, remainingMs));
    try {
      const outcome = await settleSourceImageValidation(
        validator(candidate, attemptTimeoutMs),
        attemptTimeoutMs
      );
      // The timed-out task may be inside an uninterruptible decoder. Stop the
      // chain instead of stacking another validator behind it.
      if (outcome.timedOut) break;
      if (outcome.value) return candidate;
    } catch {
      // A page often contains stale or blocked metadata before its real image.
    }
  }
  return undefined;
}

function resolveSourceImageCandidateGroup(
  candidates: readonly SourceImageCandidateHint[],
  pageUrl: string
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const imageUrl = resolveSourceImageCandidate(candidate, pageUrl);
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    resolved.push(imageUrl);
    if (resolved.length >= SOURCE_IMAGE_MAX_CANDIDATES) break;
  }
  return resolved;
}

function interleaveSourceImageUrlGroups(groups: readonly string[][]): string[] {
  const ordered: string[] = [];
  for (let candidateIndex = 0; ordered.length < SOURCE_IMAGE_MAX_CANDIDATES; candidateIndex += 1) {
    let added = false;
    for (const group of groups) {
      const candidate = group[candidateIndex];
      if (!candidate) continue;
      ordered.push(candidate);
      added = true;
      if (ordered.length >= SOURCE_IMAGE_MAX_CANDIDATES) break;
    }
    if (!added) break;
  }
  return ordered;
}

async function settleSourceImageValidation(
  validation: Promise<SafeImageBinary | undefined>,
  timeoutMs: number
): Promise<
  | { timedOut: false; value: SafeImageBinary | undefined }
  | { timedOut: true; value?: undefined }
> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      validation.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true; value?: undefined }>((resolve) => {
        timer = setNodeTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearNodeTimeout(timer);
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(value as number, hardMaximum);
}

function collectSocialImageCandidates(html: string): SourceImageCandidateGroups {
  const groups: SourceImageCandidateGroups = {
    openGraph: [],
    twitter: [],
    genericMeta: [],
  };
  let currentOpenGraph: SourceImageCandidateHint | undefined;
  let currentTwitter: SourceImageCandidateHint | undefined;
  const tagPattern = /<meta\b[^>]{0,8192}>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const attributes = parseHtmlAttributes(match[0]);
    const key = (attributes.property || attributes.name || "").trim().toLowerCase();
    const itemProp = (attributes.itemprop || "").trim().toLowerCase();
    const content = attributes.content?.trim();

    if (/^og:image(?::(?:secure_url|url))?$/.test(key) && content) {
      currentOpenGraph = { rawUrl: content, context: key };
      pushSourceImageHint(groups.openGraph, currentOpenGraph);
      continue;
    }
    if (key === "og:image:width" && currentOpenGraph) {
      currentOpenGraph.width = parseImageDimension(content);
      continue;
    }
    if (key === "og:image:height" && currentOpenGraph) {
      currentOpenGraph.height = parseImageDimension(content);
      continue;
    }

    if (/^twitter:image(?::src)?$/.test(key) && content) {
      currentTwitter = { rawUrl: content, context: key };
      pushSourceImageHint(groups.twitter, currentTwitter);
      continue;
    }
    if (key === "twitter:image:width" && currentTwitter) {
      currentTwitter.width = parseImageDimension(content);
      continue;
    }
    if (key === "twitter:image:height" && currentTwitter) {
      currentTwitter.height = parseImageDimension(content);
      continue;
    }

    if (itemProp === "image" && content) {
      pushSourceImageHint(groups.genericMeta, {
        rawUrl: content,
        context: "itemprop image",
      });
    }
  }
  return groups;
}

function collectImageSrcLinkCandidates(html: string): SourceImageCandidateHint[] {
  const candidates: SourceImageCandidateHint[] = [];
  const tagPattern = /<link\b[^>]{0,8192}>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const attributes = parseHtmlAttributes(match[0]);
    const relTokens = (attributes.rel || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes("image_src") || !attributes.href) continue;
    pushSourceImageHint(candidates, {
      rawUrl: attributes.href,
      context: "link image_src",
    });
  }
  return candidates;
}

function collectJsonLdImageCandidates(html: string): SourceImageCandidateHint[] {
  const candidates: SourceImageCandidateHint[] = [];
  const scriptPattern = /<script\b([^>]{0,8192})>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    const attributes = parseHtmlAttributes(match[1] || "");
    if ((attributes.type || "").split(";", 1)[0].trim().toLowerCase() !== "application/ld+json") {
      continue;
    }
    const source = stripJsonLdWrappers(match[2] || "");
    if (!source || source.length > SOURCE_PAGE_MAX_BYTES) continue;

    let root: unknown;
    try {
      root = JSON.parse(source) as unknown;
    } catch {
      continue;
    }

    const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < SOURCE_IMAGE_JSON_LD_MAX_NODES) {
      const entry = queue.shift();
      if (!entry || entry.depth > SOURCE_IMAGE_JSON_LD_MAX_DEPTH) continue;
      visited += 1;

      if (Array.isArray(entry.value)) {
        for (const child of entry.value.slice(0, SOURCE_IMAGE_MAX_CANDIDATES)) {
          if (queue.length >= SOURCE_IMAGE_JSON_LD_MAX_NODES) break;
          queue.push({ value: child, depth: entry.depth + 1 });
        }
        continue;
      }
      if (!isRecord(entry.value)) continue;

      const typeNames = jsonLdTypeNames(entry.value["@type"]);
      const isArticle = typeNames.some((typeName) => isJsonLdArticleType(typeName));
      const isImageObject = typeNames.some((typeName) => typeName === "imageobject");
      if (isArticle) {
        collectJsonLdImageValue(entry.value.image, candidates, "JSON-LD Article.image");
        collectJsonLdImageValue(entry.value.thumbnailUrl, candidates, "JSON-LD Article.thumbnailUrl");
      }
      if (isImageObject) {
        collectJsonLdImageObject(entry.value, candidates, "JSON-LD ImageObject");
      }

      for (const child of Object.values(entry.value).slice(0, SOURCE_IMAGE_MAX_CANDIDATES)) {
        if (queue.length >= SOURCE_IMAGE_JSON_LD_MAX_NODES) break;
        if (child !== null && typeof child === "object") {
          queue.push({ value: child, depth: entry.depth + 1 });
        }
      }
    }
  }
  return candidates;
}

function collectJsonLdImageValue(
  value: unknown,
  candidates: SourceImageCandidateHint[],
  context: string
): void {
  const queue: unknown[] = [value];
  let visited = 0;
  while (queue.length > 0 && visited < SOURCE_IMAGE_MAX_CANDIDATES) {
    const current = queue.shift();
    visited += 1;
    if (typeof current === "string") {
      pushSourceImageHint(candidates, { rawUrl: current, context });
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current.slice(0, SOURCE_IMAGE_MAX_CANDIDATES));
      continue;
    }
    if (!isRecord(current)) continue;
    collectJsonLdImageObject(current, candidates, context);
    for (const nested of [current.image, current.thumbnail]) {
      if (nested !== undefined) queue.push(nested);
    }
  }
}

function collectJsonLdImageObject(
  record: Record<string, unknown>,
  candidates: SourceImageCandidateHint[],
  context: string
): void {
  const width = parseImageDimension(record.width);
  const height = parseImageDimension(record.height);
  const descriptiveContext = [
    context,
    asString(record.name),
    asString(record.caption),
    asString(record.description),
  ].filter(Boolean).join(" ");
  for (const key of ["contentUrl", "url", "thumbnailUrl"] as const) {
    const value = record[key];
    if (typeof value === "string") {
      pushSourceImageHint(candidates, {
        rawUrl: value,
        width,
        height,
        context: descriptiveContext,
      });
    } else if (Array.isArray(value)) {
      for (const rawUrl of value) {
        if (typeof rawUrl === "string") {
          pushSourceImageHint(candidates, {
            rawUrl,
            width,
            height,
            context: descriptiveContext,
          });
        }
      }
    }
  }
}

function collectArticleImageCandidates(html: string): SourceImageCandidateHint[] {
  const figureCandidates: SourceImageCandidateHint[] = [];
  const articleCandidates: SourceImageCandidateHint[] = [];
  const searchableHtml = html.replace(
    /<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)\s*>/gi,
    ""
  );
  const tokenPattern = /<\s*(\/?)\s*(article|figure|main|div)\b([^>]{0,8192})>|<\s*img\b([^>]{0,8192})>/gi;
  const articleHints: string[] = [];
  const figureHints: string[] = [];
  const divHints: Array<string | undefined> = [];
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(searchableHtml)) !== null) {
    const containerName = match[2]?.toLowerCase();
    if (containerName) {
      if (containerName === "div") {
        if (match[1]) {
          divHints.pop();
        } else {
          const attributes = parseHtmlAttributes(match[3] || "");
          divHints.push(
            isLikelyArticleContentContainer(attributes)
              ? imageContextFromAttributes(attributes)
              : undefined
          );
          if (/\/\s*>$/.test(match[0])) divHints.pop();
        }
        continue;
      }

      const stack = containerName === "figure" ? figureHints : articleHints;
      if (match[1]) {
        stack.pop();
      } else {
        const attributes = parseHtmlAttributes(match[3] || "");
        stack.push(imageContextFromAttributes(attributes));
        if (/\/\s*>$/.test(match[0])) stack.pop();
      }
      continue;
    }
    const activeDivHints = divHints.filter((hint): hint is string => hint !== undefined);
    if (figureHints.length === 0 && articleHints.length === 0 && activeDivHints.length === 0) {
      continue;
    }

    const attributes = parseHtmlAttributes(match[4] || "");
    const context = [
      ...articleHints.slice(-2),
      ...activeDivHints.slice(-2),
      ...figureHints.slice(-2),
      imageContextFromAttributes(attributes),
    ].filter(Boolean).join(" ");
    const target = figureHints.length > 0 ? figureCandidates : articleCandidates;
    collectImageElementCandidates(attributes, context, target);
  }
  return [...figureCandidates, ...articleCandidates];
}

/**
 * Recognize only strong article-body signals on generic div containers.
 * Broad names such as `content` alone are deliberately excluded because they
 * commonly wrap navigation, recommendations, and advertising as well.
 */
function isLikelyArticleContentContainer(attributes: HtmlAttributes): boolean {
  const role = attributes.role?.trim().toLowerCase();
  if (role === "main") return true;

  const itemPropTokens = (attributes.itemprop || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (itemPropTokens.includes("articlebody")) return true;

  const identifiers = [attributes.id, attributes.class]
    .flatMap((value) => value ? value.toLowerCase().split(/\s+/) : [])
    .map((value) => value.replace(/[_:]+/g, "-"))
    .filter(Boolean);
  return identifiers.some((identifier) =>
    ARTICLE_CONTENT_CONTAINER_EXACT_NAMES.has(identifier)
    || ARTICLE_CONTENT_CONTAINER_NAME_PATTERN.test(identifier)
  );
}

function collectImageElementCandidates(
  attributes: HtmlAttributes,
  context: string,
  candidates: SourceImageCandidateHint[]
): void {
  const width = parseImageDimension(attributes.width);
  const height = parseImageDimension(attributes.height);
  for (const attributeName of ["data-srcset", "data-lazy-srcset"] as const) {
    for (const source of parseSrcset(attributes[attributeName])) {
      pushSourceImageHint(candidates, {
        rawUrl: source.rawUrl,
        width: source.width ?? width,
        height,
        context,
      });
    }
  }
  for (const attributeName of [
    "data-src",
    "data-original",
    "data-original-src",
    "data-lazy-src",
  ] as const) {
    if (!attributes[attributeName]) continue;
    pushSourceImageHint(candidates, {
      rawUrl: attributes[attributeName],
      width,
      height,
      context,
    });
  }
  for (const source of parseSrcset(attributes.srcset)) {
    pushSourceImageHint(candidates, {
      rawUrl: source.rawUrl,
      width: source.width ?? width,
      height,
      context,
    });
  }
  if (attributes.src) {
    pushSourceImageHint(candidates, {
      rawUrl: attributes.src,
      width,
      height,
      context,
    });
  }
}

function parseSrcset(value: string | undefined): Array<{ rawUrl: string; width?: number; score: number }> {
  if (!value) return [];
  return value
    .split(",")
    .map((entry, index) => {
      const parts = entry.trim().split(/\s+/);
      const descriptor = parts[1] || "";
      const widthMatch = /^(\d{1,6})w$/i.exec(descriptor);
      const densityMatch = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
      const width = widthMatch ? Number(widthMatch[1]) : undefined;
      const score = width ?? (densityMatch ? Number(densityMatch[1]) * 1_000 : 0) - index / 1_000;
      return { rawUrl: parts[0] || "", width, score };
    })
    .filter((entry) => Boolean(entry.rawUrl))
    .sort((left, right) => right.score - left.score);
}

function resolveSourceImageCandidate(
  candidate: SourceImageCandidateHint,
  pageUrl: string
): string | undefined {
  if (!candidate.rawUrl || candidate.rawUrl.length > SOURCE_IMAGE_MAX_URL_CHARS) return undefined;
  const resolved = resolveImageUrl(candidate.rawUrl, pageUrl);
  if (!resolved) return undefined;
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return undefined;
  }
  if (isLikelyNonContentImage(url, candidate)) return undefined;
  url.hash = "";
  return url.toString();
}

function isLikelyNonContentImage(url: URL, candidate: SourceImageCandidateHint): boolean {
  const decodedPath = safeDecodeUrlPart(url.pathname);
  const decodedQuery = safeDecodeUrlPart(url.search);
  if (/\.(?:svg|svgz|ico)$/i.test(decodedPath)) return true;

  const context = `${decodedPath} ${decodedQuery} ${candidate.context || ""}`.toLowerCase();
  const nonContentToken = /(?:^|[\/_.+%\-=\s])(favicon|apple-touch-icon|site-icon|icons?|logos?|brandmark|avatars?|userpic|profile-photo|emoji|sprite|spacer|blank|transparent|placeholder|fallback|default-image|tracking|tracker|beacon|pixel|analytics)(?=$|[\/_.+%\-=&\s])/i;
  if (nonContentToken.test(context) || /(?:^|[\/_.-])1x1(?:[\/_.-]|$)/i.test(context)) return true;

  const queryWidth = imageDimensionFromQuery(url, ["w", "width", "image_width"]);
  const queryHeight = imageDimensionFromQuery(url, ["h", "height", "image_height"]);
  const width = queryWidth ?? candidate.width;
  const height = queryHeight ?? candidate.height;
  if (width !== undefined && width < SOURCE_IMAGE_MIN_WIDTH_HINT) return true;
  if (height !== undefined && height < SOURCE_IMAGE_MIN_HEIGHT_HINT) return true;
  return width !== undefined && height !== undefined && width * height < SOURCE_IMAGE_MIN_AREA_HINT;
}

function imageDimensionFromQuery(url: URL, names: readonly string[]): number | undefined {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of url.searchParams) {
    if (!accepted.has(key.toLowerCase())) continue;
    const dimension = parseImageDimension(value);
    if (dimension !== undefined) return dimension;
  }
  return undefined;
}

function parseHtmlAttributes(tag: string): HtmlAttributes {
  const attributes: HtmlAttributes = Object.create(null) as HtmlAttributes;
  const attributePattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(tag)) !== null) {
    const name = match[1].toLowerCase();
    if (name in attributes) continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi, (entity, decimal, hexadecimal) => {
    const named = entity.toLowerCase();
    if (named === "&amp;") return "&";
    if (named === "&quot;") return '"';
    if (named === "&apos;" || named === "&#39;" || named === "&#x27;") return "'";
    if (named === "&lt;") return "<";
    if (named === "&gt;") return ">";
    const codePoint = Number.parseInt(decimal || hexadecimal, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return "";
    }
  });
}

function parseImageDimension(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : undefined;
  }
  if (typeof value === "string") {
    const match = /^\s*(\d{1,6})(?:px)?\s*$/i.exec(value);
    if (!match) return undefined;
    const number = Number(match[1]);
    return number >= 0 && number <= 100_000 ? number : undefined;
  }
  if (isRecord(value)) return parseImageDimension(value.value);
  return undefined;
}

function imageContextFromAttributes(attributes: HtmlAttributes): string {
  return [attributes.id, attributes.class, attributes.role, attributes.alt, attributes.title]
    .filter(Boolean)
    .join(" ");
}

function pushSourceImageHint(
  candidates: SourceImageCandidateHint[],
  candidate: SourceImageCandidateHint
): void {
  if (candidates.length >= SOURCE_IMAGE_MAX_CANDIDATES || !candidate.rawUrl?.trim()) return;
  candidate.rawUrl = candidate.rawUrl.trim();
  candidates.push(candidate);
}

function stripJsonLdWrappers(value: string): string {
  return value
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/^\s*\/\*<!\[CDATA\[\*\//, "")
    .replace(/\/\*\]\]>\*\/\s*$/, "")
    .trim();
}

function jsonLdTypeNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.split(/[\/#]/).pop()?.trim().toLowerCase() || "")
    .filter(Boolean);
}

function isJsonLdArticleType(typeName: string): boolean {
  return typeName === "blogposting" || typeName === "report" || typeName.endsWith("article");
}

function safeDecodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve a raw image reference against the page URL; accept only http(s). */
function resolveImageUrl(raw: string | undefined, pageUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw.replace(/&amp;/g, "&"), pageUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeImageMime(value: string | undefined): SafeImageBinary["mimeType"] | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  if (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/gif" ||
    mime === "image/webp"
  ) {
    return mime;
  }
  return undefined;
}

function detectRasterImageMime(bytes: Buffer): SafeImageBinary["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const signature = bytes.subarray(0, 12).toString("ascii");
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}
