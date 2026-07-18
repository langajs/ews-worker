# EWS 单主机图片处理服务

该服务用于承接 n8n 图片工作流的并发输出。Fastify 接入层只做校验和入队，BullMQ/Valkey 保存任务，Sharp Worker 执行下载、JPEG 转码、必要时等比缩小、R2 直传和 Worker callback。

## 服务组成

```text
n8n
  -> POST /v1/image-jobs
  -> Fastify API -> BullMQ -> Valkey AOF
                         -> Sharp Worker
                              -> Worker R2 PUT ticket
                              -> R2 presigned PUT
                              -> POST /api/callback
```

API 接收任务并持久化后立即返回 `202`。HTTP 并发不会直接扩大 Sharp 并发；实际处理并发由 `WORKER_CONCURRENCY` 控制。

## 部署

```powershell
Copy-Item .env.example .env
# 编辑 .env，IMAGE_SERVICE_SECRET 必须与 Worker callback_secret 一致
docker compose up -d --build
docker compose ps
```

默认监听宿主机 `0.0.0.0:3000`。公网部署必须在 Caddy、Nginx 或负载均衡器后启用 HTTPS，并通过防火墙限制调用来源。n8n 与服务在同一 Docker 网络时，可以取消 `ports` 并仅使用 `expose`。

更新服务：

```powershell
docker compose build --pull
docker compose up -d
```

停止服务不会删除任务：

```powershell
docker compose down
```

只有明确放弃所有排队任务时才可执行 `docker compose down -v`。

## API

### 提交图片任务

`POST /v1/image-jobs` 使用 JSON。`callback_secret` 同时作为入口鉴权，不增加工作流推送字段。成功返回：

```json
{
  "success": true,
  "status": "accepted",
  "job_id": "img-sha256",
  "duplicate": false
}
```

相同 `plan_id + source_url` 是同一个幂等任务。活动任务不会重复处理；已完成任务再次提交时复用原 `r2_key` 重放 callback，避免 Worker 回调丢失导致计划超时。队列达到 `MAX_QUEUE_DEPTH` 时返回 `429` 和 `Retry-After: 30`。

### 管理与健康检查

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 无 | 进程存活 |
| `GET` | `/readyz` | 无 | Valkey 就绪 |
| `GET` | `/v1/image-jobs/:jobId` | Bearer secret | 任务状态 |
| `POST` | `/v1/image-jobs/:jobId/retry` | Bearer secret | 重试 BullMQ 失败任务 |
| `GET` | `/v1/stats` | Bearer secret | 队列统计 |

管理接口也支持 `X-Image-Service-Secret`。

## 处理规则

1. 源图片最大 16MB、最大 4000 万像素，并拒绝内网地址和内网 DNS 解析结果。
2. 所有输入统一输出 JPEG，固定 quality 88，不裁切。
3. 首次 JPEG 超过 1.9MB 时，最多进行 4 次 Bilinear 等比缩小。
4. 图片服务请求 Worker 的一次性 R2 PUT ticket，不保存 R2 Access Key。
5. 上传结果保存在 BullMQ job data；callback 临时失败时不会重复下载和转码。
6. 可恢复错误采用 BullMQ 指数退避；最终结果由图片服务直接 callback。

## 容量配置

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `WORKER_CONCURRENCY` | `8` | 同时处理的图片数量，建议不超过 CPU 核数的 1～2 倍 |
| `MAX_QUEUE_DEPTH` | `10000` | 等待、活动和延迟任务总上限 |
| `JOB_ATTEMPTS` | `4` | 图片处理重试次数 |
| `CALLBACK_ATTEMPTS` | `5` | 每次任务内的 Worker callback 重试次数 |
| `SOURCE_HOST_ALLOWLIST` | 空 | 可选逗号分隔的图片源域名白名单 |
| `MAX_SOURCE_BYTES` | `16777216` | 最大源文件大小 |
| `MAX_OUTPUT_BYTES` | `1900000` | 最大输出文件大小 |

单机可接收 100～200 个并发 HTTP 请求，但不要把 `WORKER_CONCURRENCY` 设置为 100～200。`8 vCPU / 16GB RAM` 建议从 `8` 开始，根据 CPU、RSS、下载带宽和队列积压压测调整。

## 故障恢复

- Valkey 使用 AOF `everysec` 和具名 volume，容器重启后等待任务仍在。
- Worker 使用 BullMQ lock 和 stalled 检查，进程中断的活动任务会重新入队。
- API 只在 Valkey 入队成功后返回 `202`；Valkey 不可用时返回 `503`。
- `failed` 任务保留 7 天，可通过重试端点恢复。
- 单主机仍是故障域，正式 SaaS 应备份 Valkey volume，并预留迁移到共享 Valkey 后横向增加 Worker 的能力。
