# n8n 工作流

本目录中的 JSON 文件可直接导入 n8n。系统配置对应关系：

| 文件 | 系统配置键 | 用途 |
| --- | --- | --- |
| `聚水潭商品元数据.json` | JST `n8n_title_webhook` | 分批生成商品标题、推荐文案、商品描述和 SKU 标题 |
| `聚水潭主图.json` | JST `n8n_main_webhook` | 每套生成一张独立商品主图 |
| `聚水潭附图.json` | JST `n8n_sub_image_webhook` | 生成第 2~N 张商品附图 |
| `聚水潭详情图.json` | JST `n8n_detail_webhook` | 生成 3:4 商品详情图 |
| `聚水潭SKU图.json` | JST `n8n_sku_image_webhook` | 按唯一一级规格生成并复用 SKU 图片 |
| `虾皮商品元数据.json` | `n8n_title_webhook` | 为每个子任务生成越南语商品标题、描述和规格标签 |
| `虾皮主图.json` | `n8n_main_webhook` | 每套生成一张独立封面图 |
| `虾皮附图.json` | `n8n_sub_image_webhook` | 生成第 2~9 张商品附图 |
| `虾皮sku图.json` | `n8n_sku_image_webhook` | 根据一级规格的 `sku_image` 生成变体图 |

Shopee basic template 不包含详情图字段，因此系统固定不构造详情图工作流。

导入后需要完成以下配置：

1. 为 DeepSeek 和图片生成 HTTP 节点选择对应的 Header Auth credential。
2. 将每个 Webhook 的 Production URL 填入系统配置页对应字段。
3. 当前新版工作流的“密钥校对”固定使用 `v3`，必须与系统 `callback_secret` 保持一致。
4. 将 `push_primary_images_only` 设为 `false`，并按平台开启 `n8n_title_enabled` 和 `n8n_sku_image_enabled`。关闭的工作流不会构造推送计划；两个开关也可由管理员为单个用户设置继承、开启或关闭。

所有工作流均使用 `Respond to Webhook` 显式响应：密钥正确时立即返回 HTTP `202` 和 `{"success":true,"status":"accepted"}`，随后继续执行生成流程；密钥错误时立即返回 HTTP `401` 和 `{"success":false,"retryable":false}`。Worker 收到非 2xx 后会立即把对应推送计划标记为失败并显示原因，不再等待回调超时。更新 JSON 后需要重新导入或同步到 n8n 中，仓库文件不会自动覆盖线上工作流。

Shopee 商品标题按“主关键词 + 副关键词 + 长尾词 + 属性词”生成，但最终标题不会包含字段括号。Shopee 商品元数据工作流一次返回每套商品的 `products` 和全任务的 `variation_labels`，规格标签按变体 `id` 映射。JST 元数据按最多 10 套商品、最多 100 个 SKU 标题动态分批，每次推送和回调都必须原样携带 `plan_id`；JST 与 Shopee 的 SKU 图都只按一级规格推送一次，二级规格不会增加图片工作流数量，选择“不生成规格图”时不会创建 SKU 图计划。

图片工作流会在以下情况回调 `error`：创建图片任务的 HTTP 请求失败、轮询请求失败、图片服务返回 `failed/violation`、超过 900 秒、服务声称成功但没有图片 URL。成功和失败回调均使用对象表达式构造 JSON，并最多重试 5 次。Worker 收到图片错误后会按计划重试策略重新生成；n8n 完全没有回调时，Worker 的 `push_plan_timeout_minutes` 默认在 15 分钟后执行最终兜底。图片回调必须原样带回 `task_id`、`sub_task_id`、`image_type` 和 `image_position`；`set_index` 会由系统根据 `sub_task_id` 重新校准。
