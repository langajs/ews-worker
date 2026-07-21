# Shopee 模板更新策略

## 当前契约

- 生效模板：`Shopee_mass_upload_2026-07-21_basic_template.xlsx`
- 前端稳定入口：`/templates/Shopee_mass_upload_current.xlsx`
- 数据区域：`Template!A7:AI`
- 字段数：35
- 分类数：1817
- 物流渠道：5001、5012、50039、50052，默认 50052（SPX）；5012（Trong Ngày）不支持预售

2026-07-21 版本相较 2026-07-20 版本移除了 5000、5004、50053 三个物流渠道列。分类 ID、英文名称和 DTS 范围未变化；尺码表模板移除了 `1304573944 / Accessories`。Shopee 返回的规则显示 `Trong Ngày` 不允许预售商品，系统在保存和导出时自动关闭该渠道。

## 更新分级

1. 模板签名、示例数据或分类行顺序变化：替换稳定入口文件并更新 manifest，不修改业务代码。
2. 下拉选项、物流渠道、价格限制或分类规则变化：同步创建页、Worker 校验、用户说明和 manifest。
3. 字段新增、删除或调序：同步 Worker 的列契约和行构造，前端运行时字段校验会在不一致时阻断导出。

## 更新流程

1. 比较 `Template` 第 1、2、3、4、6 行，以及数据验证区域。
2. 比较物流列、`Pre-order DTS Range`、`Size chart template list` 和隐藏工作表。
3. 更新 `templates/shopee-template.json`，将官方文件复制为 `Shopee_mass_upload_current.xlsx`。
4. 先发布前端模板，再发布 Worker 导出契约；保留上一份日期版文件用于回滚。
5. 使用 SheetJS 读取模板第 3 行，验证列数、列名、起始行和写入后的工作簿结构。

禁止仅按文件名判断兼容性。官方可能在同一天修改模板，版本确认应同时记录文件 SHA-256，并以字段契约和验证规则为准。
