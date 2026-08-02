# 国内可访问的公开大模型能力目录

本仓库维护供应商中立、版本化、机器可读的公开模型能力事实，并生成可直接发布到国内对象存储/CDN 的静态 JSON 和同源浏览界面。打开 CDN 根地址即可搜索和查看模型详情；运行时不依赖数据库，也不直接访问 GitHub、models.dev、LiteLLM 或国外厂商站点。

> 当前为首个目录版本。参见[架构说明](docs/architecture.md)、[浏览界面](docs/web-ui.md)、[Schema 语义](docs/schema-reference.md)、[候选来源矩阵](docs/source-matrix.md)、[models.dev 2026 候选与 Logo](docs/models-dev-2026.md)、[国内部署](docs/deployment-cn.md)、[现有项目审计与集成边界](docs/audit-and-integration.md)和[维护流程](docs/operations.md)。

## 快速开始

```bash
npm ci
npm run validate
npm run build
npm test
npm run preview
```

本地打开 `http://127.0.0.1:4173/` 可浏览目录。生产环境把 `dist/` 整体发布到对象存储/CDN，并将 `index.html` 配置为目录根路径的默认文档。浏览器和业务消费端都先读取 `manifest.json`；目录版本未变化时不下载完整目录，业务消费端不可用时回退到 `snapshots/catalog.json`。

生成物同时服务两类消费者：

- 人员访问 CDN 根地址，通过纯静态页面搜索、筛选并查看字段级详情。
- 程序从 `manifest.json`、`catalog.json` 或 provider 分片读取机器可验证的 JSON。

## 数据边界

- `catalog/models/`：canonical model，描述模型本身的能力事实。
- `catalog/providers/` 与 `catalog/offerings/`：供应商公开 API 标识、协议、限制和状态。
- `catalog/aliases/`：公开别名映射；私有模型标识应由租户部署 override 映射。
- `upstream/models-dev-2026.json`：models.dev 2026 收录快照和厂家 Logo 元数据。其直连记录可经显式、可重复的人工提升进入目录，但始终保留低置信度来源和 `unknown` 运行时能力；免费、路由和别名记录只留在上游浏览区。
- `catalog/reviews/models-dev-2026.json`：79 条已提升的 models.dev 直连记录的逐条官方核验侧车。它记录官网证据、官方 API ID（如有）和 `keep_fail_closed` 处置，不会自动改写 canonical、offering 或运行时参数。
- `dist/search-index.json#models_dev_sync`：随轻量索引发布的本次上游收集时间、逐条核验时间、来源修订和快照哈希；可作为下一次增量收集/复核的比对基线。
- `upstream/logos/`：随 CDN 发布的 SVG 厂家图标；缺少可靠源时使用明确标记的中性占位图。
- API Key、私有 Base URL、环境、权重和负载均衡等 tenant deployment 数据禁止进入本仓库。
- `temperature`、`top_p`、`top_k` 只记录供应商 offering 是否支持、范围、官方默认值和协议映射，不保存业务默认运行值。

## 常用命令

```bash
npm run validate          # Schema、引用、证据、唯一性、别名和安全校验
npm run build             # 确定性生成 dist/ 与内置快照
npm run preview           # 构建并在本机启动纯静态预览（仅开发用途）
npm run promote:models-dev-2026 # 显式提升当前冻结快照的直连记录（不会由 CI 自动执行）
npm run review:models-dev-2026  # 根据已人工复核的官网证据确定性生成逐条核验侧车
npm run check:determinism # 连续构建并比较全部字节和哈希
npm run probe -- <URL>    # 探测国内静态目录（也可用环境变量）
npm run publish -- --help # 生成/执行对象存储同步计划
npm run check             # lint、typecheck、测试、校验和确定性构建
```

## 初始覆盖

当前目录保留 FDE 默认值和契约测试出现的四类已核验配置：GPT-5.5（聊天）、GLM-5.2（推理/工具）、GLM-4.6V（多模态）和 Embedding-3。另有 models.dev 冻结快照中的 79 条直连记录，以低置信度“上游观测”形式进入 canonical/provider/offering 三层；它们的协议、端点、采样、Agent 与推理能力均为 `unknown`，不能作为可调用或可用性承诺。每条直连记录均有独立的官方核验侧车，页面会明确区分“API 标识已核验”“模型已核验”“官方路线不可用”和“未找到合格官方证据”；无论结论为何，侧车均保持 fail-closed，不能绕过现有运行时契约。

完整的 models.dev 2026 快照仍保留 101 条收录/路由记录和 29 家厂家的机器可读数据；浏览界面下方仅显示未进入主目录的 22 条免费、路由器或别名路线，避免与上方目录重复。主目录卡片和详情页复用同源 SVG 厂家标识。`created` 只表示上游目录收录时间，不等同于官方发布日期；详情见[同步说明](docs/models-dev-2026.md)。
