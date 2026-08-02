# models.dev 2026 候选与厂家 Logo

## 本次快照

`upstream/models-dev-2026.json` 是 2026-08-02 冻结的上游候选快照：从 models.dev 的 `models.json` 中筛选 `created >= 2026-01-01`，得到 **101 条模型/路由记录、29 个 provider ID**。完整快照会随构建发布为 `dist/models-dev-2026.json`，首页的“2026 年新收录候选”区域可以搜索和按厂家筛选。

这里的日期字段命名为 `models_dev_created_at`。models.dev 的聚合 JSON 提供的是目录 `created` 时间戳，而不是厂商的官方 `release_date`；因此页面明确称为“收录候选”，不会把它写入 `catalog/models` 的生命周期事实，也不会据此改变运行时能力。

快照中的每条记录都包含：

- `provider_id`、`api_model_id`、`canonical_slug`、名称和路由类型（直连、免费、路由器、别名）；
- 上游提供的输入/输出模态、context length、最大输出提示和支持参数提示；
- `verification_status: "unverified"` 和 models.dev 来源 URL。

上述能力字段只用于发现和人工复核，不能覆盖 canonical model 或 provider offering。官方来源确认后，维护者才可以在 `catalog/` 中新增事实，并为每个字段补充 evidence 与 field annotation。

## Logo 资产

厂家 SVG 以 `upstream/logos/{provider_id}.svg` 保存，并由构建器复制到 `dist/assets/logos/`，随后进入 manifest、SHA-256、gzip/brotli 和不可变版本路径。当前 29 个 provider 中：

- 12 个使用 models.dev 仓库中同名的 dedicated SVG；
- 5 个使用明确记录在快照中的 provider 映射（例如 `mistralai → mistral`、`qwen → alibaba`、`x-ai → xai`）；
- 12 个没有可用的 models.dev 专属 SVG，使用中性的占位图，`logo_status` 为 `fallback`，不冒充厂家商标。

Logo 来源 URL 和状态都在快照的 `providers[]` 中。models.dev README 说明其 logo 访问路径为 `https://models.dev/logos/{provider}.svg`，仓库中的 SVG 采用 `currentColor`；本仓库把 SVG 作为静态资源内置，浏览器和业务服务器不再请求 models.dev。商标归属和再分发条件仍需在正式发布前由法务复核。

## 同步策略

`npm run sync` 会先运行既有的多源候选同步，再运行 `scripts/sync-models-dev-2026.ts`。后者：

1. 从 `https://models.dev/models.json` 拉取完整 JSON，限制 60 秒超时并以 SHA-256 固定源修订；
2. 只保留 `created >= 2026-01-01`，按稳定键排序，生成上述候选格式；
3. 为有明确源映射的 provider 拉取仓库 SVG；没有专属图形时沿用已审核的占位图；
4. 先在 `.cache/` 暂存、完成 Schema 与 SVG 安全校验，再原子替换 `upstream/`；任何异常都不会覆盖上一次快照；
5. CI 只提交 `upstream/` 候选 PR。候选删除、能力降级、来源冲突仍需人工审核，不能自动发布到权威目录。

运行时消费端仍只请求国内对象存储/CDN 上的 `manifest.json`、`catalog.json` 和分片；没有 models.dev 网络依赖，也不会将 API Key、私有 Base URL 或 tenant override 写入快照。
