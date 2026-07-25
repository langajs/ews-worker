import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annotateShopeeShippingChannels,
  isShopeePreOrderShippingChannel,
} from '../src/shopee-preorder.js';

test('recognizes the three official Shopee pre-order channels', () => {
  assert.equal(isShopeePreOrderShippingChannel({ id: '5001', label: 'Nhanh' }), true);
  assert.equal(isShopeePreOrderShippingChannel({ id: '50052', label: 'Tủ nhận hàng - SPX' }), true);
  assert.equal(isShopeePreOrderShippingChannel({ semantic_key: 'channel_id.50039', label: 'Tủ nhận hàng - Viettel Smartbox' }), true);
});

test('rejects channels outside the pre-order allowlist', () => {
  assert.equal(isShopeePreOrderShippingChannel({ id: '5012', label: 'Trong Ngày' }), false);
  assert.equal(isShopeePreOrderShippingChannel({ id: '5000', label: 'Hỏa Tốc' }), false);
  assert.equal(isShopeePreOrderShippingChannel({ id: '50053', label: 'Điểm nhận hàng' }), false);
  assert.equal(isShopeePreOrderShippingChannel({ id: '50052', label: 'Trong Ngày' }), false);
});

test('normalizes Vietnamese labels and replaces stale manifest flags', () => {
  assert.equal(isShopeePreOrderShippingChannel({ label: 'Tủ nhận hàng-SPX' }), true);
  assert.deepEqual(annotateShopeeShippingChannels([
    { id: '5004', label: 'Hàng Cồng Kềnh', supports_preorder: true },
    { id: '5001', label: 'Nhanh', supports_preorder: false },
  ]).map(channel => channel.supports_preorder), [false, true]);
});

test('uses channel ids only as a legacy fallback when labels are missing', () => {
  assert.equal(isShopeePreOrderShippingChannel('50052'), true);
  assert.equal(isShopeePreOrderShippingChannel({ semantic_key: 'channel_id.50039' }), true);
  assert.equal(isShopeePreOrderShippingChannel({ id: '5012' }), false);
  assert.equal(isShopeePreOrderShippingChannel({ id: '7777', label: 'Tủ nhận hàng - SPX' }), true);
});
