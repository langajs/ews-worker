# Shopee n8n 工作流

本目录中的 JSON 文件可直接导入 n8n。系统配置对应关系：

| 文件 | 系统配置键 | 用途 |
| --- | --- | --- |
| `虾皮标题.json` | `n8n_title_webhook` | 每个子任务生成一个越南语商品标题 |
| `虾皮sku标题.json` | `n8n_sku_title_webhook` | 按子任务和变体顺序生成一级规格值 |
| `虾皮主图.json` | `n8n_main_webhook` | 每套生成一张独立封面图 |
| `虾皮附图.json` | `n8n_sub_image_webhook` | 生成第 2~9 张商品附图 |
| `虾皮sku图.json` | `n8n_sku_image_webhook` | 根据 `sku_image` 生成变体图 |

Shopee basic template 不包含详情图字段，因此当前不提供详情图工作流。任务中配置的详情图只用于本地打包素材，建议保持数量为 `0`。

导入后需要完成以下配置：

1. 为 DeepSeek 和图片生成 HTTP 节点选择对应的 Header Auth credential。
2. 将每个 Webhook 的 Production URL 填入系统配置页对应字段。
3. 保证工作流“密钥校对”中的值与系统 `callback_secret` 一致。
4. 所有工作流准备完成后，将 `push_primary_images_only` 设为 `false`，系统才会自动派发标题、SKU 标题和 SKU 图计划。

商品标题按“主关键词 + 副关键词 + 长尾词 + 属性词”生成，但最终标题不会包含字段括号。SKU 标题必须返回 `1~20` 个字符，顺序必须是“第 1 套全部变体、第 2 套全部变体”。图片回调必须原样带回 `task_id`、`sub_task_id`、`image_type` 和 `image_position`；`set_index` 会由系统根据 `sub_task_id` 重新校准。
