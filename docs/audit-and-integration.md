# 现有项目参数审计与集成计划

## 审计基线

2026-08-02 重新读取了要求中的全部文件和 `LlmConfig/` 目录；三个现有仓库均未修改。审计以读取时 HEAD 为准：

| 仓库 | HEAD | 必读范围 |
| --- | --- | --- |
| `baiteda-app` | `11a5b04316ae106a04d63156cae3fb1c36d07657` | `SystemLlmModelPo.java`、`LlmModelPublicCatalogService.java`、模型保存 DTO/VO 与保存逻辑 |
| `fses-design-mono` | `c88e5def41856e42449d52ed6d1b05e6fab09d12` | `开发要求.md`、`model-runtime.ts`、`create-agent.ts` |
| `pro-lowcode-platform-front` | `aebd62c62b8bbf7b282869d4f972375c13ec8946` | `src/views/LlmConfig/` 全目录 |

FDE 这三个必读文件从先前审计点 `c7be767a...` 到当前 HEAD 没有差异；目录证据记录为本次最后复核到的当前 HEAD。初始模型集合来自 FDE 当前默认值和运行时契约测试：`gpt-5.5`、`glm-5.2`、`glm-4.6v`、`embedding-3`，分别覆盖默认聊天、推理工具、多模态视觉和 Embedding 配置形态。

`LlmConfig` 的创建模型联动已进一步细化为[目录绑定与租户 deployment 设计](llm-config-integration.md)。当前入口虽然存在，但后端仍直接访问 models.dev/GitHub，且选择后没有持久化 catalog identity 和版本；目标方案改为前端从可配置的公司 CDN/客户内网地址读取静态目录，删除后端目录搜索链路，只让模型保存接口接收经过白名单校验的绑定与可选能力快照。

## 当前参数差距矩阵

| 现有字段/行为 | baiteda 存储或下发 | FDE 当前行为 | 分类 | 结论 |
| --- | --- | --- | --- | --- |
| `model` | PO、Save DTO、Detail/Resource VO | `model`/`model_name` 被解析并进入 `ChatOpenAI.modelName` 或 `ChatAnthropic.modelName` | 运行时有效 | 语义应明确为 `api_model_id`；canonical/offering 身份另存，不能按名称推能力 |
| `api_protocol` | PO、DTO/VO、前端必填 | 归一成 `openai`/`anthropic`，决定构造哪个 Chat adapter；OpenAI Base URL 还会补 `/v1` | 运行时有效 | 改成目录协议枚举，区分 chat completions、responses、anthropic messages、embeddings |
| `env_endpoints` 内 URL/Key/env | PO 私有 JSON、详情/默认配置按权限返回 | 按运行环境选端点，URL/API Key 进入构造器 | 运行时有效、tenant deployment | 必须留在租户系统；永不进入公开目录。权重字段被 FDE 解析结构接收但未用于选择 |
| `max_tokens` | PO、DTO/VO、前端编辑 | 进入两个 Chat adapter 的 `maxTokens` | 运行时有效 | 更名/定义为 `max_output_tokens`；发送前必须与 offering 上限校验 |
| `max_context_tokens` | PO、DTO/VO、前端编辑 | 被直接写成 `model.profile.maxInputTokens` | 运行时有效但语义错误 | context 包含输入/输出，不等于输入预算；新增独立 `max_input_tokens`，不得回退混用 |
| `function_call` | 单一枚举：Unsupported / CallSupported / StreamCallSupported | chat/multi 角色必须为 `stream`；同时检查 adapter 是否有 `bindTools` | 运行时准入有效 | 只能保留为兼容派生字段，不能代表完整工具能力 |
| `type` | Chat / Multi / Embeddings | chat 允许 Chat/Multi，视觉角色只允许 Multi；Embeddings 对 Chat 角色会被拒绝 | 运行时准入有效 | 当前 FDE 没有构造 `OpenAIEmbeddings`，Embedding 仅配置、未运行 |
| `dimension` | PO、DTO/VO、前端仅 Embeddings 必填 | `PlatformModelPayload` 不读取，Chat 工厂不消费 | 已存储但不生效 | 接入独立 Embedding factory 后映射到 `OpenAIEmbeddings.dimensions` 并校验可选维度 |
| `temperature`、`top_p` | PO、Save/Detail/Resource VO 存在；当前前端保存时固定为 `null` | `PlatformModelPayload` 不读取，两个构造器不消费 | 已存储/下发能力存在但不生效 | 必须重定义为 tenant override；通过三层策略合并和 capability 过滤后才映射构造器 |
| `is_reason_model` | PO、DTO/VO、前端强制二选一 | 只进入 safe metadata 和诊断日志，未进入 Chat 构造器/请求 | 展示/诊断元数据 | 单一布尔不足；需 reasoning mode、effort、budget、interleaved 和协议字段映射 |
| `name`、`description`、`code` | PO/视图与搜索 | `name` 可作 model 的兼容回退；`code/id` 只作平台资源身份和缓存/日志字段 | 主要为身份/展示 | 与 canonical name、API model ID、租户资源 ID 分开 |
| `strategy` | PO；前端固定 WeightedRoundRobin | 必读的 FDE 解析/构造不读取 | 已存储但未进入 Agent | 负载均衡属于 tenant deployment，由 baiteda 在返回单端点前执行，或向 FDE 提供明确策略实现 |
| `network_type`、`nat_info` | PO；前端固定 Internet/NAT null | FDE 不读取 | 租户部署元数据 | 禁止进入公开目录；如需生效应在平台端端点解析层处理 |
| `control_enabled`、`scope_type`、`scope_apps` | PO、前端编辑 | FDE 构造器不读取；平台查询前负责授权/可见性 | 管理元数据 | 留在 baiteda 授权层，不属于模型能力 |
| streaming | 数据库无独立字段 | 两个 Chat adapter 都硬编码 `true`；OpenAI 工厂允许入参但调用方仍固定 true | 当前运行时有效、不可配置 | 新增策略字段并先检查 offering `streaming=true`；false/unknown 不得硬发 true |
| stream usage | 无 | 未映射 | 当前缺失 | 只有 offering 明确支持且有协议映射时才传 `streamUsage`/对应协议字段 |
| system message | 无细粒度能力 | DeepAgent 传系统提示，Anthropic 路径另有 message normalization，但未按模型能力 gating | 当前缺失且影响运行 | 增加 `system_message` 三态；不支持时必须有适配方案或拒绝 Agent 装配 |
| tool choice / parallel / strict | 无 | `create-agent.ts` 会做具体工具选择/绑定流程，但平台模型契约没有分别声明能力 | 当前缺失且影响运行 | 分别建模并在 bind/call 前 gating，不能从 `function_call` 推断 |
| structured output / JSON Schema | 无 | 未由模型目录驱动 | 当前缺失 | 独立三态及协议映射；strict tools 不等于通用 structured output |
| reasoning effort/budget/interleaved | 无 | 未构造、未请求 | 当前缺失 | 按 offering 可选值和协议字段过滤后映射 |
| `top_k` | 无 | 未构造、未请求 | 当前缺失 | 如进入 Tenant/Agent Policy，必须先具备 offering 支持、范围、协议映射和 adapter 测试 |

