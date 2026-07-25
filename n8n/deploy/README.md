# EWS 额外 n8n 节点部署

该方案部署独立的 n8n 实例，用独立端口、SQLite 数据卷和 `N8N_ENCRYPTION_KEY` 承接指定用户的工作流。它不是 n8n queue mode 集群；EWS Worker 仍按任务所属用户的 `webhook_config` 选择目标地址，因此不同用户可以分流到不同主机。

## 标准部署入口

生产部署的权威说明位于 EWS 管理员导航中的“分布式部署 Wiki”。Wiki 在管理员鉴权后加载，并提供可直接复制的 Linux 和 Windows Docker 命令；宿主机只需要 Docker Engine 或 Docker Desktop，不要求安装 Node.js、PowerShell 或反向代理。

当前支持两种入口：

- 本地主机：Cloudflare Tunnel。n8n 只绑定 `127.0.0.1:{Port}`，`cloudflared` 使用同一 Docker network 转发到 `http://n8n:5678`。
- 云服务器：Cloudflare DNS 橙云代理。n8n 直接挂载 Cloudflare Origin CA 证书并监听受支持的 HTTPS 端口，推荐 `443`。

两种模式都使用节点专属 Docker volume 和持久化 `N8N_ENCRYPTION_KEY`。重新创建容器不会清空 n8n 数据，但删除数据卷或加密密钥会导致不可恢复的数据或凭证损失。

## 标准执行顺序

1. 在管理员 Wiki 中选择“本地主机”或“云服务器”，填写域名、节点名、端口以及可选的 Tunnel token。
2. 执行对应操作系统的“生成并持久化节点配置”命令。
3. 执行 Docker 启动命令并打开节点域名，完成 n8n owner 初始化。
4. 安全迁移三份 Credential JSON，使用 `docker cp` 与 `docker exec` 导入。
5. 导入并发布仓库 `n8n/` 中的 9 个工作流，完成健康检查与最小业务闭环。
6. 在 EWS“系统配置 → 用户管理 → 工作流地址”中逐用户切换 webhook。

## 可选 PowerShell 辅助脚本

`deploy-extra-node.ps1` 是标准 Docker 流程的自动化封装，不是生产部署的必要依赖。Windows 可以直接使用 Windows PowerShell 5.1/PowerShell 7；Linux 只有在主动选择该辅助方式时才需要 PowerShell 7。

~~~powershell
.\deploy-extra-node.ps1 -NodeName node2 -Exposure tunnel -TunnelToken "<CLOUDFLARE_TUNNEL_TOKEN>" -Port 5679 -PublicUrl https://n8n-node2.example.com -WorkflowDirectory ..\
~~~

脚本会生成 Docker Compose 配置并保存在宿主机节点状态目录。相同 `NodeName` 会复用 `.env` 中的加密密钥和 `ews_n8n_{NodeName}_data` 数据卷。

## 辅助脚本参数

- `-Exposure tunnel|direct`：本地主机使用 `tunnel`，云服务器使用 `direct`。
- `-TunnelToken <token>`：Tunnel 模式必填，来自 Cloudflare connector token。
- `-OriginCertPath <path>` / `-OriginKeyPath <path>`：DNS 直连 HTTPS 必填，用于 n8n 源站 TLS。
- `-Image n8nio/n8n:stable`：默认使用稳定镜像标签；生产升级时可显式传入已验证的固定版本。
- `-Concurrency 20`：该节点生产执行并发上限。
- `-EncryptionKey <secret>`：首次部署时传入自有密钥；未传时自动生成。
- `-WorkflowDirectory <path>`：覆盖工作流 JSON 目录。
- `-CredentialsDirectory <path>`：导入从原节点解密导出的 Credential JSON 目录，并保留原 Credential ID。
- `-SkipActivation`：只导入，不逐个发布工作流。

Windows 状态目录为 `%LOCALAPPDATA%\EWS\n8n-nodes\{NodeName}`；Linux 使用辅助脚本时取决于 PowerShell 返回的 LocalApplicationData 或 `$HOME/.local/state`。不要跨节点复用加密密钥。

## 用户分流

在 EWS 的“系统配置 → 用户管理 → 工作流地址”中为用户填写新节点地址。留空字段继续继承系统默认地址。

| 配置项 | webhook 路径 |
| --- | --- |
| Shopee 商品元数据 | `/webhook/vn/v3t1` |
| Shopee 主图 | `/webhook/vn/v3m1` |
| Shopee 附图 | `/webhook/vn/v3m2` |
| Shopee SKU 图 | `/webhook/vn/v3s1` |
| 聚水潭商品元数据 | `/webhook/jst/v3-metadata` |
| 聚水潭主图 | `/webhook/cn/v3m1` |
| 聚水潭附图 | `/webhook/cn/v3m2` |
| 聚水潭详情图 | `/webhook/cn/v3d1` |
| 聚水潭 SKU 图 | `/webhook/cn/v3s1` |

例如 `PublicUrl` 为 `https://n8n-node2.example.com`，Shopee 主图地址应填写 `https://n8n-node2.example.com/webhook/vn/v3m1`。

## 运维边界

- 每个节点的执行记录默认保留 168 小时，最多保留 10000 条。
- 当前工作流引用 `GrsaiApp`、`deepseek` 和 `EWS Backup Image API` 三组 HTTP Header Auth。推荐从原节点按 Credential ID 解密导出到独立目录，再通过 `-CredentialsDirectory` 导入；脚本会在容器内清除中转副本，管理员仍须安全删除宿主机明文目录。
- n8n Variables 和项目成员不会跨节点复制，需要在额外节点单独配置。不要把明文凭据写进部署脚本或仓库。
- 扩容后先用测试任务逐项验证 9 个 webhook，再把生产用户绑定到新节点。
