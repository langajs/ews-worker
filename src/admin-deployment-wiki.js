import {
  DISTRIBUTED_N8N_INSTALLER_FILENAME,
  getDistributedN8nInstallerScript,
} from './distributed-n8n-installer.js';

const CREDENTIALS = Object.freeze([
  { name: 'GrsaiApp', usage: '双平台主图、附图、详情图和 SKU 图主模型' },
  { name: 'deepseek', usage: '双平台商品元数据工作流' },
  { name: 'EWS Backup Image API', usage: 'Shopee 图片备用模型' },
]);

const WEBHOOKS = Object.freeze([
  { platform: 'Shopee', name: '商品元数据', path: '/webhook/vn/v3t1', config_key: 'n8n_title_webhook' },
  { platform: 'Shopee', name: '主图', path: '/webhook/vn/v3m1', config_key: 'n8n_main_webhook' },
  { platform: 'Shopee', name: '附图', path: '/webhook/vn/v3m2', config_key: 'n8n_sub_image_webhook' },
  { platform: 'Shopee', name: 'SKU 图', path: '/webhook/vn/v3s1', config_key: 'n8n_sku_image_webhook' },
  { platform: '聚水潭', name: '商品元数据', path: '/webhook/jst/v3-metadata', config_key: 'n8n_title_webhook' },
  { platform: '聚水潭', name: '主图', path: '/webhook/cn/v3m1', config_key: 'n8n_main_webhook' },
  { platform: '聚水潭', name: '附图', path: '/webhook/cn/v3m2', config_key: 'n8n_sub_image_webhook' },
  { platform: '聚水潭', name: '详情图', path: '/webhook/cn/v3d1', config_key: 'n8n_detail_webhook' },
  { platform: '聚水潭', name: 'SKU 图', path: '/webhook/cn/v3s1', config_key: 'n8n_sku_image_webhook' },
]);

const REFERENCES = Object.freeze([
  { name: 'Cloudflare Tunnel 设置', url: 'https://developers.cloudflare.com/tunnel/setup/' },
  { name: 'Cloudflare Tunnel token', url: 'https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/' },
  { name: 'n8n Docker 部署', url: 'https://docs.n8n.io/hosting/installation/docker/' },
]);

const SECTIONS = Object.freeze([
  {
    id: 'installer',
    number: '01',
    title: '部署节点环境',
    body: '填写节点信息与 n8n 管理员账号，下载 CMD 后直接双击执行。脚本只部署 Docker、n8n、Valkey 和图片服务环境；使用同一节点名称重跑会覆盖运行配置，但保留工作流、凭证和数据卷。',
    bullets: ['宿主机只需要 Windows 10/11，Docker Desktop 缺失时自动下载并安装', '始终拉取最新 n8n 与 Valkey 镜像，并重建图片服务', '生产工作流默认不限制并发，只有在 Wiki 显式填写正整数时才限制', '本机图片 Worker 默认并发为 8，高性能设备最大建议 32', '自动部署 Valkey、图片 API、图片 Worker 和持久化队列', '不会导入工作流或创建模型凭证'],
  },
  {
    id: 'cloudflare',
    number: '02',
    title: '连接 Cloudflare',
    body: 'n8n 部署成功后，再运行页面生成的 cloudflared Docker 命令。Cloudflare Public Hostname 的 Service 固定填写 http://n8n:5678。',
    bullets: ['Tunnel token 与安装脚本分离', 'cloudflared 和 n8n 加入同一个 Docker network', '不需要公网 IP、端口转发或额外反向代理'],
  },
  {
    id: 'routing',
    number: '03',
    title: '人工迁移工作流',
    body: '登录新 n8n，人工导入 9 个 workflow JSON，创建模型凭证并绑定到对应节点，检查配置后再逐个发布。',
    bullets: ['创建 GrsaiApp、deepseek 和 EWS Backup Image API 凭证', '使用外部图片服务时人工修改工作流中的图片服务地址', '安装器不会覆盖已有工作流和凭证'],
  },
  {
    id: 'validation',
    number: '04',
    title: '绑定与验收',
    body: '工作流发布后，先为一个测试用户切换 webhook 地址并验证回调；确认正常后再迁移其他用户，最后删除安装脚本。',
    bullets: ['安装脚本仅包含回调密钥和 owner 密码', '模型密钥由管理员直接保存到 n8n 加密凭证库', 'n8n 状态位于 %LOCALAPPDATA%\\EWS\\n8n-nodes，图片服务构建源位于 %LOCALAPPDATA%\\EWS\\image-service'],
  },
]);

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getDistributedN8nWiki() {
  const installer = getDistributedN8nInstallerScript();
  return {
    version: '2026.08.10',
    title: 'n8n 节点环境一键部署',
    subtitle: '一份可双击运行的 CMD，只部署 Docker、图片队列与 n8n 环境；工作流 JSON 和模型凭证由管理员人工迁移',
    script: {
      filename: DISTRIBUTED_N8N_INSTALLER_FILENAME,
      download_url: '/api/admin/wiki/distributed-n8n/script',
      sha256: await sha256(installer),
    },
    defaults: {
      domain: 'n8n-node2.example.com',
      node_name: 'node2',
      port: 5679,
      image_service_url: 'http://ews-image-sidecar:3000',
      image_service_version: '2026.07.28',
      n8n_version: '2.25.7',
      concurrency: -1,
      image_worker_concurrency: 8,
    },
    credentials: CREDENTIALS,
    references: REFERENCES,
    webhooks: WEBHOOKS,
    sections: SECTIONS,
  };
}

export {
  DISTRIBUTED_N8N_INSTALLER_FILENAME,
  getDistributedN8nInstallerScript,
};