因此，当前真正影响 `ChatOpenAI`/`ChatAnthropic` 的只有模型 ID、协议/provider、所选端点的 Base URL/API Key、`maxTokens` 和硬编码 streaming；真正影响 DeepAgent 的还有角色准入、粗粒度 function call 准入和被错误等同于输入预算的 `maxContextTokens`。`isReasonModel` 只是诊断元数据。当前链路没有构造任何 Embedding adapter。

## 为什么 `function_call` 单一枚举不足

`StreamCallSupported` 只说明当前项目希望看到流式工具消息，无法回答以下互不等价的问题：模型能否调用工具、是否接受 `tool_choice`、能否并行调用、能否强制严格工具参数、是否支持结构化输出、是否接受 JSON Schema、流式响应是否带 usage。把其中任意一个从 `function_call` 推出来都会把“未知”误作“支持”。

兼容方式：旧枚举继续作为 UI/旧接口的派生视图，但只按保守规则计算：`tool_call=true` 只能派生 `CallSupported`，`false` 派生 `Unsupported`，`unknown` 保留空值。当前目录没有独立的“流式工具调用”事实，因此不能从 `streaming + tool_call` 推出 `StreamCallSupported`，也不能由旧枚举反向写回细粒度字段。新运行时直接读取 offering 的九个 Agent 能力三态。Agent 需要的能力不是 `true` 时，应降级到明确无工具路径或拒绝装配并输出诊断，不能偷偷尝试。

## baiteda-app 文件级集成清单

以下是后续实施范围，本任务未修改该仓库。

