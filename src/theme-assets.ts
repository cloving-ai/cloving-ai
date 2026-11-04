import { svgCodes } from "./theme-svg.ts";

export const assetByteLimit = 524_288;

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const riff = [0x52, 0x49, 0x46, 0x46];
const webp = [0x57, 0x45, 0x42, 0x50];
const otherEncoding = /^\s*<\?xml[^>]*\bencoding\s*=\s*["'](?!utf-8["'])/i;

function begins(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function isWebp(bytes: Uint8Array): boolean {
  return begins(bytes, riff) && begins(bytes.subarray(8), webp);
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function svgFileCodes(bytes: Uint8Array): readonly string[] {
  const text = utf8(bytes);
  if (text === undefined || text.includes("\u0000") || otherEncoding.test(text))
    return ["invalid-asset-type"];
  return svgCodes(text);
}

export function assetSizeCodes(size: number): readonly string[] {
  return size > assetByteLimit ? ["asset-too-large"] : [];
}

export function assetCodes(asset: {
  readonly path: string;
  readonly bytes: Uint8Array;
}): readonly string[] {
  const { path, bytes } = asset;
  const sized = assetSizeCodes(bytes.length);
  if (sized.length > 0) return sized;
  if (path.endsWith(".svg")) return svgFileCodes(bytes);
  const valid = path.endsWith(".png")
    ? begins(bytes, pngSignature)
    : path.endsWith(".webp") && isWebp(bytes);
  return valid ? [] : ["invalid-asset-type"];
}
