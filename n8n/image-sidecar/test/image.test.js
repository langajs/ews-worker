import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { encodeJpeg } from '../src/image.js';
import { parsePublicSourceUrl, secretsEqual, validateImageJob } from '../src/security.js';

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
});
