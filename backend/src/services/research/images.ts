import { TextDecoder } from "node:util";
import { inflateSync } from "node:zlib";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import sharp from "sharp";
import { cached } from "./cache.js";
import {
  fetchBinaryWithOutboundPolicy,
  fetchTextWithOutboundPolicy,
} from "./networkSafety.js";
import { asString, isRecord, tryParseJson } from "./parse.js";
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
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
    if (bytes.length < 45 || bytes.length > IMAGE_MAX_BYTES || !hasPngSignature(bytes)) return undefined;

    let offset = PNG_SIGNATURE.length;
    let header: PngHeader | undefined;
    const state: PngChunkState = {
      paletteEntries: 0,
      sawPalette: false,
      sawImageData: false,
      endedImageData: false,
      sawIccProfile: false,
      ancillaryChunkCount: 0,
      ancillaryBytes: 0,
      decodedMetadataBytes: 0,
      compressedLength: 0,
      compressedChunks: [],
    };

    for (let chunkCount = 1; offset < bytes.length; chunkCount += 1) {
      if (chunkCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
      const chunk = readPngChunk(bytes, offset);
      if (!chunk) return undefined;
      offset = chunk.end;

      if (chunk.type === "IHDR") {
        if (chunkCount !== 1 || header || chunk.length !== 13) return undefined;
        header = parsePngHeader(bytes, chunk.dataOffset);
        if (!header) return undefined;
        continue;
      }
      if (!header || !acceptPngChunk(bytes, chunk, state)) return undefined;
      if (chunk.type === "IEND") {
        if (chunk.length !== 0 || !state.sawImageData || offset !== bytes.length) return undefined;
        return validatePngImageData(header, state);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface PngChunk {
  type: string;
  length: number;
  dataOffset: number;
  dataEnd: number;
  end: number;
  ancillary: boolean;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaceMethod: number;
}

interface PngChunkState {
  paletteEntries: number;
  sawPalette: boolean;
  sawImageData: boolean;
  endedImageData: boolean;
  sawIccProfile: boolean;
  ancillaryChunkCount: number;
  ancillaryBytes: number;
  decodedMetadataBytes: number;
  compressedLength: number;
  compressedChunks: Buffer[];
}

/** Frame one length/type/data/CRC chunk; rejects truncation and CRC mismatches. */
function readPngChunk(bytes: Buffer, offset: number): PngChunk | undefined {
  if (offset + 12 > bytes.length) return undefined;
  const length = bytes.readUInt32BE(offset);
  const typeOffset = offset + 4;
  const dataOffset = typeOffset + 4;
  const dataEnd = dataOffset + length;
  const end = dataEnd + 4;
  if (dataEnd < dataOffset || end > bytes.length || !isPngChunkType(bytes, typeOffset)) return undefined;
  if (pngCrc32(bytes, typeOffset, dataEnd) !== bytes.readUInt32BE(dataEnd)) return undefined;
  return {
    type: bytes.toString("ascii", typeOffset, typeOffset + 4),
    length,
    dataOffset,
    dataEnd,
    end,
    ancillary: (bytes[typeOffset] & 0x20) !== 0,
  };
}

function parsePngHeader(bytes: Buffer, dataOffset: number): PngHeader | undefined {
  const header: PngHeader = {
    width: bytes.readUInt32BE(dataOffset),
    height: bytes.readUInt32BE(dataOffset + 4),
    bitDepth: bytes[dataOffset + 8],
    colorType: bytes[dataOffset + 9],
    interlaceMethod: bytes[dataOffset + 12],
  };
  const compressionMethod = bytes[dataOffset + 10];
  const filterMethod = bytes[dataOffset + 11];
  if (
    !isSafeStaticDimensions(header.width, header.height) ||
    !isValidPngColorMode(header.bitDepth, header.colorType) ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    (header.interlaceMethod !== 0 && header.interlaceMethod !== 1)
  ) {
    return undefined;
  }
  return header;
}

/** Account for one post-IHDR chunk; false rejects the whole image. */
function acceptPngChunk(bytes: Buffer, chunk: PngChunk, state: PngChunkState): boolean {
  if (chunk.ancillary && !countPngAncillaryChunk(state, chunk.length)) return false;
  // APNG control/frame chunks opt into animation even when only one frame
  // is declared, so reject the animation surface unconditionally.
  if (chunk.type === "acTL" || chunk.type === "fcTL" || chunk.type === "fdAT") return false;
  if (state.sawImageData && chunk.type !== "IDAT") state.endedImageData = true;

  switch (chunk.type) {
    // Compressed article text is never rendered and gives attackers a second
    // independent inflate surface, so do not accept it in PNG metadata.
    case "zTXt":
      return false;
    case "iTXt":
      return validateUncompressedPngInternationalText(bytes, chunk.dataOffset, chunk.dataEnd);
    case "tEXt":
      return validatePngText(bytes, chunk.dataOffset, chunk.dataEnd);
    case "iCCP":
      return acceptPngIccProfile(bytes, chunk, state);
    case "PLTE":
      if (
        state.sawPalette ||
        state.sawImageData ||
        chunk.length === 0 ||
        chunk.length > 768 ||
        chunk.length % 3 !== 0
      ) {
        return false;
      }
      state.paletteEntries = chunk.length / 3;
      state.sawPalette = true;
      return true;
    case "IDAT":
      if (state.endedImageData) return false;
      state.sawImageData = true;
      state.compressedChunks.push(bytes.subarray(chunk.dataOffset, chunk.dataEnd));
      state.compressedLength += chunk.length;
      return state.compressedLength <= IMAGE_MAX_BYTES;
    case "IEND":
      return true;
    default:
      // Unknown critical chunks cannot be safely interpreted by this pipeline.
      return chunk.ancillary;
  }
}

function countPngAncillaryChunk(state: PngChunkState, length: number): boolean {
  state.ancillaryChunkCount += 1;
  state.ancillaryBytes += length;
  return (
    state.ancillaryChunkCount <= PNG_MAX_ANCILLARY_CHUNKS &&
    state.ancillaryBytes <= PNG_MAX_ANCILLARY_BYTES &&
    state.ancillaryBytes + state.decodedMetadataBytes <= PNG_MAX_TOTAL_METADATA_BYTES
  );
}

function acceptPngIccProfile(bytes: Buffer, chunk: PngChunk, state: PngChunkState): boolean {
  if (state.sawIccProfile || state.sawPalette || state.sawImageData) return false;
  const profile = inflatePngIccProfile(bytes, chunk.dataOffset, chunk.dataEnd);
  if (!profile) return false;
  state.decodedMetadataBytes += profile.length;
  if (state.ancillaryBytes + state.decodedMetadataBytes > PNG_MAX_TOTAL_METADATA_BYTES) return false;
  state.sawIccProfile = true;
  return true;
}

/** Check palette consistency, then inflate IDAT under the exact expected size and verify filters. */
function validatePngImageData(header: PngHeader, state: PngChunkState): SafeRasterMetadata | undefined {
  const { width, height, bitDepth, colorType, interlaceMethod } = header;
  if (
    state.compressedLength === 0 ||
    (colorType === 3 && (!state.sawPalette || state.paletteEntries > 1 << bitDepth)) ||
    ((colorType === 0 || colorType === 4) && state.sawPalette)
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
  const inflated = inflateSync(Buffer.concat(state.compressedChunks, state.compressedLength), {
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
    if (!isAsciiLetter(bytes[offset + index])) return false;
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
    if (!isAsciiLetter(value) && !(value >= 0x30 && value <= 0x39) && value !== 0x2d) return false;
  }
  return true;
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
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
    let frame: JpegFrame | undefined;
    let sawScan = false;

    for (let segmentCount = 1; offset < bytes.length; segmentCount += 1) {
      if (segmentCount > IMAGE_MAX_CONTAINER_BLOCKS || bytes[offset] !== 0xff) return undefined;
      offset = skipJpegFillBytes(bytes, offset);
      if (offset >= bytes.length) return undefined;
      const marker = bytes[offset++];
      if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        return undefined;
      }
      if (marker === 0xd9) {
        return frame && sawScan && offset === bytes.length ? { width: frame.width, height: frame.height } : undefined;
      }
      if (offset + 2 > bytes.length) return undefined;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
      const segment: JpegSegment = {
        marker,
        length: segmentLength,
        payloadOffset: offset + 2,
        end: offset + segmentLength,
      };

      // DNL/hierarchical JPEG can override the dimensions established by the frame.
      if (marker === 0xdc || marker === 0xde || marker === 0xdf) return undefined;
      if (marker === 0xda) {
        if (!frame) return undefined;
        const scanEnd = findJpegScanEnd(bytes, segment, frame.componentIds);
        if (scanEnd === undefined) return undefined;
        sawScan = true;
        offset = scanEnd;
        continue;
      }
      if (isJpegStartOfFrame(marker)) {
        if (frame) return undefined;
        frame = parseJpegFrame(bytes, segment);
        if (!frame) return undefined;
      }
      offset = segment.end;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface JpegSegment {
  marker: number;
  length: number;
  payloadOffset: number;
  end: number;
}

interface JpegFrame {
  width: number;
  height: number;
  componentIds: ReadonlySet<number>;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Accept only 8-bit baseline, extended-sequential or progressive Huffman frames. */
function parseJpegFrame(bytes: Buffer, segment: JpegSegment): JpegFrame | undefined {
  const { marker, length, payloadOffset } = segment;
  if ((marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) || length < 8) return undefined;
  const precision = bytes[payloadOffset];
  const height = bytes.readUInt16BE(payloadOffset + 1);
  const width = bytes.readUInt16BE(payloadOffset + 3);
  const components = bytes[payloadOffset + 5];
  if (
    precision !== 8 ||
    (components !== 1 && components !== 3 && components !== 4) ||
    length !== 8 + components * 3 ||
    !isSafeStaticDimensions(width, height)
  ) {
    return undefined;
  }
  const componentIds = readDistinctJpegIds(bytes, payloadOffset + 6, components, 3);
  return componentIds && { width, height, componentIds };
}

/** Validate an SOS header and return the offset of the marker that ends its entropy-coded data. */
function findJpegScanEnd(
  bytes: Buffer,
  segment: JpegSegment,
  componentIds: ReadonlySet<number>
): number | undefined {
  const { length, payloadOffset, end } = segment;
  if (length < 8) return undefined;
  const scanComponents = bytes[payloadOffset];
  if (scanComponents < 1 || scanComponents > componentIds.size || length !== 6 + scanComponents * 2) {
    return undefined;
  }
  const selectors = readDistinctJpegIds(bytes, payloadOffset + 1, scanComponents, 2);
  if (!selectors || [...selectors].some((selector) => !componentIds.has(selector))) return undefined;
  const nextMarker = findNextJpegMarker(bytes, end);
  return nextMarker > end ? nextMarker : undefined;
}

/** Read one-byte identifiers spaced `stride` bytes apart, rejecting duplicates. */
function readDistinctJpegIds(bytes: Buffer, start: number, count: number, stride: number): Set<number> | undefined {
  const ids = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const id = bytes[start + index * stride];
    if (ids.has(id)) return undefined;
    ids.add(id);
  }
  return ids;
}

/** Skip the 0xFF fill bytes that may precede a marker code. */
function skipJpegFillBytes(bytes: Buffer, startOffset: number): number {
  let offset = startOffset;
  while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
  return offset;
}

function findNextJpegMarker(bytes: Buffer, startOffset: number): number {
  let offset = startOffset;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerOffset = offset;
    offset = skipJpegFillBytes(bytes, offset);
    if (offset >= bytes.length) return -1;
    const marker = bytes[offset];
    // Stuffed zero bytes and restart markers belong to the entropy-coded data.
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
      !hasWebpSignature(bytes) ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    ) {
      return undefined;
    }

    let offset = 12;
    let chunkCount = 0;
    let canvas: SafeRasterMetadata | undefined;
    let primary: WebpPrimaryImage | undefined;
    let sawAlphaChunk = false;

    while (offset < bytes.length) {
      chunkCount += 1;
      if (chunkCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
      const chunk = readWebpChunk(bytes, offset);
      if (!chunk) return undefined;
      offset = chunk.paddedEnd;

      if (chunk.type === "VP8X") {
        if (canvas || chunkCount !== 1 || chunk.length !== 10) return undefined;
        canvas = parseWebpCanvas(bytes, chunk.dataOffset);
        if (!canvas) return undefined;
      } else if (chunk.type === "ANIM" || chunk.type === "ANMF") {
        return undefined;
      } else if (chunk.type === "ALPH") {
        if (sawAlphaChunk) return undefined;
        sawAlphaChunk = true;
      } else if (chunk.type === "VP8 " || chunk.type === "VP8L") {
        if (primary) return undefined;
        primary = parseWebpPrimaryImage(bytes, chunk.type, chunk, chunkCount);
        if (!primary) return undefined;
      }
    }

    if (offset !== bytes.length || !primary) return undefined;
    if (!canvas) {
      if (chunkCount !== 1 || primary.chunkIndex !== 1 || sawAlphaChunk) return undefined;
      return { width: primary.width, height: primary.height };
    }
    if (
      canvas.width !== primary.width ||
      canvas.height !== primary.height ||
      (sawAlphaChunk && primary.type !== "VP8 ")
    ) {
      return undefined;
    }
    return { width: canvas.width, height: canvas.height };
  } catch {
    return undefined;
  }
}

interface WebpChunk {
  type: string;
  length: number;
  dataOffset: number;
  paddedEnd: number;
}

interface WebpPrimaryImage extends SafeRasterMetadata {
  type: "VP8 " | "VP8L";
  chunkIndex: number;
}

/** Frame one RIFF chunk, including the zero pad byte required after odd-length data. */
function readWebpChunk(bytes: Buffer, offset: number): WebpChunk | undefined {
  if (offset + 8 > bytes.length || !isPrintableFourCc(bytes, offset)) return undefined;
  const length = bytes.readUInt32LE(offset + 4);
  const dataOffset = offset + 8;
  const dataEnd = dataOffset + length;
  const paddedEnd = dataEnd + (length & 1);
  if (dataEnd < dataOffset || paddedEnd > bytes.length) return undefined;
  if ((length & 1) !== 0 && bytes[dataEnd] !== 0) return undefined;
  return { type: bytes.toString("ascii", offset, offset + 4), length, dataOffset, paddedEnd };
}

/** VP8X canvas; reserved bits must be clear and the animation flag (0x02) is not accepted. */
function parseWebpCanvas(bytes: Buffer, dataOffset: number): SafeRasterMetadata | undefined {
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
  const width = readUInt24LE(bytes, dataOffset + 4) + 1;
  const height = readUInt24LE(bytes, dataOffset + 7) + 1;
  return isSafeStaticDimensions(width, height) ? { width, height } : undefined;
}

function parseWebpPrimaryImage(
  bytes: Buffer,
  type: WebpPrimaryImage["type"],
  chunk: WebpChunk,
  chunkIndex: number
): WebpPrimaryImage | undefined {
  const dimensions =
    type === "VP8 "
      ? parseLossyWebpDimensions(bytes, chunk.dataOffset, chunk.length)
      : parseLosslessWebpDimensions(bytes, chunk.dataOffset, chunk.length);
  if (!dimensions || !isSafeStaticDimensions(dimensions.width, dimensions.height)) return undefined;
  return { ...dimensions, type, chunkIndex };
}

function parseLossyWebpDimensions(
  bytes: Buffer,
  offset: number,
  length: number
): SafeRasterMetadata | undefined {
  if (length < 10) return undefined;
  const frameTag = readUInt24LE(bytes, offset);
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

/** Graphics-control values waiting for the next image descriptor. */
interface GifGraphicsControl {
  delayMs: number;
  transparentIndex?: number;
}

interface GifParseState {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly globalColorCount: number;
  offset: number;
  blockCount: number;
  frames: GifFrameRecord[];
  totalFramePixels: number;
  durationMs: number;
  pendingControl?: GifGraphicsControl;
  loopCount?: number;
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
    const state = readGifHeader(bytes);
    if (!state) return undefined;

    while (state.offset < bytes.length) {
      state.blockCount += 1;
      if (state.blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
      const marker = bytes[state.offset++];
      if (marker === 0x3b) {
        // Reject both a dangling graphics-control extension and appended data.
        if (state.pendingControl || state.offset !== bytes.length) return undefined;
        return finishGif(state);
      }
      const accepted = marker === 0x21 ? readGifExtension(state) : marker === 0x2c && readGifImage(state);
      if (!accepted) return undefined;
    }
    return undefined;
  } catch {
    // Every reader bounds-checks first, so parser exceptions should be rare;
    // malformed binary input is still an ordinary rejected image, never a hard error.
    return undefined;
  }
}

/** Header and logical screen descriptor, then the optional global color table. */
function readGifHeader(bytes: Buffer): GifParseState | undefined {
  if (bytes.length < 14 || bytes.length > IMAGE_MAX_BYTES || !hasGifSignature(bytes)) return undefined;
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

  const globalColorCount = gifColorTableSize(bytes[10]);
  // The background color index must point into the global table.
  if (globalColorCount > 0 && bytes[11] >= globalColorCount) return undefined;
  const offset = skipGifBytes(bytes, 13, globalColorCount * 3);
  if (offset < 0) return undefined;
  return {
    bytes,
    width,
    height,
    globalColorCount,
    offset,
    blockCount: 0,
    frames: [],
    totalFramePixels: 0,
    durationMs: 0,
  };
}

/** Entries in the color table announced by a packed field; 0 when the table is absent. */
function gifColorTableSize(packed: number): number {
  return (packed & 0x80) !== 0 ? 1 << ((packed & 0x07) + 1) : 0;
}

function readGifExtension(state: GifParseState): boolean {
  if (state.offset >= state.bytes.length) return false;
  const label = state.bytes[state.offset++];
  if (label === 0xf9) return readGifGraphicsControl(state);
  if (label === 0xff) return readGifApplicationExtension(state);
  if (label === 0xfe) return consumeGifSubBlocks(state) !== undefined;
  // Plain-text and unknown extensions expand the decoder surface without
  // helping article media, so reject them rather than interpreting them.
  return false;
}

function readGifGraphicsControl(state: GifParseState): boolean {
  const { bytes, offset } = state;
  if (state.pendingControl || offset + 6 > bytes.length) return false;
  if (bytes[offset] !== 4 || bytes[offset + 5] !== 0) return false;
  const packed = bytes[offset + 1];
  const disposalMethod = (packed >> 2) & 0x07;
  // Reserved bits, user-input waiting, and reserved disposal modes are
  // intentionally unsupported because they create ambiguous playback.
  if ((packed & 0xe0) !== 0 || (packed & 0x02) !== 0 || disposalMethod > 3) return false;
  state.pendingControl = {
    delayMs: bytes.readUInt16LE(offset + 2) * 10,
    transparentIndex: (packed & 0x01) !== 0 ? bytes[offset + 4] : undefined,
  };
  state.offset = offset + 6;
  return true;
}

/**
 * Application extension: exactly 11 bytes of identifier/auth data, followed
 * by ordinary data sub-blocks (e.g. NETSCAPE loop metadata).
 */
function readGifApplicationExtension(state: GifParseState): boolean {
  const { bytes, offset } = state;
  if (offset >= bytes.length || bytes[offset] !== 11) return false;
  const applicationId = bytes.subarray(offset + 1, offset + 12).toString("ascii");
  const dataOffset = skipGifBytes(bytes, offset + 1, 11);
  if (dataOffset < 0) return false;
  state.offset = dataOffset;
  const extension = consumeGifSubBlocks(state);
  if (!extension) return false;
  if (applicationId !== "NETSCAPE2.0" && applicationId !== "ANIMEXTS1.0") return true;

  if (state.frames.length > 0 || state.loopCount !== undefined) return false;
  const [loopBlock] = extension.chunks;
  if (extension.chunks.length !== 1 || loopBlock.length !== 3 || loopBlock[0] !== 1) return false;
  state.loopCount = loopBlock.readUInt16LE(1);
  // A zero loop count means unbounded playback in both extensions.
  return state.loopCount !== 0;
}

/** Image descriptor, optional local color table and LZW data, charged against the animation budgets. */
function readGifImage(state: GifParseState): boolean {
  const { bytes, width, height } = state;
  if (state.offset + 9 > bytes.length) return false;
  const left = bytes.readUInt16LE(state.offset);
  const top = bytes.readUInt16LE(state.offset + 2);
  const frameWidth = bytes.readUInt16LE(state.offset + 4);
  const frameHeight = bytes.readUInt16LE(state.offset + 6);
  const imagePacked = bytes[state.offset + 8];
  if (
    frameWidth === 0 ||
    frameHeight === 0 ||
    left + frameWidth > width ||
    top + frameHeight > height ||
    (imagePacked & 0x18) !== 0
  ) {
    return false;
  }

  const localColorCount = gifColorTableSize(imagePacked);
  const dataOffset = skipGifBytes(bytes, state.offset + 9, localColorCount * 3);
  if (dataOffset < 0) return false;
  const colorCount = localColorCount || state.globalColorCount;
  if (colorCount === 0) return false;
  const transparentIndex = state.pendingControl?.transparentIndex;
  if (transparentIndex !== undefined && transparentIndex >= colorCount) return false;

  if (dataOffset >= bytes.length) return false;
  const minimumCodeSize = bytes[dataOffset];
  if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
  state.offset = dataOffset + 1;
  const imageData = consumeGifSubBlocks(state);
  if (!imageData || imageData.byteLength === 0) return false;

  state.totalFramePixels += frameWidth * frameHeight;
  const nextFrameCount = state.frames.length + 1;
  if (nextFrameCount > GIF_MAX_FRAMES || width * height * nextFrameCount > GIF_MAX_COMPOSITED_PIXELS) return false;
  state.durationMs += Math.max(state.pendingControl?.delayMs ?? 0, GIF_MIN_FRAME_DURATION_MS);
  if (state.durationMs > GIF_MAX_DURATION_MS) return false;

  state.frames.push({
    width: frameWidth,
    height: frameHeight,
    colorCount,
    minimumCodeSize,
    compressed: Buffer.concat(imageData.chunks, imageData.byteLength),
  });
  state.pendingControl = undefined;
  return true;
}

/** After the trailer: check every frame's LZW stream, then the whole-playback budgets. */
function finishGif(state: GifParseState): SafeGifMetadata | undefined {
  const { width, height, frames, durationMs, loopCount } = state;
  if (frames.length === 0) return undefined;
  const framesDecode = frames.every((frame) =>
    validateGifLzw(frame.compressed, frame.minimumCodeSize, frame.width * frame.height, frame.colorCount)
  );
  if (!framesDecode) return undefined;

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

  return { width, height, frameCount: frames.length, totalFramePixels: state.totalFramePixels, durationMs };
}

function skipGifBytes(bytes: Buffer, offset: number, count: number): number {
  return offset >= 0 && count >= 0 && offset + count <= bytes.length ? offset + count : -1;
}

/** Read a sub-block chain at the cursor and charge its blocks to the container budget. */
function consumeGifSubBlocks(state: GifParseState): GifSubBlocks | undefined {
  const blocks = readGifSubBlocks(state.bytes, state.offset);
  if (!blocks) return undefined;
  state.blockCount += blocks.blockCount;
  if (state.blockCount > IMAGE_MAX_CONTAINER_BLOCKS) return undefined;
  state.offset = blocks.nextOffset;
  return blocks;
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

/** LZW dictionary that tracks only each code's expansion length and first palette index. */
interface GifLzwTable {
  expansionLength: Uint32Array;
  firstColor: Uint16Array;
  nextCode: number;
  codeSize: number;
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
  const table = createGifLzwTable(minimumCodeSize);
  let previousCode = -1;
  let decodedPixels = 0;
  let bitOffset = 0;
  let codeCount = 0;
  let sawClear = false;

  while (bitOffset + table.codeSize <= data.length * 8) {
    codeCount += 1;
    if (codeCount > GIF_MAX_LZW_CODES) return false;
    const code = readGifCode(data, bitOffset, table.codeSize);
    if (code === undefined) return false;
    bitOffset += table.codeSize;

    if (code === clearCode) {
      resetGifLzwTable(table, minimumCodeSize);
      previousCode = -1;
      sawClear = true;
      continue;
    }
    if (!sawClear) return false;
    if (code === endCode) return decodedPixels === expectedPixels && hasOnlyGifZeroPadding(data, bitOffset);

    if (previousCode < 0) {
      if (code >= clearCode || code >= colorCount) return false;
      decodedPixels += 1;
    } else {
      const currentLength = gifLzwExpansionLength(table, code, previousCode, colorCount);
      if (currentLength === undefined) return false;
      decodedPixels += currentLength;
      if (decodedPixels > expectedPixels) return false;
      if (!addGifLzwEntry(table, previousCode, expectedPixels)) return false;
    }
    previousCode = code;
  }
  return false;
}

function createGifLzwTable(minimumCodeSize: number): GifLzwTable {
  const table: GifLzwTable = {
    expansionLength: new Uint32Array(4_096),
    firstColor: new Uint16Array(4_096),
    nextCode: 0,
    codeSize: 0,
  };
  for (let code = 0; code < 1 << minimumCodeSize; code += 1) {
    table.expansionLength[code] = 1;
    table.firstColor[code] = code;
  }
  resetGifLzwTable(table, minimumCodeSize);
  return table;
}

function resetGifLzwTable(table: GifLzwTable, minimumCodeSize: number): void {
  table.codeSize = minimumCodeSize + 1;
  // The first free code follows the clear and end codes.
  table.nextCode = (1 << minimumCodeSize) + 2;
}

/** Expansion length of `code`, including the KwKwK case where it is the entry being defined. */
function gifLzwExpansionLength(
  table: GifLzwTable,
  code: number,
  previousCode: number,
  colorCount: number
): number | undefined {
  if (code < table.nextCode && table.expansionLength[code] > 0) {
    return table.firstColor[code] < colorCount ? table.expansionLength[code] : undefined;
  }
  if (code === table.nextCode && table.expansionLength[previousCode] > 0) {
    return table.expansionLength[previousCode] + 1;
  }
  return undefined;
}

function addGifLzwEntry(table: GifLzwTable, previousCode: number, expectedPixels: number): boolean {
  if (table.nextCode >= 4_096) return true;
  const previousLength = table.expansionLength[previousCode];
  if (previousLength === 0 || previousLength >= expectedPixels) return false;
  table.expansionLength[table.nextCode] = previousLength + 1;
  table.firstColor[table.nextCode] = table.firstColor[previousCode];
  table.nextCode += 1;
  if (table.nextCode === 1 << table.codeSize && table.codeSize < 12) table.codeSize += 1;
  return true;
}

function hasOnlyGifZeroPadding(data: Buffer, bitOffset: number): boolean {
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
  return [...new Set(ordered)].slice(0, SOURCE_IMAGE_MAX_CANDIDATES);
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
    // Invalid JSON yields undefined, which the walk below ignores.
    collectJsonLdTreeImageCandidates(tryParseJson(source), candidates);
  }
  return candidates;
}

/** Breadth-first walk of one JSON-LD document, bounded in node count and depth. */
function collectJsonLdTreeImageCandidates(root: unknown, candidates: SourceImageCandidateHint[]): void {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < SOURCE_IMAGE_JSON_LD_MAX_NODES) {
    const entry = queue.shift();
    if (!entry || entry.depth > SOURCE_IMAGE_JSON_LD_MAX_DEPTH) continue;
    visited += 1;

    const { value } = entry;
    let children: unknown[];
    if (Array.isArray(value)) {
      children = value.slice(0, SOURCE_IMAGE_MAX_CANDIDATES);
    } else if (isRecord(value)) {
      const typeNames = jsonLdTypeNames(value["@type"]);
      if (typeNames.some(isJsonLdArticleType)) {
        collectJsonLdImageValue(value.image, candidates, "JSON-LD Article.image");
        collectJsonLdImageValue(value.thumbnailUrl, candidates, "JSON-LD Article.thumbnailUrl");
      }
      if (typeNames.includes("imageobject")) collectJsonLdImageObject(value, candidates, "JSON-LD ImageObject");
      // Only nested objects and arrays can hold further typed nodes.
      children = Object.values(value)
        .slice(0, SOURCE_IMAGE_MAX_CANDIDATES)
        .filter((child) => child !== null && typeof child === "object");
    } else {
      continue;
    }

    for (const child of children) {
      if (queue.length >= SOURCE_IMAGE_JSON_LD_MAX_NODES) break;
      queue.push({ value: child, depth: entry.depth + 1 });
    }
  }
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
    for (const rawUrl of Array.isArray(value) ? value : [value]) {
      if (typeof rawUrl !== "string") continue;
      pushSourceImageHint(candidates, { rawUrl, width, height, context: descriptiveContext });
    }
  }
}

/** Context hints of the currently open containers, innermost last. */
interface ArticleContainerHints {
  article: Array<string | undefined>;
  figure: Array<string | undefined>;
  /** `undefined` marks an open div without strong article-body signals. */
  div: Array<string | undefined>;
}

function collectArticleImageCandidates(html: string): SourceImageCandidateHint[] {
  const figureCandidates: SourceImageCandidateHint[] = [];
  const articleCandidates: SourceImageCandidateHint[] = [];
  const searchableHtml = html.replace(
    /<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)\s*>/gi,
    ""
  );
  const tokenPattern = /<\s*(\/?)\s*(article|figure|main|div)\b([^>]{0,8192})>|<\s*img\b([^>]{0,8192})>/gi;
  const hints: ArticleContainerHints = { article: [], figure: [], div: [] };
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(searchableHtml)) !== null) {
    const containerName = match[2]?.toLowerCase();
    if (containerName) {
      trackArticleContainer(hints, containerName, match);
      continue;
    }
    const activeDivHints = hints.div.filter((hint): hint is string => hint !== undefined);
    if (hints.figure.length === 0 && hints.article.length === 0 && activeDivHints.length === 0) {
      continue;
    }

    const attributes = parseHtmlAttributes(match[4] || "");
    const context = [
      ...hints.article.slice(-2),
      ...activeDivHints.slice(-2),
      ...hints.figure.slice(-2),
      imageContextFromAttributes(attributes),
    ].filter(Boolean).join(" ");
    const target = hints.figure.length > 0 ? figureCandidates : articleCandidates;
    collectImageElementCandidates(attributes, context, target);
  }
  return [...figureCandidates, ...articleCandidates];
}

/** Push or pop one container tag; a self-closing tag is pushed and popped at once. */
function trackArticleContainer(hints: ArticleContainerHints, containerName: string, tag: RegExpExecArray): void {
  const stack = containerName === "div" ? hints.div : containerName === "figure" ? hints.figure : hints.article;
  if (tag[1]) {
    stack.pop();
    return;
  }
  const attributes = parseHtmlAttributes(tag[3] || "");
  const carriesContext = containerName !== "div" || isLikelyArticleContentContainer(attributes);
  stack.push(carriesContext ? imageContextFromAttributes(attributes) : undefined);
  if (/\/\s*>$/.test(tag[0])) stack.pop();
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
  const push = (rawUrl: string, sourceWidth?: number) =>
    pushSourceImageHint(candidates, { rawUrl, width: sourceWidth ?? width, height, context });

  for (const attributeName of ["data-srcset", "data-lazy-srcset"] as const) {
    for (const source of parseSrcset(attributes[attributeName])) push(source.rawUrl, source.width);
  }
  for (const attributeName of ["data-src", "data-original", "data-original-src", "data-lazy-src"] as const) {
    if (attributes[attributeName]) push(attributes[attributeName]);
  }
  for (const source of parseSrcset(attributes.srcset)) push(source.rawUrl, source.width);
  if (attributes.src) push(attributes.src);
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
  if (hasPngSignature(bytes)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (hasGifSignature(bytes)) return "image/gif";
  if (hasWebpSignature(bytes)) return "image/webp";
  return undefined;
}

function hasPngSignature(bytes: Buffer): boolean {
  return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function hasGifSignature(bytes: Buffer): boolean {
  const signature = bytes.toString("ascii", 0, 6);
  return signature === "GIF87a" || signature === "GIF89a";
}

function hasWebpSignature(bytes: Buffer): boolean {
  return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
