# EWS n8n 节点环境一键部署

生产部署入口位于管理员导航的“部署 Wiki”。管理员填写节点信息和 n8n owner 后，浏览器会下载一份 `install-ews-{node}.cmd`。

安装器只负责运行环境，不导入或发布 workflow JSON，也不创建或覆盖 n8n credentials。工作流和模型凭证必须在环境就绪后由管理员人工迁移。

宿主机要求：

- Windows 10/11
- Windows 自带的 `cmd.exe` 和系统组件
- 仅在缺少 Docker Desktop 时批准一次 Windows 管理员提示

执行方式：

```bat
install-ews-node2.cmd
```

也可以直接双击 CMD。安装器会优先复用已经就绪的 Docker Engine；若未安装 Docker Desktop，则从 Docker 官方地址下载对应 CPU 架构的签名安装器。Windows 首次启用 WSL 2 如果要求重启，重启后再次运行同一 CMD 即可继续。

安装器会自动完成：

1. 检查并启动 Docker Desktop/CLI，缺失时自动下载安装。
2. 拉取固定版本的 `n8nio/n8n:2.25.7` 和 Valkey 镜像，并从 CMD 内嵌源码重新构建图片服务。
3. 创建 Valkey 持久化队列、图片 API、图片 Worker、节点 Docker network、volume 和 n8n 容器。
4. 持久化 `N8N_ENCRYPTION_KEY`，初始化 n8n owner。
5. 校验 Valkey、图片服务 `/readyz` 和 n8n `/healthz`。

安装器明确不会执行：

- 打包、复制、导入或发布任何 workflow JSON
- 创建、导入或覆盖任何 n8n credential
- 将 GRSAI、DeepSeek 或备用图片 API Key 写入下载脚本

环境部署完成后，管理员需要登录 n8n 并人工完成：

1. 导入仓库 `n8n/` 目录中的 9 个生产 workflow JSON。
2. 创建 `GrsaiApp`、`deepseek` 和 `EWS Backup Image API` 三组 `HTTP Header Auth` credential。
3. 将 credentials 绑定到对应节点；使用外部图片服务时，同时检查工作流的图片服务地址。
4. 逐个检查并发布工作流，再用最小 Shopee 与聚水潭任务验证回调。

节点状态保存在 `%LOCALAPPDATA%\EWS\n8n-nodes\{node}`。重复执行同一节点脚本会复用数据卷和加密密钥，并重建运行容器，但不会改动 n8n 中已有的工作流和凭证。

默认图片服务地址 `http://ews-image-sidecar:3000` 会触发本机部署：安装器使用内嵌源码构建 `ews-image-service:2026.07.28`，创建 `ews-image-valkey`、`ews-image-sidecar`、`ews-image-worker` 和 Valkey volume。仅在明确填写外部 HTTP/HTTPS 端点时跳过本机图片服务。

一键部署的图片服务允许公网域名经宿主机透明代理解析到 `198.18.0.0/15` fake-IP；直接使用该网段的 URL 以及其他内网、环回和 link-local 地址仍会被拒绝。

## Cloudflare Tunnel

Cloudflare 不属于安装器依赖。n8n 部署成功后，管理员在 Cloudflare 创建 remotely-managed tunnel，再使用 Wiki 生成的独立 Docker 命令连接。

Public Hostname 的 Service 固定为：

```text
http://n8n:5678
```

`cloudflared` 必须加入安装器创建的 `ews-{node}` Docker network。无需公网 IP、端口转发或额外反向代理。

## 安全边界

- owner 密码和回调密钥只在浏览器本地注入下载脚本，不通过 EWS API 上传。
- 下载脚本包含上述两项明文敏感信息，部署后必须删除。
- 模型 API Key 只能由管理员直接写入 n8n 加密凭证库。
- 不要将生成的安装器提交到 Git、网盘或聊天工具。
- 原始安装器模板不包含真实密钥，下载接口与 Wiki 接口均要求管理员鉴权。
