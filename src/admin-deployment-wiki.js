import DISTRIBUTED_N8N_SCRIPT from '../n8n/deploy/deploy-extra-node.ps1';

const CREDENTIALS = Object.freeze([
  { id: 'Ua1TBIbDcAu3z8pU', name: 'GrsaiApp', type: 'HTTP Header Auth', usage: '双平台主图、附图、详情图和 SKU 图主模型' },
  { id: '11xE3AjgQ1iUHDdR', name: 'deepseek', type: 'HTTP Header Auth', usage: '双平台商品元数据工作流' },
  { id: 'bkpImgApi20260722', name: 'EWS Backup Image API', type: 'HTTP Header Auth', usage: 'Shopee 图片备用模型' },
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

const SECTIONS = Object.freeze([
  {
    id: 'architecture', number: '01', title: '节点边界与资源准备',
    intro: '每个分布式节点都是独立 n8n 实例，拥有独立 SQLite 数据卷和加密密钥。EWS Worker 根据任务所属用户的 webhook_config 选择节点，不共享 n8n 数据库。',
    steps: [
      {
        title: '准备服务器',
        body: '建议从 2 vCPU、4 GB RAM、20 GB 可用磁盘开始。只向反向代理开放 n8n 端口，公网入口统一使用 HTTPS 域名。',
        bullets: ['Docker Engine 与 Docker Compose v2 可用', 'Linux 安装 PowerShell 7；Windows 可使用 PowerShell 5.1 或 7', '仓库已拉取到部署主机，n8n 工作流 JSON 位于 ews-worker/n8n', 'DNS A/AAAA 记录已指向部署主机'],
        commands: [
          { label: '环境检查', language: 'powershell', template: 'docker version\ndocker compose version\npwsh --version' },
        ],
      },
      {
        title: '规划隔离参数',
        body: 'NodeName 决定容器名、Compose project 和数据卷名；同一主机上的节点必须使用不同 NodeName 与端口。脚本默认将生产执行并发限制为 20。',
        bullets: ['容器名：ews-n8n-{{NODE_NAME}}', '数据卷：ews_n8n_{{NODE_NAME}}_data', '本机端口：{{PORT}} -> 容器 5678', '公开地址：https://{{DOMAIN}}/'],
      },
    ],
  },
  {
    id: 'credentials', number: '02', title: '迁移工作流凭证',
    intro: '工作流按 Credential ID 引用三组 HTTP Header Auth。推荐从现有节点逐项解密导出，再由部署脚本导入新节点，以保留 ID 并避免逐节点重新绑定。',
    steps: [
      {
        title: '从现有 n8n 导出三组凭证',
        body: '以下文件包含明文密钥，只能通过受控主机和加密通道中转。不要提交到 Git、聊天工具或公共对象存储。',
        commands: [
          { label: '创建中转目录', language: 'bash', template: "docker exec n8n mkdir -p /tmp/ews-credentials" },
          { label: '按 ID 解密导出', language: 'bash', template: "docker exec n8n n8n export:credentials --id=Ua1TBIbDcAu3z8pU --decrypted --output=/tmp/ews-credentials/grsai.json\ndocker exec n8n n8n export:credentials --id=11xE3AjgQ1iUHDdR --decrypted --output=/tmp/ews-credentials/deepseek.json\ndocker exec n8n n8n export:credentials --id=bkpImgApi20260722 --decrypted --output=/tmp/ews-credentials/backup-image.json\ndocker cp n8n:/tmp/ews-credentials ./ews-credentials\ndocker exec n8n node -e \"require('fs').rmSync('/tmp/ews-credentials',{recursive:true,force:true})\"" },
        ],
      },
      {
        title: '安全转移与销毁',
        body: '将 ews-credentials 目录通过 SCP/SFTP 传到新节点。部署脚本导入后会清除容器内中转副本，但宿主机目录需要管理员在验证完成后自行安全删除。',
        bullets: ['传输前核对目录内只有三份 JSON', '限制目录只允许当前部署账号读取', '完成第 06 节验证后删除源端与目标端明文目录'],
      },
    ],
  },
  {
    id: 'proxy', number: '03', title: '配置域名与反向代理',
    intro: 'PublicUrl 必须使用独立域名根路径。反向代理需要保留 Host 与 Forwarded headers，并将读取超时设置为至少 900 秒。',
    steps: [
      {
        title: 'Nginx 站点配置',
        body: '证书可以由现有 ACME 流程签发。n8n 仅监听本机 {{PORT}} 端口时，不需要对公网开放该端口。',
        commands: [
          { label: 'Nginx location', language: 'nginx', template: 'server {\n  listen 443 ssl;\n  server_name {{DOMAIN}};\n\n  location / {\n    proxy_pass http://127.0.0.1:{{PORT}};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n    proxy_read_timeout 900s;\n    proxy_send_timeout 900s;\n  }\n}' },
          { label: '检查并重载 Nginx', language: 'bash', template: 'sudo nginx -t\nsudo systemctl reload nginx' },
        ],
      },
    ],
  },
  {
    id: 'deploy', number: '04', title: '部署并初始化节点',
    intro: '先启动空节点并完成 owner 初始化，再导入凭证与 9 个工作流。脚本可重复执行，相同 NodeName 会复用原数据卷和 N8N_ENCRYPTION_KEY。',
    steps: [
      {
        title: '下载管理员脚本',
        body: '使用本页的“下载部署脚本”按钮获取经过管理员鉴权的最新版本。将脚本放到 ews-worker/n8n/deploy 目录，或通过 -WorkflowDirectory 显式指定工作流目录。',
      },
      {
        title: '首次启动',
        body: '节点健康后访问 https://{{DOMAIN}}，创建该节点的 n8n owner 账号。owner 密码不能与 EWS 管理员密码复用。',
        commands: [
          { label: 'Windows', language: 'powershell', template: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\n8n\\deploy\\deploy-extra-node.ps1 -NodeName {{NODE_NAME}} -Port {{PORT}} -PublicUrl https://{{DOMAIN}} -WorkflowDirectory .\\n8n' },
          { label: 'Linux', language: 'bash', template: 'pwsh ./n8n/deploy/deploy-extra-node.ps1 -NodeName {{NODE_NAME}} -Port {{PORT}} -PublicUrl https://{{DOMAIN}} -WorkflowDirectory ./n8n' },
        ],
      },
      {
        title: '导入凭证与工作流',
        body: 'owner 初始化完成后再次执行脚本。它会保留 Credential ID、兼容数组格式工作流文件、导入 9 个工作流、逐个发布并重启 n8n。',
        commands: [
          { label: 'Windows 完整导入', language: 'powershell', template: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\n8n\\deploy\\deploy-extra-node.ps1 -NodeName {{NODE_NAME}} -Port {{PORT}} -PublicUrl https://{{DOMAIN}} -WorkflowDirectory .\\n8n -CredentialsDirectory .\\ews-credentials -ImportWorkflows' },
          { label: 'Linux 完整导入', language: 'bash', template: 'pwsh ./n8n/deploy/deploy-extra-node.ps1 -NodeName {{NODE_NAME}} -Port {{PORT}} -PublicUrl https://{{DOMAIN}} -WorkflowDirectory ./n8n -CredentialsDirectory ./ews-credentials -ImportWorkflows' },
        ],
      },
    ],
  },
  {
    id: 'routing', number: '05', title: '绑定 EWS 用户分流',
    intro: '进入 EWS 系统配置的用户管理，为目标用户填写新节点 webhook。留空字段继续继承系统全局地址，因此可以按平台或工作流类型渐进迁移。',
    steps: [
      {
        title: '填写用户 Webhook',
        body: '先绑定一个测试用户。Shopee 与聚水潭各字段必须对应同平台路径，不能把测试 webhook URL 或 n8n 编辑器 URL 填入 EWS。',
        bullets: ['地址格式固定为 https://{{DOMAIN}}/webhook/...', '商品元数据、主图、附图和 SKU 图可以分别指向不同节点', '保存后只影响该用户之后释放的计划；已经生成的 push plan 保留创建时地址'],
      },
    ],
  },
  {
    id: 'validation', number: '06', title: '验收与切流',
    intro: '先验证基础设施，再分别执行 Shopee 与聚水潭测试任务。不要在只确认 healthz 后直接迁移全部用户。',
    steps: [
      {
        title: '节点与工作流检查',
        body: '日志应显示 9 个 published workflows，并且容器健康状态为 healthy。Python runner 缺失提示不影响当前 JavaScript 工作流。',
        commands: [
          { label: '健康与状态', language: 'bash', template: 'curl -fsS http://127.0.0.1:{{PORT}}/healthz\ndocker inspect ews-n8n-{{NODE_NAME}} --format "{{json .State.Health.Status}}"\ndocker logs --tail 120 ews-n8n-{{NODE_NAME}}' },
        ],
      },
      {
        title: 'EWS 闭环测试',
        body: '用绑定到新节点的测试用户各创建一个最小 Shopee 与聚水潭任务，确认计划进入 processing、回调完成、R2 图片可预览且最终可以导出。',
        bullets: ['先测试商品元数据，再测试主图、附图和 SKU 图', '检查 callback_secret 校验没有 401/403', '检查新节点没有 excessive system load 或长时间 pending', '通过后再分批迁移生产用户'],
      },
    ],
  },
  {
    id: 'operations', number: '07', title: '日常运维与回退',
    intro: '节点执行记录保留 168 小时且最多 10000 条。升级使用新的镜像版本重新执行同一脚本，避免直接使用漂移的 latest。',
    steps: [
      {
        title: '升级与回退顺序',
        body: '升级前先将用户 webhook 恢复为系统默认或其他健康节点，等待活动执行结束，再更新镜像。故障回退只修改用户 webhook，不需要改任务数据。',
        bullets: ['记录当前镜像版本和节点 NodeName', '先迁出用户，再处理容器', '保留数据卷和 .env 中的 N8N_ENCRYPTION_KEY', '禁止在没有备份时删除 ews_n8n_{{NODE_NAME}}_data'],
        commands: [
          { label: '只停止故障节点', language: 'bash', template: 'docker stop ews-n8n-{{NODE_NAME}}' },
          { label: '恢复节点', language: 'bash', template: 'docker start ews-n8n-{{NODE_NAME}}\ndocker logs --tail 100 ews-n8n-{{NODE_NAME}}' },
        ],
      },
    ],
  },
]);

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getDistributedN8nWiki() {
  return {
    version: '2026.07.25',
    title: 'n8n 分布式节点部署',
    subtitle: '独立节点、凭证迁移、用户级 Webhook 分流与闭环验收',
    script: {
      filename: 'deploy-extra-node.ps1',
      download_url: '/api/admin/wiki/distributed-n8n/script',
      sha256: await sha256(DISTRIBUTED_N8N_SCRIPT),
    },
    defaults: { domain: 'n8n-node2.example.com', node_name: 'node2', port: 5679, n8n_version: '2.25.7', concurrency: 20 },
    credentials: CREDENTIALS,
    webhooks: WEBHOOKS,
    sections: SECTIONS,
  };
}

export { DISTRIBUTED_N8N_SCRIPT };

