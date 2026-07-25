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

const DEPLOYMENT_MODES = Object.freeze([
  {
    id: 'local-tunnel',
    label: '本地主机 · Cloudflare Tunnel',
    short_label: '本地主机',
    default_port: 5679,
    summary: '适合家用电脑、办公室主机、NAS 或没有公网入站能力的节点。n8n 只监听本机端口，cloudflared 作为 Docker sidecar 主动连到 Cloudflare。',
  },
  {
    id: 'cloud-dns',
    label: '云服务器 · Cloudflare DNS',
    short_label: '云服务器',
    default_port: 443,
    summary: '适合有固定公网 IP 的 VPS/云服务器。Cloudflare DNS 代理到源站 443，n8n 直接使用 Cloudflare Origin CA 证书提供 HTTPS。',
  },
]);

const REFERENCES = Object.freeze([
  { name: 'Cloudflare Tunnel connector', url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/' },
  { name: 'Cloudflare proxied DNS ports', url: 'https://developers.cloudflare.com/fundamentals/reference/network-ports/' },
  { name: 'Cloudflare Origin CA', url: 'https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/' },
  { name: 'n8n environment variables', url: 'https://docs.n8n.io/hosting/configuration/environment-variables/' },
]);

const SECTIONS = Object.freeze([
  {
    id: 'architecture', number: '01', title: '分布式架构边界',
    intro: 'EWS Worker 不直接跑 AI 工作流，只负责任务状态、队列、R2 资源和用户级 webhook 路由；每个 n8n 节点独立运行，通过用户配置承接一部分工作流流量。',
    steps: [
      {
        title: '系统如何分流',
        body: '管理员在系统配置中给用户绑定 webhook 地址。任务释放时，Worker 根据任务创建者的配置选择目标 n8n 节点；未配置的字段继续走全局默认地址。',
        bullets: ['节点之间不共享 n8n SQLite 数据库', '每个节点保留独立 N8N_ENCRYPTION_KEY 和凭证', '同一个用户可以按商品元数据、主图、附图、SKU 图分别分配节点', '已经生成的 push plan 保留创建时 webhook，不会被后续配置修改影响'],
      },
      {
        title: '选择部署路径',
        body: '本地主机走 Cloudflare Tunnel；云服务器走 Cloudflare DNS 代理。两条路径都保持 EWS 外部地址为 HTTPS，Worker 回调地址和 callback_secret 机制不变。',
        bullets: ['本地主机：无需公网 IP、无需开放入站端口，Cloudflare Tunnel 连接器主动出站', '云服务器：使用 Cloudflare DNS 橙云代理，源站直接监听 443', '不再要求 Nginx/Caddy/Traefik 作为额外反向代理层'],
        commands: [
          { mode: 'all', label: '部署前环境检查', language: 'shell', template: 'docker version\ndocker info' },
        ],
      },
    ],
  },
  {
    id: 'cloudflare-entry', number: '02', title: 'Cloudflare 入口配置',
    intro: '入口只做连通与 TLS，不承载业务逻辑。域名必须是独立子域名根路径，例如 https://{{DOMAIN}}/，不要挂在已有站点子路径下。',
    steps: [
      {
        mode: 'local-tunnel',
        title: '本地主机：创建 Tunnel 连接器',
        body: '在 Cloudflare Zero Trust 创建 Tunnel，选择 Docker connector，并为同一个 Tunnel 添加 Public Hostname。Docker 命令会启动 cloudflared sidecar，连接器 token 只写入该节点本地 tunnel.env。',
        bullets: ['Public Hostname：{{DOMAIN}}', 'Service Type：HTTP', 'Service URL：n8n:5678', 'Cloudflare 外部访问为 HTTPS，容器网络内部访问 n8n 为 HTTP', '复制 Add a replica 中的 connector token，填入本页上方 Tunnel Token'],
        commands: [
          { mode: 'local-tunnel', label: 'cloudflared 镜像检查', language: 'bash', template: 'docker run --rm cloudflare/cloudflared:latest tunnel --no-autoupdate --version' },
        ],
      },
      {
        mode: 'cloud-dns',
        title: '云服务器：配置 DNS 与 Origin CA',
        body: '在 Cloudflare DNS 添加 A/AAAA 记录并开启橙云代理。SSL/TLS 模式设置为 Full (strict)，然后为 {{DOMAIN}} 签发 Origin CA 证书，保存到部署主机。',
        bullets: ['DNS：{{DOMAIN}} -> 云服务器公网 IP，Proxy status 为 Proxied', 'SSL/TLS：Full (strict)', 'Origin Certificate 覆盖 {{DOMAIN}}，保存 certificate 和 private key', '防火墙至少开放 TCP 443；可进一步只允许 Cloudflare IP 段访问'],
        commands: [
          { mode: 'cloud-dns', label: 'Linux 证书目录', language: 'bash', template: 'sudo mkdir -p /opt/ews/certs/{{NODE_NAME}}\nsudo chmod 700 /opt/ews/certs/{{NODE_NAME}}\n# 将 Cloudflare Origin Certificate 保存为 /opt/ews/certs/{{NODE_NAME}}/origin.pem\n# 将 Private Key 保存为 /opt/ews/certs/{{NODE_NAME}}/origin.key\nsudo chmod 600 /opt/ews/certs/{{NODE_NAME}}/origin.*' },
          { mode: 'cloud-dns', label: 'Windows 证书目录', language: 'powershell', template: 'New-Item -ItemType Directory -Force C:\\EWS\\certs\\{{NODE_NAME}}\n# 将 Cloudflare Origin Certificate 保存为 C:\\EWS\\certs\\{{NODE_NAME}}\\origin.pem\n# 将 Private Key 保存为 C:\\EWS\\certs\\{{NODE_NAME}}\\origin.key' },
        ],
      },
    ],
  },
  {
    id: 'deploy', number: '03', title: '部署 n8n 节点',
    intro: '标准流程只依赖 Docker Engine 或 Docker Desktop。先持久化节点密钥并启动容器，完成 n8n owner 初始化后，再通过 docker cp 和 docker exec 导入凭证与 9 个工作流。',
    steps: [
      {
        title: '准备仓库与持久化配置',
        body: '以下命令从 ews-worker 仓库根目录执行，要求当前目录存在 n8n 文件夹。每个节点把 N8N_ENCRYPTION_KEY 独立保存在宿主机状态目录，重新创建容器时继续复用。',
        bullets: ['Linux 使用 ~/.config/ews/n8n-nodes/{{NODE_NAME}}', 'Windows 使用 %LOCALAPPDATA%\\EWS\\n8n-nodes\\{{NODE_NAME}}', '禁止删除 encryption.key；丢失后已有凭证无法解密', '页面顶部的下载按钮仅提供可选 PowerShell 辅助脚本，不是标准部署依赖'],
        commands: [
          { mode: 'all', label: 'Linux：生成并持久化节点配置', language: 'bash', template: 'NODE_NAME="{{NODE_NAME}}"\nSTATE_DIR="$HOME/.config/ews/n8n-nodes/$NODE_NAME"\nmkdir -p "$STATE_DIR"\nchmod 700 "$STATE_DIR"\nif [ ! -s "$STATE_DIR/encryption.key" ]; then docker run --rm --entrypoint node n8nio/n8n:stable -e "process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\'))" > "$STATE_DIR/encryption.key"; fi\nchmod 600 "$STATE_DIR/encryption.key"\nKEY="$(cat "$STATE_DIR/encryption.key")"\ncat > "$STATE_DIR/n8n.env" <<EOF\nN8N_HOST={{DOMAIN}}\nN8N_PORT=5678\nN8N_PROTOCOL=https\nN8N_EDITOR_BASE_URL=https://{{DOMAIN}}/\nWEBHOOK_URL=https://{{DOMAIN}}/\nN8N_PROXY_HOPS=1\nN8N_ENCRYPTION_KEY=$KEY\nGENERIC_TIMEZONE=Asia/Shanghai\nTZ=Asia/Shanghai\nNODE_ENV=production\nDB_SQLITE_POOL_SIZE=2\nN8N_CONCURRENCY_PRODUCTION_LIMIT=20\nEXECUTIONS_DATA_PRUNE=true\nEXECUTIONS_DATA_MAX_AGE=168\nEXECUTIONS_DATA_PRUNE_MAX_COUNT=10000\nN8N_DIAGNOSTICS_ENABLED=false\nN8N_PERSONALIZATION_ENABLED=false\nN8N_VERSION_NOTIFICATIONS_ENABLED=false\nN8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true\nEOF\nchmod 600 "$STATE_DIR/n8n.env"' },
          { mode: 'all', label: 'Windows：生成并持久化节点配置', language: 'powershell', template: '$NodeName = "{{NODE_NAME}}"\n$StateDir = Join-Path $env:LOCALAPPDATA "EWS\\n8n-nodes\\$NodeName"\nNew-Item -ItemType Directory -Force $StateDir | Out-Null\n$KeyFile = Join-Path $StateDir "encryption.key"\nif (!(Test-Path $KeyFile) -or !(Get-Content $KeyFile -Raw).Trim()) {\n  $GeneratedKey = docker run --rm --entrypoint node n8nio/n8n:stable -e "process.stdout.write(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n  if ($LASTEXITCODE -ne 0 -or !$GeneratedKey) { throw "无法生成节点加密密钥" }\n  [IO.File]::WriteAllText($KeyFile, $GeneratedKey.Trim())\n}\n$Key = (Get-Content $KeyFile -Raw).Trim()\n$Lines = @(\n  "N8N_HOST={{DOMAIN}}", "N8N_PORT=5678", "N8N_PROTOCOL=https",\n  "N8N_EDITOR_BASE_URL=https://{{DOMAIN}}/", "WEBHOOK_URL=https://{{DOMAIN}}/",\n  "N8N_PROXY_HOPS=1", "N8N_ENCRYPTION_KEY=$Key", "GENERIC_TIMEZONE=Asia/Shanghai",\n  "TZ=Asia/Shanghai", "NODE_ENV=production", "DB_SQLITE_POOL_SIZE=2",\n  "N8N_CONCURRENCY_PRODUCTION_LIMIT=20", "EXECUTIONS_DATA_PRUNE=true",\n  "EXECUTIONS_DATA_MAX_AGE=168", "EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000",\n  "N8N_DIAGNOSTICS_ENABLED=false", "N8N_PERSONALIZATION_ENABLED=false",\n  "N8N_VERSION_NOTIFICATIONS_ENABLED=false", "N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true"\n)\n[IO.File]::WriteAllLines((Join-Path $StateDir "n8n.env"), $Lines, (New-Object Text.UTF8Encoding($false)))' },
        ],
      },
      {
        mode: 'local-tunnel',
        title: '本地主机：Docker 启动',
        body: 'Tunnel 模式将 n8n 绑定到 127.0.0.1:{{PORT}}，公网入口只能经过 cloudflared。命令会重建同名容器，但保留节点数据卷与 encryption.key。启动后访问 https://{{DOMAIN}} 初始化 n8n owner。',
        commands: [
          { mode: 'local-tunnel', label: 'Linux：启动 n8n 与 cloudflared', language: 'bash', template: 'NODE_NAME="{{NODE_NAME}}"\nSTATE_DIR="$HOME/.config/ews/n8n-nodes/$NODE_NAME"\nprintf "TUNNEL_TOKEN=%s\\n" "{{TUNNEL_TOKEN}}" > "$STATE_DIR/tunnel.env"\nchmod 600 "$STATE_DIR/tunnel.env"\ndocker network inspect "ews-$NODE_NAME" >/dev/null 2>&1 || docker network create "ews-$NODE_NAME"\ndocker volume inspect "ews_n8n_${NODE_NAME}_data" >/dev/null 2>&1 || docker volume create "ews_n8n_${NODE_NAME}_data"\ndocker rm -f "ews-cloudflared-$NODE_NAME" "ews-n8n-$NODE_NAME" >/dev/null 2>&1 || true\ndocker run -d --name "ews-n8n-$NODE_NAME" --restart unless-stopped --network "ews-$NODE_NAME" --network-alias n8n -p "127.0.0.1:{{PORT}}:5678" --env-file "$STATE_DIR/n8n.env" -v "ews_n8n_${NODE_NAME}_data:/home/node/.n8n" -v "$PWD/n8n:/workflows:ro" n8nio/n8n:stable\ndocker run -d --name "ews-cloudflared-$NODE_NAME" --restart unless-stopped --network "ews-$NODE_NAME" --env-file "$STATE_DIR/tunnel.env" cloudflare/cloudflared:latest tunnel --no-autoupdate run' },
          { mode: 'local-tunnel', label: 'Windows：启动 n8n 与 cloudflared', language: 'powershell', template: '$NodeName = "{{NODE_NAME}}"\n$StateDir = Join-Path $env:LOCALAPPDATA "EWS\\n8n-nodes\\$NodeName"\n[IO.File]::WriteAllText((Join-Path $StateDir "tunnel.env"), "TUNNEL_TOKEN={{TUNNEL_TOKEN}}`n", (New-Object Text.UTF8Encoding($false)))\ndocker network inspect "ews-$NodeName" *> $null\nif ($LASTEXITCODE -ne 0) { docker network create "ews-$NodeName" | Out-Null }\ndocker volume inspect "ews_n8n_$($NodeName)_data" *> $null\nif ($LASTEXITCODE -ne 0) { docker volume create "ews_n8n_$($NodeName)_data" | Out-Null }\ndocker rm -f "ews-cloudflared-$NodeName" "ews-n8n-$NodeName" 2>$null | Out-Null\ndocker run -d --name "ews-n8n-$NodeName" --restart unless-stopped --network "ews-$NodeName" --network-alias n8n -p "127.0.0.1:{{PORT}}:5678" --env-file (Join-Path $StateDir "n8n.env") -v "ews_n8n_$($NodeName)_data:/home/node/.n8n" -v "$PWD/n8n:/workflows:ro" n8nio/n8n:stable\ndocker run -d --name "ews-cloudflared-$NodeName" --restart unless-stopped --network "ews-$NodeName" --env-file (Join-Path $StateDir "tunnel.env") cloudflare/cloudflared:latest tunnel --no-autoupdate run' },
        ],
      },
      {
        mode: 'cloud-dns',
        title: '云服务器：Docker 启动',
        body: 'DNS 模式要求公开端口与域名端口一致，默认使用 443。n8n 直接挂载 Cloudflare Origin CA 证书提供源站 HTTPS，不增加 Nginx、Caddy 或 Traefik。',
        commands: [
          { mode: 'cloud-dns', label: 'Linux：启动 HTTPS n8n', language: 'bash', template: 'NODE_NAME="{{NODE_NAME}}"\nSTATE_DIR="$HOME/.config/ews/n8n-nodes/$NODE_NAME"\ndocker network inspect "ews-$NODE_NAME" >/dev/null 2>&1 || docker network create "ews-$NODE_NAME"\ndocker volume inspect "ews_n8n_${NODE_NAME}_data" >/dev/null 2>&1 || docker volume create "ews_n8n_${NODE_NAME}_data"\ndocker rm -f "ews-n8n-$NODE_NAME" >/dev/null 2>&1 || true\ndocker run -d --name "ews-n8n-$NODE_NAME" --restart unless-stopped --network "ews-$NODE_NAME" -p "{{PORT}}:5678" --env-file "$STATE_DIR/n8n.env" -e N8N_SSL_CERT=/certs/origin.pem -e N8N_SSL_KEY=/certs/origin.key -v "ews_n8n_${NODE_NAME}_data:/home/node/.n8n" -v "$PWD/n8n:/workflows:ro" -v "/opt/ews/certs/$NODE_NAME/origin.pem:/certs/origin.pem:ro" -v "/opt/ews/certs/$NODE_NAME/origin.key:/certs/origin.key:ro" n8nio/n8n:stable' },
          { mode: 'cloud-dns', label: 'Windows：启动 HTTPS n8n', language: 'powershell', template: '$NodeName = "{{NODE_NAME}}"\n$StateDir = Join-Path $env:LOCALAPPDATA "EWS\\n8n-nodes\\$NodeName"\n$CertDir = "C:\\EWS\\certs\\$NodeName"\ndocker network inspect "ews-$NodeName" *> $null\nif ($LASTEXITCODE -ne 0) { docker network create "ews-$NodeName" | Out-Null }\ndocker volume inspect "ews_n8n_$($NodeName)_data" *> $null\nif ($LASTEXITCODE -ne 0) { docker volume create "ews_n8n_$($NodeName)_data" | Out-Null }\ndocker rm -f "ews-n8n-$NodeName" 2>$null | Out-Null\ndocker run -d --name "ews-n8n-$NodeName" --restart unless-stopped --network "ews-$NodeName" -p "{{PORT}}:5678" --env-file (Join-Path $StateDir "n8n.env") -e N8N_SSL_CERT=/certs/origin.pem -e N8N_SSL_KEY=/certs/origin.key -v "ews_n8n_$($NodeName)_data:/home/node/.n8n" -v "$PWD/n8n:/workflows:ro" -v "$($CertDir)\\origin.pem:/certs/origin.pem:ro" -v "$($CertDir)\\origin.key:/certs/origin.key:ro" n8nio/n8n:stable' },
        ],
      },
      {
        title: '导入凭证',
        body: '先在浏览器完成 owner 初始化，再把从现有节点安全转移来的三份 Credential JSON 放入仓库根目录的 ews-credentials。导入完成后立即清理容器内副本。',
        commands: [
          { mode: 'all', label: 'Linux：导入凭证', language: 'bash', template: 'CONTAINER="ews-n8n-{{NODE_NAME}}"\ndocker cp ./ews-credentials/. "$CONTAINER:/tmp/ews-credentials"\ndocker exec "$CONTAINER" n8n import:credentials --separate --input=/tmp/ews-credentials\ndocker exec "$CONTAINER" node -e "require(\'fs\').rmSync(\'/tmp/ews-credentials\',{recursive:true,force:true})"' },
          { mode: 'all', label: 'Windows：导入凭证', language: 'powershell', template: '$Container = "ews-n8n-{{NODE_NAME}}"\ndocker cp .\\ews-credentials\\. "$Container`:/tmp/ews-credentials"\ntry { docker exec $Container n8n import:credentials --separate --input=/tmp/ews-credentials } finally { docker exec $Container node -e "require(\'fs\').rmSync(\'/tmp/ews-credentials\',{recursive:true,force:true})" }' },
        ],
      },
      {
        title: '导入并发布 9 个工作流',
        body: '工作流目录已只读挂载到 /workflows。导入后按固定 ID 发布全部工作流并重启容器，使生产 webhook 生效；任何一个 publish 失败都必须先处理，不能直接进入用户分流。',
        commands: [
          { mode: 'all', label: 'Linux：导入并发布', language: 'bash', template: 'CONTAINER="ews-n8n-{{NODE_NAME}}"\ndocker exec "$CONTAINER" n8n import:workflow --separate --input=/workflows\nfor WORKFLOW_ID in 3OQ3QakjljQ1rhj9 JSTmV3K7pQ2x9AbC jstMetadataV3 JSTdV3N6uW1z5EfG JSTsV3M4rT8y2CdE fbcAtELpSiBgZUqP mAM6iCqe6dSUy7sw xVSBMYSVJD9dhOLF tZAc21Dmx05Gkdsr; do\n  docker exec "$CONTAINER" n8n publish:workflow --id="$WORKFLOW_ID" || exit 1\ndone\ndocker restart "$CONTAINER"' },
          { mode: 'all', label: 'Windows：导入并发布', language: 'powershell', template: '$Container = "ews-n8n-{{NODE_NAME}}"\ndocker exec $Container n8n import:workflow --separate --input=/workflows\nif ($LASTEXITCODE -ne 0) { throw "工作流导入失败" }\n$WorkflowIds = @("3OQ3QakjljQ1rhj9","JSTmV3K7pQ2x9AbC","jstMetadataV3","JSTdV3N6uW1z5EfG","JSTsV3M4rT8y2CdE","fbcAtELpSiBgZUqP","mAM6iCqe6dSUy7sw","xVSBMYSVJD9dhOLF","tZAc21Dmx05Gkdsr")\nforeach ($WorkflowId in $WorkflowIds) {\n  docker exec $Container n8n publish:workflow --id=$WorkflowId\n  if ($LASTEXITCODE -ne 0) { throw "工作流发布失败：$WorkflowId" }\n}\ndocker restart $Container' },
        ],
      },
    ],
  },
  {
    id: 'credentials', number: '04', title: '迁移工作流凭证',
    intro: '工作流按 Credential ID 引用三组 HTTP Header Auth。迁移时要保留 ID，否则节点导入后仍会显示凭证缺失。',
    steps: [
      {
        title: '从现有 n8n 导出',
        body: '导出的 JSON 包含明文密钥，只允许在受控主机之间短暂中转。导入完成并验收后必须删除源端和目标端明文目录。',
        commands: [
          { mode: 'all', label: '创建中转目录', language: 'bash', template: 'docker exec n8n mkdir -p /tmp/ews-credentials' },
          { mode: 'all', label: '按 ID 解密导出', language: 'bash', template: 'docker exec n8n n8n export:credentials --id=Ua1TBIbDcAu3z8pU --decrypted --output=/tmp/ews-credentials/grsai.json\ndocker exec n8n n8n export:credentials --id=11xE3AjgQ1iUHDdR --decrypted --output=/tmp/ews-credentials/deepseek.json\ndocker exec n8n n8n export:credentials --id=bkpImgApi20260722 --decrypted --output=/tmp/ews-credentials/backup-image.json\ndocker cp n8n:/tmp/ews-credentials ./ews-credentials\ndocker exec n8n node -e "require(\'fs\').rmSync(\'/tmp/ews-credentials\',{recursive:true,force:true})"' },
        ],
      },
      {
        title: '安全转移',
        body: '将 ews-credentials 目录通过 SCP/SFTP 或内网加密通道传到新节点。不要提交到 Git，不要放进 R2，不要通过聊天工具发送。',
        bullets: ['导入前核对目录内只有三份 JSON', '限制目录只允许部署账号读取', 'Docker 导入命令会清理容器内 /tmp/ews-credentials', '宿主机明文目录需要管理员在第 06 节验收后删除'],
      },
    ],
  },
  {
    id: 'routing', number: '05', title: '绑定 EWS 用户分流',
    intro: '节点部署完成后，在 EWS 系统配置中把不同用户或不同工作流类型分配到对应节点，实现水平扩容。',
    steps: [
      {
        title: '填写用户 Webhook',
        body: '进入系统配置 -> 用户管理 -> 工作流地址。先绑定一个测试用户；确认闭环后再按用户组或业务量分批迁移。',
        bullets: ['地址格式固定为 https://{{DOMAIN}}/webhook/...', 'Shopee 和聚水潭不要混填平台路径', '商品元数据、主图、附图、SKU 图可以指向不同节点', '测试 webhook URL 和 n8n 编辑器 URL 不能填入 EWS'],
      },
    ],
  },
  {
    id: 'validation', number: '06', title: '闭环验收',
    intro: '不要只看 healthz。必须确认 EWS 能释放计划、n8n 能接收 webhook、回调能写回 Worker、R2 图片能预览，最终任务能导出。',
    steps: [
      {
        mode: 'local-tunnel',
        title: 'Tunnel 节点检查',
        body: '本地主机重点看 cloudflared 是否 connected，以及 Public Hostname 是否能转发到容器网络内的 n8n:5678。',
        commands: [
          { mode: 'local-tunnel', label: '本地健康与连接器日志', language: 'bash', template: 'curl -fsS http://127.0.0.1:{{PORT}}/healthz\ndocker inspect ews-n8n-{{NODE_NAME}} --format "{{.State.Status}}"\ndocker logs --tail 120 ews-cloudflared-{{NODE_NAME}}' },
          { mode: 'local-tunnel', label: '公网健康', language: 'bash', template: 'curl -fsS https://{{DOMAIN}}/healthz' },
        ],
      },
      {
        mode: 'cloud-dns',
        title: 'DNS 节点检查',
        body: '云服务器重点看 Cloudflare 是否使用 Full (strict) 成功回源，以及源站 443 是否没有被其他服务占用。',
        commands: [
          { mode: 'cloud-dns', label: '本机 HTTPS 健康', language: 'bash', template: 'curl -kfsS https://127.0.0.1:{{PORT}}/healthz\ndocker inspect ews-n8n-{{NODE_NAME}} --format "{{.State.Status}}"' },
          { mode: 'cloud-dns', label: '公网健康', language: 'bash', template: 'curl -fsS https://{{DOMAIN}}/healthz' },
        ],
      },
      {
        title: 'EWS 业务闭环',
        body: '用绑定到新节点的测试用户各创建一个最小 Shopee 和聚水潭任务。检查计划进入 processing、n8n 返回 accepted、callback_secret 校验通过、图片写入 R2、表格可导出。',
        bullets: ['先测试商品元数据，再测试主图、附图和 SKU 图', '检查没有 401/403、excessive system load 或长时间 pending', '通过后再把生产用户分批迁移到新节点'],
      },
    ],
  },
  {
    id: 'operations', number: '07', title: '运维与回退',
    intro: '分布式节点的回退手段是修改 EWS 用户 webhook，不需要改任务数据。节点执行记录保留 168 小时且最多 10000 条。',
    steps: [
      {
        title: '升级与回退顺序',
        body: '升级前先把该节点用户迁回默认节点或其他健康节点，等待活动执行结束，再更新容器。保留数据卷和 .env 中的 N8N_ENCRYPTION_KEY。',
        bullets: ['记录当前镜像版本、NodeName 和域名', '先迁出用户，再处理容器', '禁止在没有备份时删除 ews_n8n_{{NODE_NAME}}_data', 'Tunnel token 泄露时在 Cloudflare 控制台轮换 connector token'],
        commands: [
          { mode: 'all', label: '停止故障节点', language: 'bash', template: 'docker stop ews-n8n-{{NODE_NAME}}\ndocker stop ews-cloudflared-{{NODE_NAME}} 2>/dev/null || true' },
          { mode: 'all', label: '恢复节点', language: 'bash', template: 'docker start ews-n8n-{{NODE_NAME}}\ndocker start ews-cloudflared-{{NODE_NAME}} 2>/dev/null || true\ndocker logs --tail 100 ews-n8n-{{NODE_NAME}}' },
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
    subtitle: '本地主机走 Cloudflare Tunnel，云服务器走 Cloudflare DNS，统一接入 EWS 用户级 webhook 分流',
    script: {
      filename: 'deploy-extra-node.ps1',
      download_url: '/api/admin/wiki/distributed-n8n/script',
      sha256: await sha256(DISTRIBUTED_N8N_SCRIPT),
    },
    defaults: { mode: 'local-tunnel', domain: 'n8n-node2.example.com', node_name: 'node2', port: 5679, n8n_version: 'stable', concurrency: 20 },
    modes: DEPLOYMENT_MODES,
    credentials: CREDENTIALS,
    references: REFERENCES,
    webhooks: WEBHOOKS,
    sections: SECTIONS,
  };
}

export { DISTRIBUTED_N8N_SCRIPT };
