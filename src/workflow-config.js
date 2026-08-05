const WORKFLOW_PLATFORMS = ['jst', 'shopee'];
const WORKFLOW_SWITCH_KEYS = new Set([
  'n8n_title_enabled',
  'n8n_sku_image_enabled',
]);
const WORKFLOW_KEYS = {
  jst: new Set([
    ...WORKFLOW_SWITCH_KEYS,
    'n8n_title_webhook',
    'n8n_main_webhook',
    'n8n_sub_image_webhook',
    'n8n_detail_webhook',
    'n8n_sku_image_webhook',
  ]),
  shopee: new Set([
    ...WORKFLOW_SWITCH_KEYS,
    'n8n_title_webhook',
    'n8n_main_webhook',
    'n8n_sub_image_webhook',
    'n8n_sku_image_webhook',
  ]),
};

function parseWorkflowConfig(rawConfig) {
  if (!rawConfig) return {};
  if (typeof rawConfig === 'object' && !Array.isArray(rawConfig)) return rawConfig;
  try {
    const parsed = JSON.parse(rawConfig);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeWorkflowConfig(rawConfig) {
  const sourceConfig = parseWorkflowConfig(rawConfig);
  const normalized = {};
  for (const platform of WORKFLOW_PLATFORMS) {
    const source = sourceConfig[platform];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const target = {};
    for (const [key, value] of Object.entries(source)) {
      if (!WORKFLOW_KEYS[platform].has(key)) continue;
      if (WORKFLOW_SWITCH_KEYS.has(key)) {
        if (typeof value === 'boolean') target[key] = value;
        else if (value === 'true' || value === 'false') target[key] = value === 'true';
      } else if (typeof value === 'string' && value.trim()) {
        target[key] = value.trim();
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        target[key] = value;
      }
    }
    normalized[platform] = target;
  }
  return normalized;
}

function applyWorkflowOverrides(config, rawConfig, platform) {
  const platformConfig = normalizeWorkflowConfig(rawConfig)[platform];
  if (!platformConfig) return config;
  for (const [key, value] of Object.entries(platformConfig)) config[key] = value;
  return config;
}

function resolveWorkflowConfig(globalConfig, groupConfig, userConfig, platform) {
  const resolved = { ...globalConfig };
  applyWorkflowOverrides(resolved, groupConfig, platform);
  applyWorkflowOverrides(resolved, userConfig, platform);
  return resolved;
}

export {
  applyWorkflowOverrides,
  normalizeWorkflowConfig,
  resolveWorkflowConfig,
};
