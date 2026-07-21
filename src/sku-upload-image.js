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

let codecsReady;

function initializeCodecs() {
  if (!codecsReady) {
    codecsReady = Promise.all([
      initJpegDecode(JPEG_DECODE_WASM),
      initJpegEncode(JPEG_ENCODE_WASM),
      initPngDecode(PNG_DECODE_WASM),
      initResize(RESIZE_WASM),
    ]);
  }
  return codecsReady;
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
  const pixels = Number(image?.width) * Number(image?.height);
  if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > MAX_DECODED_PIXELS) {
    throw new Error('SKU图片像素过大，最大支持1200万像素');
  }
}

async function encodeAtQuality(image) {
  return encodeJpeg(image, { quality: JPEG_QUALITY, chroma_quality: JPEG_QUALITY });
}

export async function processSkuUploadImage(buffer, contentType) {
  if (!['image/jpeg', 'image/png'].includes(contentType)) {
    throw new Error('SKU成品图仅支持 JPG 或 PNG');
  }

  await initializeCodecs();
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
    quality: JPEG_QUALITY,
  };
}

export const SKU_UPLOAD_LIMITS = Object.freeze({
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxDecodedPixels: MAX_DECODED_PIXELS,
  quality: JPEG_QUALITY,
});
