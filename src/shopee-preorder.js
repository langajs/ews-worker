const PREORDER_CHANNEL_IDS = new Set(['5001', '50039', '50052']);
const PREORDER_CHANNEL_LABELS = new Set([
  'nhanh',
  'tu nhan hang - spx',
  'tu nhan hang - viettel smartbox',
]);

function normalizeChannelLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .toLocaleLowerCase('vi')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function channelId(channel) {
  if (typeof channel !== 'object' || channel === null) return String(channel || '').trim();
  const direct = String(channel.id || '').trim();
  if (direct) return direct;
  return String(channel.semantic_key || '').match(/^channel_id\.(\d+)$/)?.[1] || '';
}

export function isShopeePreOrderShippingChannel(channel) {
  const label = normalizeChannelLabel(channel?.label);
  if (label) return PREORDER_CHANNEL_LABELS.has(label);
  return PREORDER_CHANNEL_IDS.has(channelId(channel));
}

export function annotateShopeeShippingChannels(channels) {
  return (Array.isArray(channels) ? channels : []).map(channel => ({
    ...channel,
    supports_preorder: isShopeePreOrderShippingChannel(channel),
  }));
}
