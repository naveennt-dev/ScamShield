/**
 * Server-side image validation. The client's MIME type and file name are NOT trusted: the real
 * type is sniffed from magic bytes, the extension must agree with it, and dimensions are parsed
 * from the header to reject decompression bombs before any decoder touches the pixels.
 */

export type ImageKind = "png" | "jpeg" | "webp";

export const ALLOWED_EXTENSIONS: Record<ImageKind, string[]> = {
  png: ["png"],
  jpeg: ["jpg", "jpeg"],
  webp: ["webp"],
};

export const IMAGE_LIMITS = {
  minSide: 16,
  maxSide: 10_000,
  maxPixels: 40_000_000,
};

export interface ImageInfo {
  kind: ImageKind;
  width: number;
  height: number;
  mime: string;
}

export class ImageValidationError extends Error {
  constructor(
    readonly reason:
      | "empty"
      | "unsupported_type"
      | "extension_mismatch"
      | "unreadable_dimensions"
      | "dimensions_too_small"
      | "dimensions_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export function sniffImageKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

function pngDims(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || String.fromCharCode(...b.slice(12, 16)) !== "IHDR") return null;
  return [u32be(b, 16), u32be(b, 20)];
}

function jpegDims(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [u16be(b, i + 7), u16be(b, i + 5)];
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpDims(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === "VP8 ") return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return null;
}

export function validateImage(bytes: Uint8Array, filename: string | null): ImageInfo {
  if (bytes.length === 0) throw new ImageValidationError("empty", "The file is empty.");
  const kind = sniffImageKind(bytes);
  if (!kind) throw new ImageValidationError("unsupported_type", "Only PNG, JPEG and WebP images are supported.");

  if (filename) {
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    if (filename.includes(".") && !ALLOWED_EXTENSIONS[kind].includes(ext)) {
      throw new ImageValidationError("extension_mismatch", "The file extension does not match its contents.");
    }
  }

  const dims = kind === "png" ? pngDims(bytes) : kind === "jpeg" ? jpegDims(bytes) : webpDims(bytes);
  if (!dims || !dims[0] || !dims[1]) throw new ImageValidationError("unreadable_dimensions", "Could not read the image dimensions.");
  const [width, height] = dims;
  if (width < IMAGE_LIMITS.minSide || height < IMAGE_LIMITS.minSide) {
    throw new ImageValidationError("dimensions_too_small", "The image is too small to read.");
  }
  if (width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide || width * height > IMAGE_LIMITS.maxPixels) {
    throw new ImageValidationError("dimensions_too_large", "The image dimensions are too large.");
  }
  return { kind, width, height, mime: kind === "jpeg" ? "image/jpeg" : `image/${kind}` };
}
