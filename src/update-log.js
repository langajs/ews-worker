const RELEASES = Object.freeze([
  {
    version: '2026.07.28',
    date: '2026-07-28',
    status: '已上线',
    title: '分布式 n8n 安装器可靠性修复',
    summary: '修复 Docker 资源不存在时探测命令提前终止的问题，并让空白 Windows 主机自动补齐 Docker 与运行镜像。',
    changes: [
      'Docker Desktop 未运行时由安装器自动启动，并等待 Linux Docker Engine 就绪后继续。',
      'Docker Desktop 缺失时从官方地址下载签名安装器并自动安装；系统要求重启时可重跑同一 CMD 继续。',
      'Docker network、volume、container 和 image 的缺失被视为创建条件，不再因 PowerShell NativeCommandError 提前终止。',
      'n8n 与 Valkey 镜像存在时直接复用，缺失时自动拉取；失败安装已构建的图片服务镜像也会复用。',
      '本地图片服务改用 docker inspect JSON 解析容器网络，并等待 Docker Desktop 恢复容器，避免瞬时误报不存在。',
      '新主机安装器内嵌图片服务源码，自动构建并部署 Valkey、图片 API、图片 Worker，闭合 n8n 图片处理依赖。',
      '安装器固定使用已验收的 n8n 2.25.7，避免 stable 标签漂移导致安装行为变化。',
      '等待 /rest/settings 返回完整 owner 状态后再继续，禁止未初始化却误报部署成功。',
      'owner 密码统一校验为 8-64 位、至少一个大写字母和一个数字。',
      'owner 初始化后增加后置校验，支持中断后重复执行同一 CMD 完成恢复。',
    ],
  },
  {
    version: '2026.07.27',
    date: '2026-07-27',
    status: '已上线',
    title: 'Shopee 图片工作流自动备用',
    summary: '保留主图片服务的完整 HTTP 响应，并在主服务任意失败或超时后自动切换备用模型。',
    changes: [
      'Shopee 主图、附图和 SKU 图工作流统一保留上游状态码、响应头与响应体。',
      '主服务创建失败、查询失败和 900 秒超时均自动切换备用模型；备用服务失败后再进入 Worker 退避重试。',
      '空响应现在明确记录为“图片服务返回空响应 (HTTP 200)”，便于区分上游异常与回调、R2 或队列故障。',
      '新增工作流响应解析回归测试，覆盖过载、正常任务 ID 和空响应三种结果。',
    ],
  },
  {
    version: '2026.07.25',
    date: '2026-07-25',
    status: '已上线',
    title: '模板预售链路与管理员知识库',
    summary: '修正 Shopee 预售物流识别，并建立管理员可见的更新日志、技术栈和实施路线图。',
    changes: [
      '预售物流改为模板名称与解析结果优先，避免店铺上下文中的 channel_id 被错误复用。',
      '创建页直接使用模板 API 的 supports_preorder，不再维护第二套前端硬编码规则。',
      '增加 Pre-order DTS 与物流 On/Off 的 XLSX token 导出回归测试。',
      '新增 update_log 管理员页面，正文通过鉴权 API 动态加载且禁止缓存。',
    ],
  },
  {
    version: '2026.07.25-quick',
    date: '2026-07-25',
    status: '已上线',
    title: '分布式 n8n 一键部署',
    summary: '以 Docker Desktop 和 CMD 安装器完成节点、凭证、工作流及 Cloudflare Tunnel 的快速部署。',
    changes: [
      '一份 CMD 自动创建 Docker network、volume、n8n owner 和 9 个生产工作流。',
      '模型密钥只在浏览器本地注入安装脚本，不通过 EWS API 上传。',
      '用户级 webhook 地址支持将不同用户分流到独立 n8n 节点。',
    ],
  },
  {
    version: '2026.07.22',
    date: '2026-07-22',
    status: '已上线',
    title: 'Shopee 全局模板库',
    summary: '从固定模板转为结构推理、token 注册表和店铺上下文档案。',
    changes: [
      '按 store_context_id 建立全局模板档案，保留当前版本与一个历史对照版本。',
      '自动识别商品工作表、隐藏 token、分类 DTS、物流字段族和类目必填规则。',
      '任务关联模板档案，导出时由 token 适配器写入当前店铺模板。',
    ],
  },
]);

