# n8n 工作流

本目录中的 JSON 文件可直接导入 n8n。系统配置对应关系：

| 文件 | 系统配置键 | 用途 |
| --- | --- | --- |
| `聚水潭商品元数据.json` | JST `n8n_title_webhook` | 分批生成商品标题、推荐文案、商品描述和 SKU 标题 |
| `聚水潭主图.json` | JST `n8n_main_webhook` | 每套生成一张独立商品主图 |
| `聚水潭附图.json` | JST `n8n_sub_image_webhook` | 生成第 2~N 张商品附图 |
| `聚水潭详情图.json` | JST `n8n_detail_webhook` | 生成 3:4 商品详情图 |
| `聚水潭SKU图.json` | JST `n8n_sku_image_webhook` | 按唯一一级规格和可选用户提示词生成并复用 SKU 图片 |
| `虾皮商品元数据.json` | `n8n_title_webhook` | 为每个子任务生成越南语商品标题、描述和规格标签 |
| `虾皮主图.json` | `n8n_main_webhook` | 每套生成一张独立封面图 |
| `虾皮附图.json` | `n8n_sub_image_webhook` | 生成第 2~9 张商品附图 |
| `虾皮sku图.json` | `n8n_sku_image_webhook` | 根据 `sku_image` 和可选 `sku_description` 生成变体图 |

Shopee basic template 不包含详情图字段，因此系统固定不构造详情图工作流。

导入后需要完成以下配置：

1. 为 DeepSeek 和图片生成 HTTP 节点选择对应的 Header Auth credential。
2. 将每个 Webhook 的 Production URL 填入系统配置页对应字段。
3. 当前新版工作流的“密钥校对”固定使用 `v3`，必须与系统 `callback_secret` 保持一致。
4. 将 `push_primary_images_only` 设为 `false`，并按平台开启 `n8n_title_enabled` 和 `n8n_sku_image_enabled`。关闭的工作流不会构造推送计划；两个开关也可由管理员为单个用户设置继承、开启或关闭。

## Shopee 备用图片模型

Shopee 主图、附图和 SKU 图默认使用 GRSAI。只有创建或轮询结果中的错误文本包含 `excessive system load`（不区分大小写）时，工作流才切换到 `https://api.lk888.ai` 的 `gpt-image-2`；其他错误继续沿用原有失败、轮询和 Worker 重试逻辑。备用接口同时兼容同步 `data[0].url`、顶层异步 `task_id`，以及实际接口使用的 `{ code, data: { task_id } }` 包装响应；状态查询同样兼容顶层和 `data` 包装。切换后继承主模型任务的原始开始时间，始终受 900 秒总超时限制，备用接口失败不会再次回切。

备用接口必须使用名为 `EWS Backup Image API`、ID 为 `bkpImgApi20260722` 的 n8n `httpHeaderAuth` credential，Header 为 `Authorization: Bearer <API_KEY>`。API Key 只能保存到 n8n 加密凭据库，不得写入工作流 JSON、仓库或日志。工作流更新执行：

```powershell
node n8n/update-shopee-image-fallback.mjs
```

## 异步图片处理与 R2 直传

7 个图片工作流在模型出图后调用 `ews-image-sidecar` 的 `POST /v1/image-jobs`。Fastify API 只负责鉴权和写入 BullMQ，持久化成功后立即返回 HTTP `202`；独立图片 Worker 从 Valkey 队列消费任务，因此 n8n 不再等待图片下载、转码和上传。图片 Worker 使用 `sharp/libvips` 将图片转为 quality 88 JPEG；输出超过 1.9MB 时才使用 Bilinear 等比缩小。

图片 Worker 复用推送体中的 `callback_secret` 请求 `POST /api/internal/r2-upload-ticket`，通过 5 分钟有效、仅允许写入当前计划对象的 presigned PUT URL 直传 R2。上传完成后由图片服务直接调用 Worker callback，只传 `r2_key`、`sha256`、`size_bytes` 和定位字段，不传 Base64 或临时图片 URL。处理最终失败时也由图片服务回调，n8n 只在队列拒绝请求时发送失败回调。

