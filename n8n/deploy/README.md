# EWS n8n 一键部署

生产部署入口位于管理员导航的“部署 Wiki”。管理员填写节点信息、n8n owner 和三组模型 API Key 后，浏览器会下载一份完整的 `install-ews-{node}.cmd`。

宿主机仅需：

- Windows 10/11
- Windows 自带的 `cmd.exe` 和系统组件
- 可批准一次 Windows 管理员提示；仅在缺少 Docker Desktop 时需要

执行方式：

```bat
install-ews-node2.cmd
```

也可以直接双击该 CMD 文件。用户无需预装或预先启动 Docker Desktop、打开 PowerShell 或处理执行策略；安装器会优先复用已经就绪的 Docker Engine。若本机没有 Docker Desktop，则从 Docker 官方地址下载对应 CPU 架构的签名安装器，完成安装后启动并等待 Linux Docker Engine 就绪。Windows 首次启用 WSL 2 若要求重启，重启后重新运行同一 CMD 即可继续。

安装器会自动完成以下操作：

1. 检查 Docker Desktop/CLI，缺失时自动下载官方安装器并安装，未启动时自动启动。
2. 复用本地镜像；缺少时拉取 `n8nio/n8n:2.25.7` 与 Valkey，并从 CMD 内嵌源码构建图片服务。
3. 创建 Valkey 持久化队列、图片 API、图片 Worker，以及节点专属 Docker network、volume 和 n8n 容器。
4. 持久化 `N8N_ENCRYPTION_KEY`，初始化 n8n owner。
5. 导入三组 `HTTP Header Auth` 凭证。
6. 导入并发布仓库内 9 个生产工作流。
7. 将 7 个图片工作流接入本机图片服务，或改写为管理员填写的外部服务地址。
8. 校验 Valkey、图片服务 `/readyz`、n8n `/healthz` 和工作流发布状态。

节点状态保存在 `%LOCALAPPDATA%\EWS\n8n-nodes\{node}`。重复执行同一节点脚本会复用数据卷和加密密钥，并重新导入当前工作流。

n8n owner 密码必须为 8-64 位，并至少包含一个大写字母和一个数字。安装器会等待管理 API 完整就绪，并在导入工作流前确认 owner 已初始化；中断后可直接重新执行同一脚本。

默认图片服务地址 `http://ews-image-sidecar:3000` 会触发闭环部署：安装器内嵌固定版本源码，在新主机构建 `ews-image-service:2026.07.28`，创建 `ews-image-valkey`、`ews-image-sidecar`、`ews-image-worker` 和具名 Valkey volume。重复执行时会复用健康服务；只有明确填写外部 HTTP/HTTPS 端点时才跳过本机图片栈。

## Cloudflare Tunnel

Cloudflare 不属于安装器依赖。n8n 部署成功后，管理员在 Cloudflare 创建 remotely-managed tunnel，再使用 Wiki 生成的独立 Docker 命令连接。

Public Hostname 的 Service 固定为：

```text
http://n8n:5678
```

`cloudflared` 必须加入安装器创建的 `ews-{node}` Docker network。无需公网 IP、端口转发或额外反向代理。

## 安全边界

- 密钥只在浏览器本地注入下载脚本，不通过 EWS API 上传。
- 下载脚本包含 Base64 编码的敏感信息，不等于加密。部署后必须删除。
- 模型密钥导入 n8n 后，安装器会删除宿主机和容器内的临时凭证文件。
- 不要将生成的安装器提交到 Git、网盘或聊天工具。
- 原始安装器模板不包含真实密钥，下载接口与 Wiki 接口均要求管理员鉴权。