| 文件/层 | 所需变更 |
| --- | --- |
| `.../dal/entity/mysql/SystemLlmModelPo.java` 与数据库迁移 | 增加 `catalog_canonical_id`、`catalog_provider_id`、`catalog_offering_id`、`catalog_version`、`catalog_schema_version`、`catalog_api_model_id`、`catalog_binding_mode`、`catalog_shard_sha256` 和独立 `max_input_tokens`；明确现有 `model=租户实际 api_model_id`、`max_tokens=tenant max_output_tokens`。`explicit_override` 由绑定模式表达，不根据名称猜测。`temperature/top_p` 只能作为 tenant override，可增加 `top_k`/`reasoning_effort`，但必须与同一版本的运行时映射一起上线。私有 capability override 若确有需要，应放租户受控 JSON，不能回写公开目录 |
| `.../common/domain/dto/ai/LlmModelSaveDto.java` | 增加 catalog binding、输入预算、运行策略和可选的严格白名单 capability snapshot；sampling 值只能进入 tenant override。服务端拒绝 evidence、Logo、目录 URL、secret、未知扩展字段，并重新计算 projection SHA-256 |
| `.../common/domain/vo/ai/LlmModelDetailVo.java`、`LlmModelConfigResourceVo.java`、`LlmModelOptionVo.java` | 详情返回已保存的 catalog identity/版本/能力快照和三层合并前的 tenant override；Resource VO 只下发 FDE 真正消费的细粒度三态和协议映射。secret 权限边界保持不变 |
| `.../vo/ai/LlmModelPublicCatalogTemplateVo.java`、`PageVo.java`、对应 Query BO | 删除；浏览、搜索和详情由前端静态目录客户端完成，不再提供后端模板 API |
| `.../biz/service/ai/impl/LlmModelPublicCatalogService.java` 及测试 | 删除；Java 不再读取公司 CDN、客户目录、models.dev 或 GitHub，也不保留任何运行时 fallback |
| `.../biz/service/ai/impl/LlmModelConfigServiceImpl.java` | 删除目录服务注入和模板搜索；保存时校验 binding/snapshot 形状、ID 一致性和哈希，unknown 不默认成 false；合并 System Default < Tenant Override < Agent Policy，输出 capability-filtered runtime plan 或向 FDE 提供完整过滤输入 |
| `.../web/controller/.../LlmModelConfigController.java`、`LlmModelConfigSpController.java` | 删除 `searchPublicModelTemplates`；Save/Detail/Resource BO/VO 协议版本化并携带保存后的 binding/能力诊断，但永不在非授权接口返回密钥 |
| application/Nacos 配置 | 删除 `ai.llm.public-model-catalog.*`；目录根地址只属于前端构建/部署配置 |
| 对应 service/controller 测试 | 断言后端没有目录出站请求和硬编码公网 URL；覆盖 binding 格式、projection hash、unknown 保留、私有 override、额外字段拒绝、无 secret 日志和契约序列化 |

不建议把完整公开 offering JSON 复制进每一行租户模型记录。租户行保存“选中了哪个 offering、使用哪个目录版本、有哪些显式覆盖”；FDE 真正需要的字段可投影为独立、版本化、严格白名单的 capability snapshot。该快照是管理员客户端提交并由服务端做结构/哈希校验的运行契约，不得伪装成服务端已从 CDN 独立核验的事实；若需要抵抗绕过前端的篡改，应再增加目录 CI 签名和服务端内置公钥验证，而不是恢复后端出站抓取。

## FDE 文件级集成清单

| 文件 | 所需变更 |
| --- | --- |
| `apps/fde-workbench/src/agent/model-runtime.ts` | 扩展平台 payload 为 catalog identity、`maxInputTokens`、细粒度 Agent/reasoning/sampling/Embedding 字段；加入三层合并与 fail-closed 过滤；按协议构造 ChatOpenAI Chat Completions/Responses、ChatAnthropic Messages 或 OpenAIEmbeddings；把 `model.profile.maxInputTokens` 只映射 `max_input_tokens`，绝不使用 context 替代 |
| `apps/fde-workbench/src/agent/create-agent.ts` | 在创建主/子 Agent 之前声明所需能力并验证 effective capability；工具绑定、tool choice、并行/strict/structured output 分别 gating；诊断中记录字段和目录版本，不记录 URL/Key；向 `createDeepAgent` 传已构造并过滤的 model 对象 |
| `apps/fde-workbench/src/agent/model-runtime.spec.ts` | 为每个新增运行时字段做“true 发送、false 不发送、unknown 不发送并诊断”三组契约；分别断言 ChatOpenAI、Responses、ChatAnthropic、Embedding 构造参数和 maxInput profile |
| `apps/fde-workbench/src/agent/create-agent.spec.ts` | 断言能力不足时不绑定相应工具/模式，细粒度能力不会从模型名或旧 function enum 推断，并覆盖缓存键包含 catalog/effective policy 版本 |

参考映射：

