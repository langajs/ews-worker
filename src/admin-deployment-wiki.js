import {
  DISTRIBUTED_N8N_INSTALLER_FILENAME,
  getDistributedN8nInstallerScript,
} from './distributed-n8n-installer.js';

const CREDENTIALS = Object.freeze([
  { name: 'GRSAI API Key', usage: '双平台主图、附图、详情图和 SKU 图主模型' },
  { name: 'DeepSeek API Key', usage: '双平台商品元数据工作流' },
  { name: '备用图片 API Key', usage: 'Shopee 图片备用模型' },
  { name: 'EWS callback_secret', usage: '本机图片服务、上传票据和 Worker 回调鉴权' },
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
    title: '生成安装脚本',
    body: '填写页面中的节点信息、n8n 管理员账号和三组模型密钥，下载 CMD 后直接双击执行。回调密钥由管理员配置自动注入。',
    bullets: ['宿主机只需要安装 Docker Desktop，安装器会自动启动并等待 Docker Engine', '自动部署 Valkey、图片 API、图片 Worker 和持久化队列', '自动初始化 owner、导入三组凭证并发布 9 个工作流', '本机图片栈健康后才继续部署 n8n'],
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
    title: '绑定用户工作流',
    body: '进入系统配置 -> 用户管理 -> 工作流地址，将目标用户需要的 webhook 切换到新域名。未填写的字段继续继承系统默认节点。',
    bullets: ['先切换一个测试用户', '商品元数据、主图、附图和 SKU 图可以分别分流', '确认回调与 R2 图片正常后再迁移其他用户'],
  },
  {
    id: 'validation',
    number: '04',
    title: '验收与清理',
    body: '访问节点域名确认 n8n 可用，再创建最小 Shopee 与聚水潭任务验证回调。成功后删除下载的安装脚本。',
    bullets: ['安装脚本包含经过 Base64 编码的模型密钥、回调密钥和 owner 密码', '模型密钥最终只保存在 n8n 加密凭证库', 'n8n 状态位于 %LOCALAPPDATA%\\EWS\\n8n-nodes，图片服务构建源位于 %LOCALAPPDATA%\\EWS\\image-service'],
  },
]);

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getDistributedN8nWiki() {
  const installer = getDistributedN8nInstallerScript();
  return {
    version: '2026.07.28',
    title: 'n8n 一键部署',
    subtitle: 'Docker Desktop + 一份可双击运行的 CMD，闭环部署图片队列与 n8n，Cloudflare Tunnel 独立连接',
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
      concurrency: 20,
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
