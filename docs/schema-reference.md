# Schema 与字段语义

根 Schema 位于 `schemas/`，采用 JSON Schema 2020-12，并由 Ajv 严格校验。Schema `$id` 使用稳定逻辑地址，不代表业务运行时需要访问该域名；所有 `$ref` 在本地加载。

## 文档 Schema

| Schema | 对象 | 关键身份 |
| --- | --- | --- |
| `canonical-model.schema.json` | 模型本身 | `canonical_id`、`manufacturer_id`、name/family/aliases |
| `provider.schema.json` | API 供应商 | `provider_id`、协议、公开 Base URL、国内访问状态 |
| `offering.schema.json` | provider 对模型的公开 API offering | `offering_id`、`provider_id`、`canonical_id`、`api_model_id` |
| `alias.schema.json` | provider-scoped 或全局别名 | alias、target type/id；支持 alias 链但禁止循环 |
| `catalog.schema.json` | 构建后的聚合目录 | Schema/目录版本和上述四类数组 |
| `manifest.schema.json` | 静态发布入口 | 版本、生成时间、JSON/HTML/CSS/JS/SVG 路径、Content-Type、大小、SHA-256、ETag、缓存和编码描述 |
| `release.schema.json` | 构建版本输入 | 目录/Schema 版本、固定生成时间、最低消费版本 |
| `upstream-config.schema.json` | CI 候选源配置 | HTTPS 来源、格式、Key 环境变量名和响应大小上限 |
| `provider-shard.schema.json` | 构建后的供应商分片 | 单 provider 及其 canonical/offering/alias 子集 |
| `search-index.schema.json` | 轻量检索输出 | 身份、名称、别名、类型、状态、模态、核验状态和同源厂家 logo 路径 |
| `models-dev-candidates.schema.json` | models.dev 2026 上游候选 | 收录时间、候选 offering、厂家 logo 状态与来源；免费/路由/别名路线不进入权威 catalog |
| `models-dev-official-review.schema.json` | models.dev 2026 逐条官方核验侧车 | 已提升直连 offering 的上游 ID、逐条官网证据、官方 API ID/协议（如可确认）和固定 fail-closed 处置 |

所有对象 `additionalProperties: false`。新增字段必须先评审 Schema 和兼容版本，避免上游任意字段悄然进入权威格式。

当前发布契约为 Schema `2.3.0`。`2.0.0` 已允许 manifest 描述 HTML、CSS 和 JavaScript；`2.1.0` 增加 SVG 内容类型、models.dev 候选快照和厂家 logo 资产；`2.2.0` 允许 provider/offering 的 `protocols`、provider `website` 与 `public_base_urls` 显式写为 `unknown`，并在搜索索引增加核验状态与厂家 logo 路径；`2.3.0` 增加按 offering 发布的逐条官方核验侧车，以及区分 API ID、模型身份、不可用路线和未找到合格证据的检索状态。侧车固定为 `keep_fail_closed`，不改变 existing offering 的运行时字段。旧消费端应继续使用最后成功缓存或内置快照，升级解析器后再切换；当前 release 的 `minimum_consumer_schema_version` 为 `2.3.0`。

## 限额

- `max_context_tokens`：一次模型上下文窗口总量。
- `max_input_tokens`：请求输入允许的最大 token；DeepAgent summarization/offloading 读取这一语义。
- `max_output_tokens`：单次生成输出上限。

三者均为正整数或 `unknown`。校验器拒绝已知 input/output 大于已知 context，但不会用减法猜出 input，也不会用 context 代替 input。Embedding 同时在 `embedding.max_input_tokens` 重述专用限制时，两处必须一致。

## 能力三态

Agent 字段固定为：`streaming`、`stream_usage`、`system_message`、`tool_call`、`tool_choice`、`parallel_tool_calls`、`strict_tools`、`structured_output`、`json_schema`。每项都是 `true | false | "unknown"`。

reasoning 包含：

- `supported` 三态。
- `modes`：always on、switchable、effort、budget tokens 或 unknown。
- `effort_values`：官方允许的枚举；未知时显式保留 unknown。
- `budget_tokens`、`interleaved_reasoning` 三态。
- `protocol_fields`：每种协议的实际请求字段；未验证写 unknown。

canonical 记录模型事实，offering 重新声明 provider 实际暴露的能力。消费端使用 offering，不假设 provider 完整暴露 canonical 能力。

协议、官网和公开 Base URL 不是布尔值，但同样不能猜测：缺少可靠资料时分别写为 `"unknown"`。运行时收到 `offering.protocols: "unknown"` 必须拒绝装配，不得选一个“看起来兼容”的协议兜底。当前 models.dev 直连提升记录采用该形式，直到逐字段补入官方证据。

## 采样能力而非业务默认

只有 offering 有 `sampling_parameters`：

```json
{
  "temperature": {
    "supported": true,
    "range": {
      "minimum": 0,
      "maximum": 1,
      "minimum_inclusive": true,
      "maximum_inclusive": true
    },
    "official_default": 1,
    "protocol_mapping": {
      "openai_chat_completions": "temperature"
    }
  }
}
```

`official_default` 是厂商协议事实，不是本系统的默认运行值。Agent Policy、Tenant Deployment Override、System Default 才产生实际值；不设置时让 provider 使用其行为。canonical Schema 不接受 `temperature`、`top_p` 或 `top_k`。

## Embedding

`embedding` 对 Chat model 为 `null`，对 Embedding model 包含默认 `dimension`、`supported_dimensions`、单条最大输入和最大批量。若官方没有可靠区分，字段保持 unknown。dimension/batch 只有在 provider offering 验证后才能进入 Embedding 构造器。

## 生命周期

`release_date`、`last_updated`、`deprecated_at`、`replacement` 在没有直接来源时都为 unknown。状态是 `preview | active | deprecated | retired | unknown`。模型从某个聚合列表消失不等于 retired；只有人工复核官方生命周期后才能变更。

## 证据

每条 evidence 必须包含 source URL/type、retrieved/verified 时间、confidence、redistribution 和 notes。目录不复制文档正文，只记录必要事实与链接。`redistribution=unknown` 不会被悄然提升为允许；生产分发前应按来源矩阵复核条款。

字段级注解覆盖每一个非技术叶节点。`runtime_effective=true` 只能在当前实现确有构造/请求映射时使用；`metadata_only=true` 只用于展示身份/状态；其余字段必须写 `unsupported_reason`。校验器也拒绝注解引用不存在的 evidence。
