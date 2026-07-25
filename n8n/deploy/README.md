# EWS n8n 一键部署

生产部署入口位于管理员导航的“部署 Wiki”。管理员填写节点信息、n8n owner 和三组模型 API Key 后，浏览器会下载一份完整的 `install-ews-{node}.cmd`。

宿主机仅需：

- Windows 10/11
- Docker Desktop，且 Docker Engine 已启动
- Windows 自带的 `cmd.exe` 和系统组件

执行方式：

```bat
install-ews-node2.cmd
```

也可以直接双击该 CMD 文件。用户无需打开 PowerShell 或处理执行策略；CMD 内部会调用 Windows 自带组件运行嵌入的安装逻辑。

安装器会自动完成以下操作：

1. 创建节点专属 Docker network、volume 和 `n8nio/n8n:stable` 容器。
2. 持久化 `N8N_ENCRYPTION_KEY`，初始化 n8n owner。
3. 导入三组 `HTTP Header Auth` 凭证。
4. 导入并发布仓库内 9 个生产工作流。
5. 将 7 个图片工作流改写为管理员填写的图片服务地址；同主机容器会自动接入图片服务所在的 Docker network。
6. 校验图片服务 `/readyz`、n8n `/healthz` 和工作流发布状态。

节点状态保存在 `%LOCALAPPDATA%\EWS\n8n-nodes\{node}`。重复执行同一节点脚本会复用数据卷和加密密钥，并重新导入当前工作流。

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