R2 的 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` 只保存为 Worker secret，不能配置到 n8n、D1 或工作流 JSON。对应 R2 API Token 应限制为 `ossapac` bucket 的 Object Read & Write。部署前执行：

```powershell
npx.cmd wrangler secret put R2_ACCESS_KEY_ID
npx.cmd wrangler secret put R2_SECRET_ACCESS_KEY
```

单主机 Compose、环境变量、健康检查、外部端点和恢复流程参见 [`image-sidecar/README.md`](image-sidecar/README.md)。仓库中的工作流默认访问同一 Docker 网络的 `http://ews-image-sidecar:3000/v1/image-jobs`。生成使用外部 HTTPS 端点的工作流时执行：

```powershell
$env:IMAGE_SERVICE_URL='https://images.example.com'
node n8n/update-image-workflows.mjs
```

所有工作流均使用 `Respond to Webhook` 显式响应：密钥正确时立即返回 HTTP `202` 和 `{"success":true,"status":"accepted","plan_id":"原始计划ID"}`，随后继续执行生成流程；密钥错误时立即返回 HTTP `401` 和 `{"success":false,"retryable":false}`。Worker 只接受 HTTP `202`、`success=true`、`status=accepted` 且 `plan_id` 与推送体一致的 ACK；ACK 等待上限为 300 秒。达到该上限时无法判断 n8n 是否已经执行，因此计划会停止且不会自动重投；原工作流若稍后成功回调，系统仍会按 `plan_id` 接纳。ACK 格式错误或计划ID不一致仍按临时错误重试，HTTP `400/401/403/404` 等明确拒绝直接失败。Webhook 投递通过独立的 `PUSH_DISPATCH_EVENTS` Cloudflare Queue 执行，避免 HTTP 请求返回后 `waitUntil()` 的 30 秒存活限制，也不会阻塞 R2 callback 队列；投递消息绑定 `processing_at + retry_count`，过期消息不会执行新一轮计划。更新 JSON 后需要重新导入或同步到 n8n 中，仓库文件不会自动覆盖线上工作流。

Shopee 商品标题按“主关键词 + 副关键词 + 长尾词 + 属性词”生成，但最终标题不会包含字段括号。Shopee 商品元数据工作流一次返回每套商品的 `products` 和全任务的 `variation_labels`，规格标签按变体 `id` 映射。JST 元数据按最多 10 套商品、最多 100 个 SKU 标题动态分批，每次推送和回调都必须原样携带 `plan_id`。JST 与 Shopee 的 SKU 图只按一级规格推送一次，推送体只包含该规格的 `sku_image`、可选 `sku_description` 和回调定位字段，不包含规格名、商品事实或核心参考图。`sku_description` 非空时原样作为图片提示词，留空时使用工作流内置的产品一致性提示词；二级规格不会增加图片工作流数量。

图片工作流会在以下情况回调 `error`：创建图片任务的 HTTP 请求失败、轮询请求失败、图片服务返回 `failed/violation`、超过 900 秒、服务声称成功但没有图片 URL、图片队列拒绝请求，或图片 Worker 下载/转码/票据/上传最终失败。确定无法恢复的 4xx、无效参数和超限图片会传 `retryable:false`，其他临时错误先由 BullMQ 重试，耗尽后再进入 Worker 计划重试。Worker 只在原生 Cloudflare Queue `send()` 成功后确认回调；Queue 最多重试 5 次并配置 DLQ。超过 48KB 的聚合元数据回调会暂存到 R2 inbox，Queue 仅携带 key，处理后自动删除。n8n 完全没有回调时，`push_plan_timeout_minutes` 默认在 20 分钟后兜底。图片回调必须原样带回 `plan_id`、`task_id`、`sub_task_id`、`image_type` 和 `image_position`；`set_index` 会由系统根据 `sub_task_id` 重新校准。
