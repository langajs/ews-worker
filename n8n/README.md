# Shopee n8n 工作流

本目录中的 JSON 文件可直接导入 n8n。系统配置对应关系：

| 文件 | 系统配置键 | 用途 |
| --- | --- | --- |
| `虾皮标题.json` | `n8n_title_webhook` | 每个子任务生成一个越南语商品标题 |
| `虾皮sku标题.json` | `n8n_sku_title_webhook` | 按子任务和一级规格值顺序生成规格文案 |
| `虾皮主图.json` | `n8n_main_webhook` | 每套生成一张独立封面图 |
| `虾皮附图.json` | `n8n_sub_image_webhook` | 生成第 2~9 张商品附图 |
| `虾皮sku图.json` | `n8n_sku_image_webhook` | 根据一级规格的 `sku_image` 生成变体图 |

Shopee basic template 不包含详情图字段，因此当前不提供详情图工作流。任务中配置的详情图只用于本地打包素材，建议保持数量为 `0`。

导入后需要完成以下配置：

1. 为 DeepSeek 和图片生成 HTTP 节点选择对应的 Header Auth credential。
2. 将每个 Webhook 的 Production URL 填入系统配置页对应字段。
3. 保证工作流“密钥校对”中的值与系统 `callback_secret` 一致。
4. 所有工作流准备完成后，将 `push_primary_images_only` 设为 `false`，系统才会自动派发标题、SKU 标题和 SKU 图计划。

所有工作流均使用 `Respond to Webhook` 显式响应：密钥正确时立即返回 HTTP `202` 和 `{"success":true,"status":"accepted"}`，随后继续执行生成流程；密钥错误时立即返回 HTTP `401` 和 `{"success":false,"retryable":false}`。Worker 收到非 2xx 后会立即把对应推送计划标记为失败并显示原因，不再等待回调超时。更新 JSON 后需要重新导入或同步到 n8n 中，仓库文件不会自动覆盖线上工作流。

商品标题按“主关键词 + 副关键词 + 长尾词 + 属性词”生成，但最终标题不会包含字段括号。新任务的 `variants` 已由系统按一级规格去重，SKU 标题必须返回 `1~20` 个字符，顺序必须是“第 1 套全部一级规格、第 2 套全部一级规格”；系统会把同一标题复用到该一级规格下的全部二级组合。SKU 图也只按一级规格推送一次，二级规格不会增加图片工作流数量；选择“不生成规格图”时不会创建 SKU 图计划。历史 `combination_legacy` 任务继续按完整组合发送，工作流不需要增加平台或模式判断。图片回调必须原样带回 `task_id`、`sub_task_id`、`image_type` 和 `image_position`；`set_index` 会由系统根据 `sub_task_id` 重新校准。
