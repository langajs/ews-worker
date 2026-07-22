import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode';
import decodePng, { init as initPngDecode } from '@jsquash/png/decode';
import resize, { initResize } from '@jsquash/resize';
import JPEG_DECODE_WASM from '../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import JPEG_ENCODE_WASM from '../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import PNG_DECODE_WASM from '../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import RESIZE_WASM from '../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';

const JPEG_QUALITY = 88;
const MAX_OUTPUT_BYTES = 2_000_000;
const RESIZE_TARGET_BYTES = 1_800_000;
const MAX_DECODED_PIXELS = 12_000_000;

let jpegDecoderReady;
let jpegEncoderReady;
let pngDecoderReady;
let resizeReady;

function ensureJpegDecoder() {
  if (!jpegDecoderReady) jpegDecoderReady = initJpegDecode(JPEG_DECODE_WASM);
  return jpegDecoderReady;
}

function ensureJpegEncoder() {
  if (!jpegEncoderReady) jpegEncoderReady = initJpegEncode(JPEG_ENCODE_WASM);
  return jpegEncoderReady;
}

function ensurePngDecoder() {
  if (!pngDecoderReady) pngDecoderReady = initPngDecode(PNG_DECODE_WASM);
  return pngDecoderReady;
}

function ensureResize() {
  if (!resizeReady) resizeReady = initResize(RESIZE_WASM);
  return resizeReady;
}

function readPngDimensions(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function inspectImageDimensions(buffer, contentType) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return contentType === 'image/png' ? readPngDimensions(bytes) : readJpegDimensions(bytes);
}

function validateImageDimensions(width, height) {
  const pixels = Number(width) * Number(height);
  if (!Number.isSafeInteger(pixels) || pixels < 1) throw new Error('无法读取 SKU 图片尺寸，请重新导出图片后上传');
  if (pixels > MAX_DECODED_PIXELS) throw new Error('SKU图片像素过大，最大支持1200万像素');
}

function flattenTransparency(image) {
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha === 255) continue;
    const inverse = 255 - alpha;
    pixels[i] = Math.round((pixels[i] * alpha + 255 * inverse) / 255);
    pixels[i + 1] = Math.round((pixels[i + 1] * alpha + 255 * inverse) / 255);
    pixels[i + 2] = Math.round((pixels[i + 2] * alpha + 255 * inverse) / 255);
    pixels[i + 3] = 255;
  }
  return image;
}

function validateDecodedImage(image) {
  validateImageDimensions(image?.width, image?.height);
}

async function encodeAtQuality(image) {
  await ensureJpegEncoder();
  return encodeJpeg(image, { quality: JPEG_QUALITY, chroma_quality: JPEG_QUALITY });
}

export async function processSkuUploadImage(buffer, contentType) {
  if (!['image/jpeg', 'image/png'].includes(contentType)) {
    throw new Error('SKU成品图仅支持 JPG 或 PNG');
  }

  const dimensions = inspectImageDimensions(buffer, contentType);
  if (!dimensions) throw new Error('无法读取 SKU 图片尺寸，请重新导出图片后上传');
  validateImageDimensions(dimensions.width, dimensions.height);

  if (contentType === 'image/jpeg' && buffer.byteLength <= MAX_OUTPUT_BYTES) {
    return {
      buffer,
      contentType: 'image/jpeg',
      extension: 'jpg',
      width: dimensions.width,
      height: dimensions.height,
      resized: false,
      reencoded: false,
      quality: null,
    };
  }

  if (contentType === 'image/png') await ensurePngDecoder();
  else await ensureJpegDecoder();
  const decoded = contentType === 'image/png'
    ? await decodePng(buffer)
    : await decodeJpeg(buffer, { preserveOrientation: true });
  validateDecodedImage(decoded);
  flattenTransparency(decoded);

  let output = await encodeAtQuality(decoded);
  let resized = false;
  let width = decoded.width;
  let height = decoded.height;
  if (output.byteLength > MAX_OUTPUT_BYTES) {
    await ensureResize();
    const scale = Math.min(0.98, Math.sqrt(RESIZE_TARGET_BYTES / output.byteLength));
    width = Math.max(1, Math.floor(decoded.width * scale));
    height = Math.max(1, Math.floor(decoded.height * scale));
    const smaller = await resize(decoded, {
      width,
      height,
      method: 'triangle',
      fitMethod: 'stretch',
      premultiply: true,
      linearRGB: true,
    });
    output = await encodeAtQuality(smaller);
    resized = true;
  }

  if (output.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error('SKU图片等比压缩后仍超过2MB，请上传尺寸更小的图片');
  }

  return {
    buffer: output,
    contentType: 'image/jpeg',
    extension: 'jpg',
    width,
    height,
    resized,
    reencoded: true,
    quality: JPEG_QUALITY,
  };
}

export const SKU_UPLOAD_LIMITS = Object.freeze({
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxDecodedPixels: MAX_DECODED_PIXELS,
  quality: JPEG_QUALITY,
});
