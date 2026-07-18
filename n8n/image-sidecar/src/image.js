import sharp from 'sharp';
import { ProcessingError } from './errors.js';
import { assertPublicResolution, parsePublicSourceUrl } from './security.js';

export async function downloadImage(sourceUrl, config) {
  let url = parsePublicSourceUrl(sourceUrl, config);
  let response;
  for (let redirect = 0; redirect <= 3; redirect++) {
    await assertPublicResolution(url);
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(config.downloadTimeoutMs) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirect === 3) throw new ProcessingError('图片下载重定向无效', false);
    url = parsePublicSourceUrl(new URL(location, url).href, config);
  }
  if (!response.ok) {
    const retryable = [403, 404, 408, 425, 429].includes(response.status) || response.status >= 500;
    throw new ProcessingError(`图片下载失败: HTTP ${response.status}`, retryable);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.startsWith('image/')) throw new ProcessingError('图片源返回了非图片内容', false);
  const declaredSize = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (declaredSize > config.maxSourceBytes) throw new ProcessingError('源图片超过大小限制', false);
  if (!response.body) throw new ProcessingError('图片服务没有返回响应体', true);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > config.maxSourceBytes) throw new ProcessingError('源图片超过大小限制', false);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jpegPipeline(input, config, width, height) {
  let pipeline = sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .flatten({ background: '#ffffff' });
  if (width && height) {
    pipeline = pipeline.resize({ width, height, fit: 'inside', kernel: sharp.kernel.linear, withoutEnlargement: true });
  }
  return pipeline.jpeg({ quality: config.jpegQuality, chromaSubsampling: '4:2:0' }).toBuffer();
}

export async function encodeJpeg(input, config) {
  let output;
  try { output = await jpegPipeline(input, config); }
  catch (_) { throw new ProcessingError('无法解码图片', false); }
  const metadata = await sharp(output).metadata();
  if (!metadata.width || !metadata.height) throw new ProcessingError('无法识别图片尺寸', false);
  let width = metadata.width;
  let height = metadata.height;
  for (let attempt = 0; output.length > config.maxOutputBytes && attempt < 4; attempt++) {
    const scale = Math.min(0.95, Math.sqrt(config.maxOutputBytes / output.length) * 0.97);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    output = await jpegPipeline(input, config, width, height);
  }
  if (output.length > config.maxOutputBytes) throw new ProcessingError('图片压缩后仍超过大小限制', false);
  return output;
}
