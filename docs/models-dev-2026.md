# models.dev 2026 收录、提升与厂家 Logo

## 冻结快照与边界

`upstream/models-dev-2026.json` 是 2026-08-02 冻结的上游快照：从 models.dev 的 `models.json` 中筛选 `created >= 2026-01-01`，得到 **101 条模型/路由记录、29 个 provider ID**。完整快照随构建发布为 `dist/models-dev-2026.json`；页面下方的“2026 年未纳入目录的上游路线”区域只显示未出现在主目录的记录，可按厂家和名称浏览。

`models_dev_created_at` 是 models.dev 目录的收录时间，**不是**厂商官方 `release_date`。因此任何由此快照提升的 canonical 和 offering 都将生命周期发布日期保留为 `unknown`；不从收录时间推导状态、弃用时间或替代项。

## 收集与核验批次

为便于后续增量更新，轻量 `search-index.json` 的 `models_dev_sync` 固定带有以下批次元数据，并在首页目录统计中显示前两项：

- `collected_at`：本次从 models.dev 收集并冻结候选快照的时间，来自 `upstream/models-dev-2026.json.source.retrieved_at`。
- `reviewed_at`：本次逐条官方核验侧车生成的时间，来自 `catalog/reviews/models-dev-2026.json.reviewed_at`；每条记录也保留各自的 `reviewed_at`。
- `source_revision` 与 `source_snapshot_sha256`：用于确认下一次同步和核验是否针对同一上游修订/冻结快照。
- `direct_offering_count`：本次被逐条核验的已提升直连 offering 数量。

增量同步时，先比较新旧 `source_revision`、`collected_at` 和候选快照哈希；只有候选发生变化才生成待审差异。重新核验后再更新 `reviewed_at` 和受影响记录的单条时间，避免把旧结论误当作新快照的结论。

快照中的每条记录包含：

- `provider_id`、原样 `api_model_id`、`canonical_slug`、名称和路线类型（直连、免费、路由器、别名）；
- 上游提供的输入/输出模态、context length、最大输出和参数提示；
- `verification_status: "unverified"` 与 models.dev 来源 URL。

## 本次显式提升

本版本把快照中 **79 条 `route_kind: "direct"` 记录**显式提升到 `catalog/models/` 和 `catalog/offerings/`；缺失的厂家同时生成 `catalog/providers/`。它们不是自动同步结果：生成器只有在维护者运行 `npm run promote:models-dev-2026` 时才写入目录，CI 的 `npm run sync` 永远只修改 `upstream/`。

提升记录使用以下安全规则：

- `canonical_id` 使用上游 `canonical_slug`；`api_model_id` 原样保存上游 namespaced 标识，并在字段注解中声明它不是已核验的实际请求模型 ID。
- 上游 `context_length` 只映射到 `max_context_tokens`，上游最大完成量只映射到 `max_output_tokens`；绝不推导 `max_input_tokens`。
- 输入/输出模态作为低置信度上游观测保存；`release_date`、官方网站、公开 Base URL、国内可访问性、鉴权、协议、Agent 能力、推理能力、Embedding 和采样支持都保持 `unknown`。
- 所有提升文档的 evidence 都是 `source_type: "upstream_aggregator"`、`confidence: "low"`。没有任何 `runtime_effective: true` 字段。
- `offering.protocols: "unknown"` 时，`src/runtime.ts` 会拒绝 Chat/Embedding 装配；即使 Agent Policy 提供 `temperature`、`top_p`、`top_k` 也不会发送。
- 免费、路由器和别名路线不生成 canonical 或 offering，仍只显示在上游区，避免把一个路由当成模型或厂商 API。

页面通过 `provider_id + canonical_slug + api_model_id` 与主目录 offering 精确比对；已提升的 79 条直连记录只在主目录显示，不在下方上游区重复渲染。当前下方区域保留 22 条未纳入目录的路线。

提升脚本只创建缺失的模型、offering 和 provider 文档；已有且不同的 model/offering 会失败，已有 provider（例如 OpenAI）保留原有官方资料，不能被聚合源覆盖。随后必须运行完整校验、构建和人工评审。

## 逐条官方核验

