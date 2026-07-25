# EWS 额外 n8n 节点部署

该方案部署独立的 n8n 实例，用独立端口、SQLite 数据卷和 `N8N_ENCRYPTION_KEY` 承接指定用户的工作流。它不是 n8n queue mode 集群；EWS Worker 仍按任务所属用户的 `webhook_config` 选择目标地址，因此不同用户可以分流到不同主机。

## 部署

目标服务器需要 Docker Engine、Docker Compose v2、可用的 HTTPS 域名和反向代理。域名根路径必须反代到指定端口，不能挂在子路径下。

Windows 使用 Windows PowerShell 5.1 或 PowerShell 7；Linux 主机安装 PowerShell 7 后使用同一脚本。

Linux 调用方式为 `pwsh ./deploy-extra-node.ps1 ...`。

```powershell
cd ews-worker\n8n\deploy
.\deploy-extra-node.ps1 -NodeName node2 -Port 5679 -PublicUrl https://n8n-node2.example.com
```

首次打开输出的地址并完成 n8n owner 初始化。随后导入并启用仓库中的全部工作流：

```powershell
.\deploy-extra-node.ps1 -NodeName node2 -Port 5679 -PublicUrl https://n8n-node2.example.com -ImportWorkflows
```

脚本可重复执行。相同 `NodeName` 会复用 `%LOCALAPPDATA%\EWS\n8n-nodes\{NodeName}\.env` 中的加密密钥和 `ews_n8n_{NodeName}_data` 数据卷。不要删除或跨节点复用该密钥；密钥丢失后已有凭据无法解密。

可用参数：

- `-Image n8nio/n8n:2.25.7`：固定 n8n 镜像版本，升级时显式修改。
- `-Concurrency 20`：该节点生产执行并发上限。
- `-EncryptionKey <secret>`：首次部署时传入自有密钥；未传时自动生成。
- `-WorkflowDirectory <path>`：覆盖工作流 JSON 目录。
- `-CredentialsDirectory <path>`：导入从原节点解密导出的 Credential JSON 目录，并保留原 Credential ID。
- `-SkipActivation`：只导入，不逐个发布工作流。

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
- 反向代理必须传递原始 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`，并把请求超时设置为至少 900 秒。
- 当前工作流引用 `GrsaiApp`、`deepseek` 和 `EWS Backup Image API` 三组 HTTP Header Auth。推荐从原节点按 Credential ID 解密导出到独立目录，再通过 `-CredentialsDirectory` 导入；脚本会在容器内清除中转副本，管理员仍须安全删除宿主机明文目录。
- n8n Variables 和项目成员不会跨节点复制，需要在额外节点单独配置。不要把明文凭据写进部署脚本或仓库。
- 扩容后先用测试任务逐项验证 9 个 webhook，再把生产用户绑定到新节点。
