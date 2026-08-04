import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { encodeJpeg } from '../src/image.js';
import { assertPublicResolution, parsePublicSourceUrl, secretsEqual, validateImageJob } from '../src/security.js';

const config = {
  jpegQuality: 88,
  maxOutputBytes: 100000,
  sourceHostAllowlist: [],
  serviceSecret: 'test-secret',
  ticketOrigin: 'https://ewsz.langaj.cc',
};

test('PNG 转为 JPEG 并保持宽高比例', async () => {
  const pixels = Buffer.alloc(800 * 500 * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = index % 251;
  const input = await sharp(pixels, { raw: { width: 800, height: 500, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const output = await encodeJpeg(input, config);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.ok(output.length <= config.maxOutputBytes);
  assert.ok(Math.abs(metadata.width / metadata.height - 1.6) < 0.01);
});

test('图片任务执行恒定时间密钥校验和字段标准化', () => {
  assert.equal(secretsEqual('test-secret', 'test-secret'), true);
  assert.equal(secretsEqual('wrong', 'test-secret'), false);
  const body = validateImageJob({
    source_url: 'https://oss.langaj.cc/ews/task/image.jpg',
    ticket_url: 'https://ewsz.langaj.cc/api/internal/r2-upload-ticket',
    callback_secret: 'test-secret',
    task_id: 'task',
    plan_id: 'plan',
    sub_task_id: 'subtask',
    set_index: 0,
    image_type: 'main',
    image_position: 1,
  }, config);
  assert.equal(body.image_position, 1);
  assert.equal(body.set_index, 0);
});

test('拒绝内网图片源', () => {
  assert.throws(() => parsePublicSourceUrl('http://127.0.0.1/image.png', config), /不允许访问内网/);
  assert.throws(() => parsePublicSourceUrl('http://192.168.1.2/image.png', config), /不允许访问内网/);
  assert.throws(() => parsePublicSourceUrl('http://[::1]/image.png', config), /不允许访问内网/);
  assert.throws(() => parsePublicSourceUrl('http://198.18.1.30/image.png', { ...config, allowBenchmarkDns: true }), /不允许访问内网/);
  assert.throws(() => parsePublicSourceUrl('http://[fdfe:dcba:9876::168]/image.png', { ...config, allowBenchmarkDns: true }), /不允许访问内网/);
});

test('代理DNS网段必须显式启用', () => {
  assert.equal(loadConfig({ IMAGE_SERVICE_SECRET: 'secret' }).allowBenchmarkDns, false);
  assert.equal(loadConfig({ IMAGE_SERVICE_SECRET: 'secret', ALLOW_BENCHMARK_DNS: 'true' }).allowBenchmarkDns, true);
});

test('代理DNS兼容fake IPv4和IPv6，但不放行真实内网', async () => {
  const proxyConfig = { ...config, allowBenchmarkDns: true };
  await assert.rejects(() => assertPublicResolution(new URL('https://example.com/image.png'), config,
    async () => [{ address: 'fdfe:dcba:9876::168', family: 6 }]), /fdfe:dcba:9876::168/);
  await assert.doesNotReject(() => assertPublicResolution(new URL('https://example.com/image.png'), proxyConfig,
    async () => [
      { address: '198.18.1.105', family: 4 },
      { address: 'fdfe:dcba:9876::168', family: 6 },
    ]));
  await assert.doesNotReject(() => assertPublicResolution(new URL('https://example.com/image.png'), proxyConfig,
    async () => [{ address: '::ffff:198.18.1.30', family: 6 }]));
  await assert.rejects(() => assertPublicResolution(new URL('https://example.com/image.png'), proxyConfig,
    async () => [{ address: '192.168.1.30', family: 4 }]), /192\.168\.1\.30/);
  await assert.rejects(() => assertPublicResolution(new URL('https://example.com/image.png'), proxyConfig,
    async () => [{ address: 'fd00::1', family: 6 }]), /fd00::1/);
});