| 目录/策略字段 | ChatOpenAI | ChatAnthropic | Embedding / DeepAgent |
| --- | --- | --- | --- |
| `api_model_id` | `model`/`modelName` | `model`/`modelName` | `OpenAIEmbeddings.model` |
| tenant Base URL/Key | `configuration.baseURL` / `apiKey` | `anthropicApiUrl` / `apiKey` | `configuration.baseURL` / `apiKey` |
| `max_output_tokens` | `maxTokens`，由 adapter 映射协议字段 | `maxTokens` | 不适用 |
| `max_input_tokens` | 无请求参数 | 无请求参数 | `model.profile.maxInputTokens`；Embedding 作为输入预检上限 |
| `temperature` / `top_p` | `temperature` / `topP` | `temperature` / `topP` | 不适用 |
| `top_k` | 经过验证的 `modelKwargs[protocol_mapping]` | `topK` | 不适用 |
| streaming / usage | `streaming` / `streamUsage` 或协议映射 | 同 adapter 支持字段；未验证则不发 | 不适用 |
| reasoning | `reasoning` 或 provider `modelKwargs` | `outputConfig`/provider 映射 | DeepAgent 无隐式推断 |
| `dimension` / batch | 不适用 | 不适用 | `OpenAIEmbeddings.dimensions` / `batchSize` |

## pro-lowcode-platform-front 文件级集成清单

| 文件 | 所需变更 |
| --- | --- |
| `.env*`、`index.html` | 增加 `VUE_APP_LLM_CATALOG_BASE_URL`；构建期从 `.env` 注入。私有化部署需要免重建切换时，由部署器改写/注入 `window.__APP_ENV__`；现有 `src/config/legacy-env.ts#getLegacyEnv` 可直接复用，无需修改 |
| `src/services/publicLlmCatalogService.ts`（新增） | 使用原生 `fetch`、`credentials: 'omit'` 和 Web Crypto 直接消费 manifest/index/provider shard；实现版本、大小、SHA-256、最后验证缓存和 CORS 诊断，不附带平台 token/tenant header |
| `src/services/llmConfigService.ts` | 删除 `searchPublicModelTemplates` 和旧 Template 类型；Save/Detail DTO 增加 catalog binding、unknown、可选 capability snapshot 和 runtime override |
| `src/views/LlmConfig/index.vue` | 先展示 canonical/offering 并允许 provider-scoped alias/私有 override；把 context/input/output 三个限额分栏；显示细粒度能力和字段证据。采样输入明确标注为三层策略中的 Tenant Override，并按 capability 禁用/隐藏；不得继续提交“后端存了但 FDE 不消费”的字段 |
| `modelCapabilityAssistant.ts` | 外部识别结果只能形成候选，不得用名称猜测；产出与目录 Schema 对齐的三态和证据，不直接改 tenant secret/deployment；旧 `function_call` 只能从细能力保守派生 |
| contract/unit test | 增加环境地址、跨域不带凭据、哈希/版本缓存、unknown 展示、三限额不混用、private override、capability gating、sampling 分层及无 URL/Key 进入公开建议的测试 |

当前前端界面可编辑 `max_tokens`、`max_context_tokens`、`function_call`、reason flag 和 Embedding dimension，但保存时把 `temperature`、`top_p` 固定为 null。后续只有在 baiteda BO/VO、FDE 构造器映射和端到端契约测试同时合入后，才允许开放某个新增运行时输入。

## alias 与私有模型标识

解析顺序必须确定且不依赖名称模式：

1. 用 `(provider_id, api_model_id)` 精确匹配公开 offering。
2. 未命中时解析同 provider 的 alias；全局 alias 只能在不歧义时使用。
3. 私有部署 ID 未命中时必须明确保存目标 `catalog_offering_id`，并标记 `catalog_binding_mode=explicit_override`，说明继承哪个公开 offering 的能力。
4. override 只决定能力基线；实际请求仍使用租户的私有 `api_model_id`、Base URL 和 Key。
5. 租户可再提供受审计的 capability override，且未知字段默认仍为 unknown。

严禁 `if (model.includes("gpt"))`、正则或模型名称列表驱动 adapter/能力。`src/runtime.ts` 的测试会扫描实现，确保初始模型名没有进入运行时分支。

## 上线门禁

每个新增运行时字段必须同时具备：Schema、offering 字段级证据、BO/VO 序列化、三层合并规则、`supported=true/false/unknown` 过滤、具体构造器/调用映射、诊断码以及契约测试。缺任一项时字段只能作为 metadata/unsupported 保留，不能进入租户可编辑配置。这一门禁专门阻止“数据库保存了 temperature/top_p，但 DeepAgent 初始化没有消费”的回归。
