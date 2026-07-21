# Shopee 全局模板库适配策略

## 运行原则

系统不内置固定 Shopee 导出模板，也不按文件名、工作表名称、日期或固定行列定位字段。用户上传对应店铺从 Seller Centre 下载的最新 `Basic Template`，Worker 通过“结构推理 + token 注册表”保存并立即共享结构有效的版本。

高级模板不作为当前运行时导出载体。如果未来需要类目专属属性，应单独增加高级属性模板或 Open API 适配，不向基础模板伪造不存在的列。

## 全局档案

- `ews_shopee_template_profiles`：按 `UNIQUE(market, store_context_id)` 保存全局档案，默认编码为 `SHP-VN-{store_context_id}`。
- `ews_shopee_template_versions`：每个档案只保存当前版本和最多一个上一版本，记录上传用户、R2 Key、SHA256、语义指纹、启用状态和风险标记。
- `ews_shopee_template_user_meta`：保存每个用户自己的别名、备注和收藏，不修改全局辨识信息。
- `ews_shopee_template_fields`：保存 token、数据类型、必填性、语义映射和映射状态。
- `ews_groups` 与 `ews_shopee_template_groups`：用户归属单一分组，模板可关联多个分组；现有用户与模板迁移到“默认分组”。

模板元数据中的 D2 仅命名为 `store_context_id`。现有证据只能确认它是店铺模板上下文，不能宣称为 Shopee 官方 Shop ID。

模板显示名称优先级为“我的别名” > “全局别名” > `SHP-VN-{store_context_id}`。全局别名复用档案的 `system_name` 存储，由管理员维护；用户别名继续保存在 `ews_shopee_template_user_meta`，按登录用户隔离。

## 结构推理

Worker 使用 `fflate` 解压并通过 `fast-xml-parser` 完成以下步骤：

1. 扫描全部工作表，寻找同时包含 `ps_product_name`、`ps_price`、`ps_weight` 的隐藏 token 锚点。
2. 依据店铺上下文元数据完整度区分正式商品页和 Upload sample，不固定依赖 `Template` 名称。
3. 推导元数据、显示名称、必填规则、说明、限制和数据起始行。
4. 识别 `channel_id.{channel_id}`、`ps_product_global_attribute.{attribute_id}`、`ps_item_image_*` 等字段族，并从 token 注册表获得系统语义。
5. 从各工作表的数值密度和相邻文本推断 Category ID、分类路径和 DTS 范围。
6. 对所有工作表的单元格内容进行规范化并计算指纹，覆盖官方签名、字段规则、分类/DTS、物流、隐藏映射和店铺私有隐藏表；原始比较内容不落库。与当前版本一致时返回“模板已是最新，无需更新”，不新增版本记录或 R2 对象；与上一版本一致时返回 `409 SHOPEE_TEMPLATE_ROLLBACK_BLOCKED`，阻止旧版重新成为当前版。
7. 区分 `Mandatory`、`Conditional Mandatory` 和 `Optional`；对 `HiddenCatProps` 中的类目级 `MANDATORY` 关系建立约束，避免把全部条件必填字段误判为全局必填。
8. 未知可选 token 留空并警告；未知必填或无法解释的条件必填 token 直接拒绝上传，避免保存无法安全导出的版本。

## 高级模板语料预识别

`Shopee_mass_upload` 中的 28 份 Advanced Template 仅用于扩充 token 注册表和回归解析器，不作为任务导出的工作簿。样本覆盖 28 个类目域、1563 个全局属性 ID，全部属性列都遵循 `ps_product_global_attribute.{attribute_id}`，另有稳定字段 `ps_brand`。属性 ID、类目 ID 和模板元数据 D2 的 `store_context_id` 是三种独立标识，未知 token 不代表未知店铺。

系统遇到未见过的 `store_context_id` 时，会创建新的全局模板档案；字段则按稳定 token、字段族和隐藏类目规则匹配，不依赖预先登记店铺 ID。新属性 ID 可以通过字段族自动识别，真正未知的无条件必填字段仍会被拒绝。

缺少官方隐藏 token、结构损坏、宏、外部链接、嵌入对象或非 `basic` 类型的文件直接拒绝，不能按可见列名猜测导出。

## 私有数据

解析器检查 `HiddenShopBrand` 和 `HiddenTax`。任一工作表存在非空单元格时，版本记录 `has_sensitive_data` 和工作表风险摘要，但不阻塞自动启用；管理员可在独立模板管理页查看风险标记。原始 XLSX 不提供公共下载端点，只能由任务导出流程在 Worker 内部读取。

## 权限与维护

- 普通用户只读取所属分组关联的已启用档案；管理员可以读取全部档案，并在系统配置中维护模板的多分组范围。
- 用户成功上传新模板、当前重复模板或并发完成的同一模板后，系统自动把档案关联到上传者当前分组；同一档案可被多个分组共用。
- 任意登录用户都可上传同一上下文的新版模板，但个人别名、备注和收藏仍按用户隔离。
- 分组停用后，组内普通用户的现有 Token 立即失效且无法重新登录；管理员账号不受所属分组停用影响，以保留系统恢复入口。
- 档案不设创建者维护权；当前有效版本的 `uploaded_by` 是唯一对外展示的“最近更新者”。`created_by` 仅作为历史内部字段保留，不参与权限判断。
- 创建档案时仍使用 `INSERT OR IGNORE` 保证 `UNIQUE(market, store_context_id)`，并发上传不会产生重复档案。
- 用户私有别名、备注和收藏仍按用户隔离，不视为修改全局模板。

## 导出流程

1. 任务关联 `template_profile_id`，并记录创建时 `template_version_id` 供审计。
2. 任务只保存商品、SKU、图片和物流等语义数据，不保存 Excel 列号。
3. 导出默认读取档案当前最新版；模板更新后历史任务同样跟随当前版本，过旧的 `template_version_id` 会在裁剪时重绑到当前版本。
4. Worker 将数据库中的 token 映射合并到 manifest，再按语义字段向推导出的数据起始行写入。
5. 其他 ZIP/XML 内容原样保留，包括 `dataValidations`、工作表保护和隐藏工作表。

上传内容发生变化时，新文件立即成为当前版本，刚替换下来的版本作为唯一的上一版本用于管理员校对；更早版本的字段、分类、版本记录和 R2 文件立即清理。比较说明由当前与上一版本实时计算，不增加比较表。管理员删除仍采用软删除；只有软删除超过 30 天且无任何任务引用时，才允许彻底清理整个档案。

## 更新验收

- 使用多个店铺模板验证工作表名称、字段数和物流数变化时仍能定位结构。
- 比较原始与导出文件的 ZIP 条目、`dataValidations`、`sheetProtection` 和隐藏工作表。
- 验证同一 `store_context_id` 全局唯一、SHA256 去重、版本切换和用户备注隔离。
- 验证当前版 A、上一版 B 交叉上传时，A 返回无需更新，B 返回回退冲突且不写入 D1/R2。
- 验证未知必填 token 被拒绝，私有隐藏数据只产生风险标记且有效版本立即启用。
- 验证任意登录用户都能更新已有档案、上传后自动归组，并发上传同一上下文只产生一个全局档案。
- 验证普通用户无法读取其他分组模板，管理员可多分组分配；分组停用后普通用户立即无法认证。
- 使用当前店铺实际模板上传 Shopee，验证物流渠道、分类和图片 URL。
