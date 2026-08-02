# 候选来源调研矩阵

调研日期：2026-08-02。这里的“国内可访问性”区分“来源网站是否面向国内”与“业务运行时是否允许依赖”：无论来源当时能否打开，业务服务器都只消费本项目同步到国内对象存储/CDN 的静态文件。可访问性和条款会变化，正式发布前仍需法务复核并从目标省份/运营商探测。

| 来源 | 覆盖范围 | 机器可读 | 国内可访问性 | 更新频率 | 许可与再分发 | 可验证字段 | API Key |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [models.dev](https://models.dev/) / [仓库](https://github.com/anomalyco/models.dev) | 多供应商模型、限额、模态、能力、价格等聚合信息 | 是，公开 [`api.json`](https://models.dev/api.json)；仓库也是结构化数据 | 跨境站点/GitHub，不保证稳定；禁止作为业务运行时依赖 | 社区持续更新，无发布 SLA | 仓库为 [MIT](https://raw.githubusercontent.com/anomalyco/models.dev/main/LICENSE)，再分发需保留许可声明；具体厂商事实仍需官方复核 | 候选 ID、上下文/输出限额、模态、工具/推理提示 | 否 |
| [LiteLLM model map](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) | 多供应商路由、价格、token 限额和部分能力 | 是，单个 JSON 文件 | GitHub Raw 为跨境来源，不保证稳定 | 随仓库持续更新，无数据 SLA | 主仓库采用 [MIT](https://github.com/BerriAI/litellm/blob/main/LICENSE)；应保留许可并复核仓库内例外目录，不把其格式当权威 | 候选 provider/model、context/output、部分 function/reasoning/schema 标记 | 否 |
| [ModelScope Hub](https://github.com/modelscope/modelscope_hub) / [API-Inference](https://modelscope.cn/docs/model-service/API-Inference/intro) | 开源模型卡、文件、任务、推理服务 | Hub SDK/OpenAPI 可读；不存在统一覆盖所有模型能力的完整权威表 | 国内服务，适合 CI 采集与链接证据 | 模型作者与平台持续更新，无统一频率 | SDK 代码许可与每个模型卡/权重许可不同；模型事实再分发必须逐模型核对 | 模型身份、任务/模态、模型卡声明、推理端点状态 | 公开元数据通常否；推理通常是 |
| [Gitee AI](https://ai.gitee.com/) / [Serverless API](https://ai.gitee.com/docs/openapi/v1) | 国内托管模型、Serverless API 与模型卡 | 有 OpenAPI/服务接口；未发现无需鉴权的完整标准化能力转储 | 国内服务 | 平台持续更新，无公开目录 SLA | [Gitee 服务条款](https://gitee.com/terms) 未视为本目录取得整库再分发授权；仅摘录必要事实并保留来源，生产前复核 | API 标识、服务状态、接口协议、模型卡事实 | 文档否；推理/服务列表通常是 |
| [阿里云百炼](https://help.aliyun.com/zh/model-studio/what-is-model-studio) | 通义及第三方模型、OpenAI 兼容调用、工具、多模态、Embedding、生命周期 | 文档为结构化网页/API 文档；未发现一个公开且完整的免密能力目录 | 国内官方服务 | 文档和[模型下线公告](https://help.aliyun.com/zh/model-studio/model-deprecation)持续更新 | 阿里云网站/产品条款未视为授予官方文档整库再分发；仅保存字段事实、URL 和摘要 | model ID、地域、协议、模态、context/output、工具、参数、下线/替代 | 文档否；模型调用/账号列表是 |
| [火山引擎方舟](https://www.volcengine.com/docs/82379/1554711) | 豆包及合作模型、Chat/Responses、工具调用、多模态、生命周期 | API 文档机器可解析；账号内模型/Endpoint API 需鉴权 | 国内官方服务 | 持续更新，生命周期由官方公告 | 火山网站/产品条款未视为开放整库许可；只保留必要事实和证据链接 | Endpoint/model ID、协议、模态、上下文、输出、工具、Responses 字段、生命周期 | 文档否；账号资源/调用是 |
| [腾讯混元](https://cloud.tencent.com/document/product/1729) / [OpenAI 兼容](https://cloud.tencent.com/document/product/1729/111007) | 混元模型、原生与 OpenAI 兼容接口、工具、多模态、迁移公告 | API 文档结构化；云账号资源列表需鉴权 | 国内官方服务 | 持续更新并发布迁移/生命周期信息 | 腾讯云文档和产品条款未视为开放整库许可；保存必要事实，不镜像文档正文 | model ID、接口协议、限额、模态、工具、迁移和替代 | 文档否；调用/账号资源是 |
| [智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview) | GLM 文本/视觉/Embedding、OpenAI 与 Anthropic 兼容、工具、结构化输出、推理 | 文档页面结构明确；模型调用/API 列表需鉴权 | 国内官方服务 | 持续更新，无目录数据 SLA | 官方文档未发现独立的开放整库再分发许可，目录只摘录可验证字段并标 `redistribution=unknown` | model ID、context/output、输入输出模态、工具、structured output、reasoning、采样范围、Embedding 维度/批量 | 文档否；调用是 |
| [DeepSeek 文档](https://api-docs.deepseek.com/) / [`GET /models`](https://api-docs.deepseek.com/api/list-models) | DeepSeek 当前 API 模型、OpenAI 兼容、推理和生命周期 | 是，OpenAI 风格 `/models`；能力详情仍来自文档 | 国内厂商服务；实际 API/CDN 仍需目标网络探测 | API 模型列表实时，文档随版本更新 | 官方站点未发现允许整库镜像的开放数据许可；仅将响应作为候选并链接官方证据 | 当前可用 API ID、owner；context/工具/reasoning/参数/废弃来自文档 | `/models` 是 |
| [Moonshot/Kimi 模型文档](https://platform.kimi.com/docs/models) | Kimi/Moonshot 文本、长上下文、多模态/推理和工具模型 | 提供模型列表 API；能力详情为官方文档 | 国内厂商服务；需按部署地区探测 | 模型列表实时，文档持续更新 | 官方文档/平台条款未视为开放整库再分发；只保存必要事实和来源 | API model ID、context、模态、工具、推理、参数限制、生命周期 | 文档否；模型列表/调用是 |
| [MiniMax 开放平台](https://platform.minimaxi.com/document) / [`GET /v1/models`](https://platform.minimaxi.com/document/guides/models) | MiniMax 文本、语音、视频等模型及 OpenAI/Anthropic 兼容接口 | 是，`/v1/models`；能力细节为官方文档 | 国内厂商服务；需目标网络探测 | 模型列表实时，文档持续更新 | 官方平台条款未视为开放整库再分发；只保存必要事实和字段级证据 | API model ID、协议、模态、上下文/输出、工具/推理支持、生命周期 | 文档否；`/v1/models` 和调用是 |

## 采用策略

来源优先级不是“后来的值覆盖前面的值”，而是：

1. 模型制造商或 API provider 的官方模型页、API 参考和生命周期公告。
2. 官方模型列表 API，用于发现当前 ID 和状态；API 没有返回的能力不作推断。
3. 官方模型卡/官方仓库。
4. models.dev、LiteLLM 等聚合源只负责发现变更和交叉检查。

一个字段只有在官方证据足以区分语义时才从 `unknown` 提升。尤其不能把 `context window` 自动解释为 `max_input_tokens`，不能把“支持 tools”扩展成 `tool_choice`、并行工具或 strict schema，也不能从模型名称推断 reasoning。

## 当前自动候选源

`catalog/upstreams.json` 当前启用 models.dev、LiteLLM、DeepSeek `/models` 和 MiniMax `/v1/models`。前两者免密，后两者缺少 CI Secret 时安全跳过并保留上一次候选。同步脚本限制响应大小和 60 秒超时，先完成全部抓取与审查计算，再原子写入候选文件；任一无密钥以外的异常都会令任务失败，因此不会留下半次同步结果。

阿里百炼、方舟、混元、智谱、ModelScope、Gitee AI 和 Moonshot 暂未自动抓取：它们目前作为人工复核官方来源，待获得稳定、条款明确且字段语义可验证的接口后再增加 adapter。新增 adapter 只能输出候选格式，不能绕过 Schema、字段级证据和人工评审。
