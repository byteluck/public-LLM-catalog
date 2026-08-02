# 维护、同步与发布流程

## 目录版本

- `schema_version` 遵循语义化版本。破坏消费者解析的字段变更升级 major；向后兼容新增升级 minor。
- `catalog_version` 格式为 `YYYY.MM.N`。任何会改变 `dist/` 字节的源数据修改都必须使用新版本。
- `generated_at` 是发布元数据输入，不由构建脚本取当前时钟。只有准备新目录版本时才人工更新为 UTC 时间。
- `minimum_consumer_schema_version` 用于阻止旧消费端读取无法理解的新目录。

同一输入不得因为重跑 CI 改变时间、顺序、压缩字节或哈希。`npm run check:determinism` 在两个临时目录连续构建并比较完整文件树；`check:generated` 防止提交源数据后忘记刷新 `dist/` 与快照。

## 新增或更新模型

1. 在 `catalog/models/` 更新模型本体，在 `catalog/offerings/` 更新 provider 暴露事实；不要复制某个上游完整对象。
2. 能确认的事实增加官方 evidence；不能确认的字段写 `unknown`。
3. 为每个事实叶节点补 `field_annotations`，说明当前运行时影响、adapter 映射或缺口原因。
4. 采样参数只改 offering 的支持/范围/官方默认/协议映射，不在 canonical 写业务值。
5. 更新 alias 时先确定 provider scope，避免跨供应商歧义。
6. 升级 `catalog/release.json` 的目录版本和生成时间。
7. 执行 `npm run validate && npm run build && npm run check`。
8. PR 人工检查来源冲突、能力降级、模型删除/替代、许可和国内可访问性。

## 自动上游同步

每周 workflow 运行 `npm run sync`：

- models.dev、LiteLLM 等聚合源只输出标准化候选。
- `scripts/sync-models-dev-2026.ts` 另外冻结 `created >= 2026-01-01` 的 models.dev 候选和厂家 logo；同步结果仍停留在 `upstream/`，不自动提升为 canonical/offering。
- 需要 Key 的官方模型列表从 CI Secret 读取；未配置 Key 时跳过并保留旧候选。
- 限制每个响应大小和超时，所有待写结果计算完成后再原子替换。
- `upstream/review.json` 标出与当前权威目录冲突、能力退化、限额下降和候选删除。
- 自动化分支只提交 `upstream/`，不会生成或提交 `catalog/`、`dist/`。

维护者随后回到官方来源逐字段复核，手工形成独立目录 PR。不能在同步 PR 上把 candidate 自动提升为权威事实。当前已提升的 2026 直连记录是例外的、显式执行的低置信度观察导入：运行 `npm run promote:models-dev-2026` 仅创建缺失文档，并把协议/端点/运行时能力保留为 `unknown`；它仍需要独立审查和完整契约测试，不能替代官方复核。

## 冲突策略

| 情况 | 动作 |
| --- | --- |
| 聚合源与官方文档冲突 | 保持官方已验证值；记录冲突，等待官方澄清 |
| 两个官方页面冲突 | 保持现有已发布版本；在 PR 标 `unknown` 或采用更具体、更新且语义一致的页面，必须人工说明 |
| `true` 变 `false` | 视为能力降级，阻断自动提升并评估消费端影响 |
| token 限额下降 | 阻断，核对 context/input/output 是否被上游混用，并准备租户迁移诊断 |
| 模型从列表消失 | 不删除；核对 lifecycle 公告，先标 deprecated/replacement，再单独审核 retired |
| 上游超时/无效 JSON/超限 | 同步失败且不改候选；已发布目录完全不受影响 |

## CI 与发布责任

- `ci.yml`：每个 PR 执行 lint、typecheck、测试、源校验、确定性、生成物一致性和 `git diff --check`。
- `sync-upstreams.yml`：只创建候选变更 PR。
- `publish.yml`：production environment 人工批准后上传；manifest 最后写；随后由国内 self-hosted runner 探测。

建议在仓库保护规则中要求 CI、至少一名目录维护者和一名运行时维护者批准；生命周期删除、能力降级和 Schema major 变更再增加专门审批人。

## 发布检查表

- [ ] 所有新增事实有字段级官方来源，未知未被写成 false。
- [ ] 仓库所有者已批准本项目发布许可，并逐来源复核归属/再分发要求；不得由自动化擅自选择许可证。
- [ ] canonical 中没有 temperature/top_p/top_k 业务默认值。
- [ ] 租户 Key、私有 URL、环境、NAT、权重和负载均衡没有进入 catalog/dist/snapshot。
- [ ] 每个新增 runtime-effective 字段有 adapter mapping 和契约测试。
- [ ] `npm run check`、`git diff --check` 全部通过。
- [ ] `catalog_version` 未复用已有不同内容。
- [ ] 国内对象存储版本对象先上传，manifest 最后上传。
- [ ] CDN prefix 根路径返回 `index.html`，HTML/CSS/JS Content-Type 正确且没有境外运行时资源。
- [ ] `models-dev-2026.json` 与厂家 SVG 的 Content-Type、哈希、不可变路径和占位 logo 状态均通过 probe。
- [ ] 至少一个国内 runner 的完整 probe 通过。
- [ ] 回滚版本和内置快照已确认可用。