const STACK = Object.freeze([
  { layer: '前端', components: 'Cloudflare Pages、HTML、CSS、Vanilla JavaScript', responsibility: '任务创建、模板管理、任务审计与管理员 Wiki；不持有服务端密钥。' },
  { layer: '边缘 API', components: 'Cloudflare Workers', responsibility: '认证、任务状态机、导出、回调接收、资源调度和用户级并发控制。' },
  { layer: '业务数据', components: 'Cloudflare D1', responsibility: '用户、任务、模板注册表、推送计划、回调队列与图片状态。' },
  { layer: '对象存储', components: 'Cloudflare R2、S3 兼容接口', responsibility: '店铺模板、用户上传资源、生成图片和打包下载对象。' },
  { layer: '异步调度', components: 'Cloudflare Queues、Cron Triggers', responsibility: '回调持久化、图片任务消费、卡死恢复和 72 小时任务清理。' },
  { layer: 'AI 工作流', components: 'n8n、用户级 Webhook', responsibility: '商品元数据与图片工作流；按用户绑定节点实现水平分流。' },
  { layer: '图片处理', components: 'Fastify、BullMQ、Valkey、Sharp', responsibility: '单主机异步处理、限流、PNG/JPEG 处理和 R2 直传。' },
  { layer: '表格适配', components: 'fflate、fast-xml-parser、结构推理、token 注册表', responsibility: '解析 XLSX 隐藏结构并按店铺模板生成可上传文件。' },
]);

const TEMPLATE_FLOW = Object.freeze([
  { step: '上传', detail: '校验 XLSX ZIP 结构、文件大小、危险条目和官方模板上下文。' },
  { step: '推理', detail: '扫描工作表并定位 token 行、说明行、数据起始行、分类表和敏感工作表。' },
  { step: '注册', detail: '保存字段语义、列位置、必填性、物流能力、分类 DTS 和 schema hash。' },
  { step: '创建', detail: '任务只提交商品事实和交易参数，服务端校验 Category ID、DTS 范围及模板物流能力。' },
  { step: '生成', detail: 'n8n 仅负责 AI 外部调用；Worker 根据任务 ID 调度并接收通用回调。' },
  { step: '导出', detail: '商品语义数据映射到模板 token，Pre-order DTS 写入数字单元格，物流逐列写入 On/Off。' },
]);

const TEMPLATE_AUDIT = Object.freeze([
  { severity: '已修复', title: '预售物流存在双重判定', detail: '前端曾按固定 ID 推断预售能力，可能与店铺模板实际物流名称不一致。现统一采用后端模板解析结果。' },
  { severity: '已修复', title: '旧模板能力标记可能过宽', detail: '历史 manifest 中部分普通物流被存为支持预售。运行时会按物流名称重新计算，不再信任旧布尔值。' },
  { severity: '已验证', title: 'Pre-order DTS token 写入正常', detail: '工作区 11 份店铺 Basic Template 均识别到该 token，列位置会随模板变化；导出适配器均写入对应列。' },
  { severity: '持续观察', title: '平台仍可能调整店铺模板', detail: '未知必填 token 会阻止模板启用；未知可选 token 保留为空并在模板管理页提示。' },
]);

const ROADMAP = Object.freeze([
  { priority: 'P0', status: '进行中', title: 'Shopee 导出样本验收集', detail: '为不同店铺模板保留匿名结构样本，覆盖预售、二维规格、SKU 图和动态物流列。' },
  { priority: 'P1', status: '计划中', title: '模板兼容性遥测', detail: '汇总未知 token、解析失败阶段和 schema 变化，不记录模板私有值。' },
  { priority: 'P1', status: '计划中', title: '导出审计快照', detail: '记录任务导出时使用的模板版本、字段数量与校验摘要，便于定位平台拒绝原因。' },
  { priority: 'P2', status: '计划中', title: '节点健康度与容量看板', detail: '聚合用户 webhook 节点的排队深度、回调耗时和图片处理吞吐。' },
]);

export function getUpdateLogWiki(audit = {}) {
  return {
    version: RELEASES[0].version,
    updated_at: '2026-07-28T10:00:00+08:00',
    title: '更新日志与技术栈',
    subtitle: '记录线上能力、模板系统审计结论、实现边界和接下来的工程更新。',
    audit: {
      active_profiles: Number(audit.active_profiles || 0),
      current_versions: Number(audit.current_versions || 0),
      preorder_ready_profiles: Number(audit.preorder_ready_profiles || 0),
      preorder_products: Number(audit.preorder_products || 0),
      last_template_update: audit.last_template_update || '',
    },
    releases: RELEASES,
    stack: STACK,
    template_flow: TEMPLATE_FLOW,
    template_audit: TEMPLATE_AUDIT,
    roadmap: ROADMAP,
  };
}