本版本已对 **79 条 `route_kind: "direct"` 记录逐条建立核验结论**。源文件为 `catalog/reviews/models-dev-2026.json`，构建后以 `dist/reviews/models-dev-2026.json` 发布；它与冻结候选快照的 SHA-256 绑定，校验器要求每个已提升直连 offering 恰好有一条记录。浏览界面只在打开该 offering 的详情时按 manifest 下载此侧车，并显示逐条官网链接、核验时间和结论。

每一条核验以 **provider offering** 为单位，而不是按名称或模型家族批量推断。可用结论如下：

- `official_api_verified`：官方文档/API 确认模型身份和实际 API ID；若官方资料同时明确协议，才记录协议。
- `official_model_verified`：官方来源确认模型本身，但没有足够资料把它提升为可调用的 API offering。
- `official_route_unavailable`：官方说明该路线已不可用，或它只是请求速度/配置变体而非独立模型 ID。
- `official_evidence_not_found`：截至核验日没有找到可复现的精确名称/API ID 官方映射。这不是“模型不存在”的断言。

核验侧车不是新的运行时配置来源。所有记录都固定为 `runtime_disposition: "keep_fail_closed"`：它不会自动修改低置信度 canonical/offering 的 `api_model_id`、`protocols`、限额、采样、Agent 或推理字段，也不会自动向构造器发送任何参数。即使状态为 `official_api_verified`，后续要把某个字段接入租户配置，仍必须在独立目录变更中完成：

1. 将官方证据和精确字段写入 canonical/provider/offering；
2. 更新该字段的 `field_annotations`，明确 `runtime_effective`、`adapter_mapping` 或 `unsupported_reason`；
3. 新增 ChatOpenAI、ChatAnthropic、Embedding 或 DeepAgent 的构造器映射与契约测试；
4. 经人工审核后，才允许运行时使用该字段。

核验生成器不发网络请求；维护者先人工确认官网资料和结论，再运行：

```bash
npm run review:models-dev-2026
npm run validate
```

这样可使静态核验清单、来源快照哈希和 UI 结论在本地、CI 与国内 CDN 上完全可重复。

## Logo 资产与页面关联

厂家 SVG 以 `upstream/logos/{provider_id}.svg` 保存，并由构建器复制到 `dist/assets/logos/`，随后进入 manifest、SHA-256、gzip/brotli 和不可变版本路径。当前 29 个 provider 中：

- 12 个使用 models.dev 仓库中同名的 dedicated SVG；
- 5 个使用明确记录在快照中的 provider 映射（例如 `mistralai → mistral`、`qwen → alibaba`、`x-ai → xai`）；
- 12 个没有可用的 models.dev 专属 SVG，使用中性的占位图，`logo_status` 为 `fallback`，不冒充厂家商标。

构建时 `search-index.json` 为每个 offering 写入 `manufacturer_logo`（同源 `assets/logos/*.svg` 或 `null`）和 `verification_status`。主目录卡片与模型详情页都读取这个路径显示厂家标识；页面不会向 models.dev、GitHub 或厂商站点请求图片。Logo 来源 URL、映射关系和状态仍保留在快照 `providers[]` 中，商标归属和再分发条件需在正式发布前由法务复核。

## 同步与复核策略

`npm run sync` 会先运行既有的多源候选同步，再运行 `scripts/sync-models-dev-2026.ts`。后者：

1. 从 `https://models.dev/models.json` 拉取完整 JSON，限制 60 秒超时并以 SHA-256 固定源修订；
2. 只保留 `created >= 2026-01-01`，按稳定键排序，生成上述候选格式；
3. 为有明确源映射的 provider 拉取仓库 SVG；没有专属图形时沿用已审核的占位图；
4. 先在 `.cache/` 暂存、完成 Schema 与 SVG 安全校验，再原子替换 `upstream/`；任何异常都不会覆盖上一次快照；
5. 只创建 `upstream/` 变更 PR。候选删除、能力降级、来源冲突仍需人工审核，绝不自动重写已发布目录。

当需要提升新直连记录时，维护者先审查快照和官方资料，再单独运行：

```bash
npm run promote:models-dev-2026
npm run check
```

聚合源字段只能作为低置信度观测存在；只有官方文档/API/模型卡足以说明语义时，维护者才能将对应字段从 `unknown` 提升，并同时更新 evidence、field annotation 和运行时契约测试。

运行时消费者始终只请求国内对象存储/CDN 上的 `manifest.json`、`catalog.json` 和分片；没有 models.dev 网络依赖，也不会将 API Key、私有 Base URL 或 tenant override 写入快照。
