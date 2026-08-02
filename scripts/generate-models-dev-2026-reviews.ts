import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stableJson, sha256, readJson } from "../src/json.js";
import { loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import type {
  ModelsDevCandidates,
  ModelsDevOfferingReview,
  ModelsDevOfficialReviews,
  Protocol,
  SourceEvidence,
} from "../src/types.js";

const REVIEWED_AT = "2026-08-02T00:00:00Z";
const OUTPUT_PATH = join(REPOSITORY_ROOT, "catalog", "reviews", "models-dev-2026.json");

type ReviewSeed = Omit<
  ModelsDevOfferingReview,
  "offering_id" | "provider_id" | "canonical_id" | "observed_api_model_id" | "reviewed_at"
>;

function source(
  sourceId: string,
  sourceUrl: string,
  sourceType: SourceEvidence["source_type"],
  notes: string,
): SourceEvidence {
  return {
    source_id: sourceId,
    source_url: sourceUrl,
    source_type: sourceType,
    retrieved_at: REVIEWED_AT,
    verified_at: REVIEWED_AT,
    confidence: "high",
    redistribution: "unknown",
    notes,
  };
}

function officialApi(
  officialApiModelId: string,
  officialProtocols: Protocol[] | "unknown",
  summary: string,
  evidence: SourceEvidence[],
): ReviewSeed {
  return {
    review_status: "official_api_verified",
    verified_fields: [
      "model_identity",
      "api_model_id",
      ...(officialProtocols === "unknown" ? [] : ["protocols" as const]),
    ],
    official_api_model_id: officialApiModelId,
    official_protocols: officialProtocols,
    runtime_disposition: "keep_fail_closed",
    summary,
    evidence,
  };
}

function officialModel(summary: string, evidence: SourceEvidence[]): ReviewSeed {
  return {
    review_status: "official_model_verified",
    verified_fields: ["model_identity"],
    official_api_model_id: "unknown",
    official_protocols: "unknown",
    runtime_disposition: "keep_fail_closed",
    summary,
    evidence,
  };
}

function unavailableRoute(
  officialApiModelId: string,
  officialProtocols: Protocol[] | "unknown",
  summary: string,
  evidence: SourceEvidence[],
): ReviewSeed {
  return {
    review_status: "official_route_unavailable",
    verified_fields: ["model_identity", "api_model_id"],
    official_api_model_id: officialApiModelId,
    official_protocols: officialProtocols,
    runtime_disposition: "keep_fail_closed",
    summary,
    evidence,
  };
}

function noQualifyingEvidence(candidateId: string): ReviewSeed {
  return {
    review_status: "official_evidence_not_found",
    verified_fields: [],
    official_api_model_id: "unknown",
    official_protocols: "unknown",
    runtime_disposition: "keep_fail_closed",
    summary: `截至 ${REVIEWED_AT.slice(0, 10)}，未在该条目对应厂商公开模型页、API 文档或模型卡中找到可复现的精确名称/API ID 映射（${candidateId}）。这不是“模型不存在”的断言；在获得可引用的官方资料前，继续保持上游观测且禁止运行时装配。`,
    evidence: [],
  };
}

const sources = {
  anthropicModels: source(
    "anthropic-models-overview",
    "https://platform.claude.com/docs/en/about-claude/models/overview",
    "official_docs",
    "Anthropic 模型概览列出 Claude API 的当前模型 ID、上下文与能力概览。",
  ),
  anthropicPricing: source(
    "anthropic-pricing-fast-mode",
    "https://platform.claude.com/docs/en/about-claude/pricing",
    "official_docs",
    "Anthropic 定价页说明 Opus 4.7 的 fast mode 是请求速度模式，并说明 Opus 4.6 fast 已不可用/下线。",
  ),
  openai: (model: string) => source(
    `openai-${model.replaceAll(".", "-")}`,
    `https://developers.openai.com/api/docs/models/${model}`,
    "official_docs",
    "OpenAI 官方模型页给出模型 ID、快照、输入输出模态和支持端点。",
  ),
  googleReleaseNotes: source(
    "google-vertex-release-notes",
    "https://docs.cloud.google.com/vertex-ai/docs/release-notes",
    "official_docs",
    "Google Vertex AI 发布说明记录 Gemini 3.1、Gemma 4 与 Lyria 3 的模型发布和模型 ID。",
  ),
  googleInteractions: source(
    "google-gemini-interactions-overview",
    "https://ai.google.dev/gemini-api/docs/interactions-overview",
    "official_docs",
    "Google Gemini API 交互概览列出可选模型标识；不把 Gemini 专有协议映射为本目录的 OpenAI/Anthropic 协议。",
  ),
  ibmGranite: source(
    "ibm-granite-4-1-8b-repository",
    "https://huggingface.co/ibm-granite/granite-4.1-8b",
    "official_repository",
    "IBM Granite 官方组织发布的模型仓库，说明模型身份、发布信息与本地部署用法。",
  ),
  mistralMedium: source(
    "mistral-medium-3-5-model-card",
    "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04",
    "official_docs",
    "Mistral 官方模型卡列出 mistral-medium-3-5 与 Chat Completions 能力。",
  ),
  mistralSmall: source(
    "mistral-small-4-model-card",
    "https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03",
    "official_docs",
    "Mistral 官方模型卡列出 mistral-small-2603 与 Chat Completions 能力。",
  ),
  qwenText: source(
    "alibaba-model-studio-text-generation",
    "https://www.alibabacloud.com/help/en/model-studio/text-generation",
    "official_docs",
    "阿里云百炼文本生成文档列出 Qwen3.5/Qwen3.6 系列及部分精确模型标识；协议细节不由该条目推断。",
  ),
  qwenExtractor: source(
    "alibaba-model-studio-web-extractor",
    "https://help.aliyun.com/en/model-studio/web-extractor",
    "official_docs",
    "阿里云百炼 Web Extractor 文档列出 qwen3-max-2026-01-23 及其 thinking 配置。",
  ),
  qwenVision: source(
    "alibaba-model-studio-vision-skill",
    "https://www.alibabacloud.com/help/en/model-studio/add-vision-skill",
    "official_docs",
    "阿里云百炼视觉能力文档列出 qwen3-coder-next；该条目只用于核验模型身份，不外推工具或视觉 API 参数。",
  ),
  deepseek: source(
    "deepseek-v4-pricing-and-api",
    "https://api-docs.deepseek.com/quick_start/pricing/",
    "official_api",
    "DeepSeek 官方模型与定价页列出 deepseek-v4-flash/pro、OpenAI/Anthropic 格式端点和限额。",
  ),
  tencent: source(
    "tencent-tokenhub-model-protocols",
    "https://cloud.tencent.com/document/product/1823/130079",
    "official_docs",
    "腾讯云 TokenHub 模型协议概览列出 hy3-preview 的 model 参数及 OpenAI/Responses/Anthropic 支持。",
  ),
  xiaomi: source(
    "xiaomi-mimo-openai-api",
    "https://mimo.mi.com/docs/api/chat/openai-api",
    "official_api",
    "小米 MiMo 官方 OpenAI 兼容 API 文档列出 mimo-v2.5 与 mimo-v2.5-pro 可选值。",
  ),
  zaiGlm51: source(
    "zai-glm-5-1",
    "https://docs.z.ai/guides/llm/glm-5.1",
    "official_docs",
    "Z.AI GLM-5.1 官方页给出 glm-5.1 和 Chat Completions 调用示例。",
  ),
  zaiChat: source(
    "zai-chat-completion",
    "https://docs.z.ai/api-reference/llm/chat-completion",
    "official_api",
    "Z.AI Chat Completion 文档列出 GLM-5、GLM-5.1、GLM-5-Turbo 等系列的调用范围。",
  ),
  arceeThinking: source(
    "arcee-trinity-large-thinking",
    "https://www.arcee.ai/blog/trinity-large-thinking",
    "official_docs",
    "Arcee 官方发布说明 Trinity-Large-Thinking 已在其 API 和权重仓库发布。",
  ),
  arceePreview: source(
    "arcee-trinity-large-preview",
    "https://www.arcee.ai/blog/trinity-large",
    "official_docs",
    "Arcee 官方模型发布说明 Trinity-Large-Preview 的模型身份、上下文和发布渠道。",
  ),
  xaiGrok: source(
    "xai-grok-4-20-model-card",
    "https://data.x.ai/2026-04-07-grok-4-20-model-card.pdf",
    "official_model_card",
    "xAI Grok 4.20 官方系统卡确认模型身份；未据此推断 API 协议或请求 ID。",
  ),
  google: source(
    "google-vertex-and-gemini-models",
    "https://docs.cloud.google.com/vertex-ai/docs/release-notes",
    "official_docs",
    "Google 官方发布说明/模型文档用于核验模型身份和已列出的 API 模型 ID。",
  ),
  kwaipilot: source(
    "kwaishou-q1-2026-results",
    "https://ir.kuaishou.com/node/11461/pdf",
    "official_docs",
    "快手官方 2026 年一季报确认 KAT-Coder-Pro V2 已发布；未提供厂商直连 API 约束。",
  ),
  reka: source(
    "reka-models-api",
    "https://docs.reka.ai/chat/models",
    "official_api",
    "Reka 官方 Models API 文档列出 reka-edge/reka-edge-2603 和 OpenAI SDK Chat API 用法。",
  ),
  minimax: source(
    "minimax-models-overview",
    "https://platform.minimax.io/docs/guides/models-intro",
    "official_docs",
    "MiniMax 官方模型概览列出 MiniMax-M2.7、MiniMax-M2.5 与 M2-her 名称；未从该页推断协议。",
  ),
  nvidia: source(
    "nvidia-nemotron-3-super-model-card",
    "https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard",
    "official_model_card",
    "NVIDIA NIM 官方模型卡确认 Nemotron 3 Super 的模型身份、发布日和开源部署信息。",
  ),
  volcengine: source(
    "volcengine-doubao-seed-2",
    "https://www.volcengine.com/product/doubao/",
    "official_docs",
    "火山引擎豆包产品页确认 Doubao-Seed-2.0-lite 与 Doubao-Seed-2.0-mini 属于官方产品线；未给出本目录 observed ID 的直连映射。",
  ),
  aion: source(
    "aion-labs-api-reference",
    "https://api.aionlabs.ai/docs/api-reference/",
    "official_api",
    "Aion Labs 官方 API 参考明确列出 aion-labs/aion-2.0，且提供 OpenAI 兼容 Chat 与 Responses 端点。",
  ),
  stepfun: source(
    "stepfun-reasoning-api",
    "https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api",
    "official_docs",
    "StepFun 官方文档列出 step-3.5-flash，并给出 OpenAI Chat Completions 与 Anthropic Messages 路径。",
  ),
  moonshot: source(
    "moonshot-kimi-k2-5-api-forum",
    "https://forum.moonshot.ai/t/kimi-k2-5-api-is-now-available/218",
    "official_docs",
    "Moonshot 官方开发者论坛公告确认 Kimi K2.5 已在 API 平台可用；示例使用 kimi-k2.5。",
  ),
  writer: source(
    "writer-model-selection",
    "https://dev.writer.com/home/models",
    "official_docs",
    "Writer AI Studio 模型选择文档将 palmyra-x5 列为当前替代模型；协议和细粒度能力仍不由该页推断。",
  ),
} as const;

const seeds: Record<string, ReviewSeed> = {
  "models-dev/anthropic/claude-opus-4.7-fast": officialApi(
    "claude-opus-4-7",
    ["anthropic_messages"],
    "官方将 Opus 4.7 fast 表示为 claude-opus-4-7 的 speed 请求变体，而不是独立模型 ID。保留上游 route 名称仅供审计；未补齐当前项目的 speed 参数映射和契约测试前，运行时保持 fail-closed。",
    [sources.anthropicModels, sources.anthropicPricing],
  ),
  "models-dev/anthropic/claude-opus-4.7": officialApi(
    "claude-opus-4-7",
    ["anthropic_messages"],
    "官方 API ID 使用连字符形式 claude-opus-4-7；observed namespaced ID 不是可直接发送的最终请求值。",
    [sources.anthropicModels],
  ),
  "models-dev/anthropic/claude-opus-4.6-fast": unavailableRoute(
    "claude-opus-4-6",
    ["anthropic_messages"],
    "官方说明 Claude Opus 4.6 的 fast mode 已不可用/下线。该上游路线不得作为新租户部署或运行时模型选择。",
    [sources.anthropicModels, sources.anthropicPricing],
  ),
  "models-dev/anthropic/claude-opus-4.6": officialApi(
    "claude-opus-4-6",
    ["anthropic_messages"],
    "官方文档使用 claude-opus-4-6 作为 API ID；目录原始 namespaced 观察值不直接进入构造器。",
    [sources.anthropicModels, sources.anthropicPricing],
  ),
  "models-dev/anthropic/claude-sonnet-4.6": officialApi(
    "claude-sonnet-4-6",
    ["anthropic_messages"],
    "官方文档使用 claude-sonnet-4-6 作为 API ID；目录原始 namespaced 观察值不直接进入构造器。",
    [sources.anthropicModels],
  ),

  "models-dev/openai/gpt-chat-latest": officialApi(
    "chat-latest",
    ["openai_responses", "openai_chat_completions"],
    "OpenAI 官方页的模型 ID 是 chat-latest，而非 observed 的 gpt-chat-latest；该别名差异需要显式 alias/override 才能进入运行时。",
    [sources.openai("chat-latest")],
  ),
  "models-dev/openai/gpt-5.5": officialApi(
    "gpt-5.5",
    ["openai_responses", "openai_chat_completions"],
    "OpenAI 官方模型页确认 gpt-5.5 及 Responses/Chat Completions 端点；本审计不会绕过目录的字段级运行时契约。",
    [sources.openai("gpt-5.5")],
  ),
  "models-dev/openai/gpt-5.5-pro": officialApi(
    "gpt-5.5-pro",
    ["openai_responses"],
    "OpenAI 官方模型页确认 gpt-5.5-pro 仅列出 Responses/Batch；不能因为同系列模型支持 Chat Completions 就推断该协议。",
    [sources.openai("gpt-5.5-pro")],
  ),
  "models-dev/openai/gpt-5.4-mini": officialApi(
    "gpt-5.4-mini",
    ["openai_responses", "openai_chat_completions"],
    "OpenAI 官方模型页确认 gpt-5.4-mini 的模型 ID 和支持端点。",
    [sources.openai("gpt-5.4-mini")],
  ),
  "models-dev/openai/gpt-5.4-nano": officialApi(
    "gpt-5.4-nano",
    ["openai_responses", "openai_chat_completions"],
    "OpenAI 官方模型页确认 gpt-5.4-nano 的模型 ID 和支持端点。",
    [sources.openai("gpt-5.4-nano")],
  ),
  "models-dev/openai/gpt-5.4": officialApi(
    "gpt-5.4",
    ["openai_responses", "openai_chat_completions"],
    "OpenAI 官方模型页确认 gpt-5.4 的模型 ID 和支持端点。",
    [sources.openai("gpt-5.4")],
  ),
  "models-dev/openai/gpt-5.4-pro": officialApi(
    "gpt-5.4-pro",
    ["openai_responses"],
    "OpenAI 官方模型页明确 GPT-5.4 Pro 仅可通过 Responses API 调用。",
    [sources.openai("gpt-5.4-pro")],
  ),
  "models-dev/openai/gpt-5.3-chat": officialApi(
    "gpt-5.3-chat-latest",
    ["openai_responses", "openai_chat_completions"],
    "OpenAI 官方模型页的实际 ID 为 gpt-5.3-chat-latest，且已标记弃用；不得把 observed 的 gpt-5.3-chat 当作等价请求值。",
    [sources.openai("gpt-5.3-chat-latest")],
  ),
  "models-dev/openai/gpt-5.3-codex": officialApi(
    "gpt-5.3-codex",
    ["openai_responses"],
    "OpenAI 官方模型页确认 gpt-5.3-codex 仅列出 Responses 端点。",
    [sources.openai("gpt-5.3-codex")],
  ),
  "models-dev/openai/gpt-audio": officialApi(
    "gpt-audio",
    ["openai_chat_completions"],
    "OpenAI 官方模型页确认 gpt-audio 的 Chat Completions 支持；目录的 chat canonical 类型并不等同于完整音频适配已接入。",
    [sources.openai("gpt-audio")],
  ),
  "models-dev/openai/gpt-audio-mini": officialApi(
    "gpt-audio-mini",
    ["openai_chat_completions"],
    "OpenAI 官方模型页确认 gpt-audio-mini 的 Chat Completions 支持。",
    [sources.openai("gpt-audio-mini")],
  ),
  "models-dev/openai/gpt-5.2-codex": officialApi(
    "gpt-5.2-codex",
    ["openai_responses"],
    "OpenAI 官方模型页确认 gpt-5.2-codex 仅列出 Responses 端点。",
    [sources.openai("gpt-5.2-codex")],
  ),

  "models-dev/google/gemini-3.1-flash-lite": officialApi(
    "gemini-3.1-flash-lite",
    "unknown",
    "Google 官方发布说明确认该模型 ID。Gemini 原生调用形状未自动映射到本目录的 OpenAI/Anthropic 适配器。",
    [sources.googleReleaseNotes],
  ),
  "models-dev/google/gemini-3.1-flash-lite-preview": officialApi(
    "gemini-3.1-flash-lite",
    "unknown",
    "官方资料列出的稳定模型 ID 为 gemini-3.1-flash-lite；observed preview 后缀需要单独 alias 审批。",
    [sources.googleReleaseNotes],
  ),
  "models-dev/google/gemma-4-26b-a4b-it": officialModel(
    "Google 官方发布说明确认 Gemma 4 26B A4B IT 的模型发布；未在本次核验中找到可将该 open-weight 条目映射为厂商托管 API offering 的资料。",
    [sources.googleReleaseNotes],
  ),
  "models-dev/google/gemma-4-31b-it": officialApi(
    "gemma-4-31b-it",
    "unknown",
    "Google Gemini API 资料列出 gemma-4-31b-it；没有把 Google 原生接口默认折算为当前目录 adapter 协议。",
    [sources.googleInteractions],
  ),
  "models-dev/google/lyria-3-clip-preview": officialApi(
    "lyria-3-clip-preview",
    "unknown",
    "Google 官方资料列出 Lyria 3 Clip Preview 的模型 ID。它是音频方向模型，当前目录协议枚举没有据此猜测 chat adapter。",
    [sources.googleReleaseNotes, sources.googleInteractions],
  ),
  "models-dev/google/lyria-3-pro-preview": officialApi(
    "lyria-3-pro-preview",
    "unknown",
    "Google 官方资料列出 Lyria 3 Pro Preview 的模型 ID。它是音频方向模型，当前目录协议枚举没有据此猜测 chat adapter。",
    [sources.googleReleaseNotes],
  ),
  "models-dev/google/gemini-3.1-flash-image-preview": officialApi(
    "gemini-3.1-flash-image",
    "unknown",
    "Google 官方发布说明使用 gemini-3.1-flash-image；observed preview 后缀不能直接当成可调用值。",
    [sources.googleReleaseNotes],
  ),
  "models-dev/google/gemini-3.1-pro-preview-customtools": officialModel(
    "Google 官方资料确认 Gemini 3.1 Pro Preview，但未将 customtools 作为独立 model ID 发布；该路线必须保留为待映射配置。",
    [sources.googleReleaseNotes, sources.googleInteractions],
  ),
  "models-dev/google/gemini-3.1-pro-preview": officialApi(
    "gemini-3.1-pro-preview",
    "unknown",
    "Google 官方发布说明和 Gemini API 资料均列出 gemini-3.1-pro-preview；原生协议不自动进入当前 chat adapter。",
    [sources.googleReleaseNotes, sources.googleInteractions],
  ),

  "models-dev/ibm-granite/granite-4.1-8b": officialModel(
    "IBM 官方组织模型仓库确认 granite-4.1-8b 是可自托管权重；没有把本地 vLLM 示例误写成 IBM 公共 API offering。",
    [sources.ibmGranite],
  ),
  "models-dev/mistralai/mistral-medium-3-5": officialApi(
    "mistral-medium-3-5",
    ["openai_chat_completions"],
    "Mistral 官方模型卡列出该精确 ID 与 Chat Completions；尚未为现有运行时添加该 provider 的构造器映射。",
    [sources.mistralMedium],
  ),
  "models-dev/mistralai/mistral-small-2603": officialApi(
    "mistral-small-2603",
    ["openai_chat_completions"],
    "Mistral 官方模型卡列出该精确 ID 与 Chat Completions；尚未为现有运行时添加该 provider 的构造器映射。",
    [sources.mistralSmall],
  ),

  "models-dev/qwen/qwen3.5-plus-20260420": officialApi(
    "qwen3.5-plus",
    "unknown",
    "阿里云官方文档确认 Qwen3.5 Plus 系列；observed 日期后缀没有被直接当作官方请求模型 ID。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.6-27b": officialModel(
    "阿里云官方文档把 qwen3.6-27b 作为 Qwen3.6 开源系列中的例外项提及，确认模型身份但未给出本次可复用的直连 API mapping。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.6-35b-a3b": officialApi(
    "qwen3.6-35b-a3b",
    "unknown",
    "阿里云官方文本生成文档列出 qwen3.6-35b-a3b；尚未把百炼具体接口形状映射到当前 runtime adapter。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.6-flash": officialApi(
    "qwen3.6-flash",
    "unknown",
    "阿里云官方文档列出 qwen3.6-flash；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.6-max-preview": officialApi(
    "qwen3.6-max-preview",
    "unknown",
    "阿里云官方文档列出 qwen3.6-max-preview；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.6-plus": officialApi(
    "qwen3.6-plus",
    "unknown",
    "阿里云官方文档列出 qwen3.6-plus；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.5-122b-a10b": officialApi(
    "qwen3.5-122b-a10b",
    "unknown",
    "阿里云官方文档列出 qwen3.5-122b-a10b；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.5-27b": officialApi(
    "qwen3.5-27b",
    "unknown",
    "阿里云官方文档列出 qwen3.5-27b；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.5-35b-a3b": officialApi(
    "qwen3.5-35b-a3b",
    "unknown",
    "阿里云官方文档列出 qwen3.5-35b-a3b；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.5-flash-02-23": officialApi(
    "qwen3.5-flash",
    "unknown",
    "阿里云官方文档列出 qwen3.5-flash；observed 的日期后缀不能直接作为调用值。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.5-397b-a17b": officialApi(
    "qwen3.5-397b-a17b",
    "unknown",
    "阿里云官方文档列出 qwen3.5-397b-a17b；协议和构造器映射仍须单独契约测试。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3.5-plus-02-15": officialApi(
    "qwen3.5-plus",
    "unknown",
    "阿里云官方文档确认 Qwen3.5 Plus 系列；observed 日期后缀没有被直接当作官方请求模型 ID。",
    [sources.qwenText],
  ),
  "models-dev/qwen/qwen3-max-thinking": officialApi(
    "qwen3-max-2026-01-23",
    "unknown",
    "阿里云官方文档列出 qwen3-max-2026-01-23 与 thinking 配置；observed qwen3-max-thinking 是待审核别名，不可直接发给 API。",
    [sources.qwenExtractor],
  ),
  "models-dev/qwen/qwen3-coder-next": officialModel(
    "阿里云官方产品文档列出 qwen3-coder-next；本次没有将工具/视觉产品说明外推为完整 API 协议或 Agent 字段。",
    [sources.qwenVision],
  ),

  "models-dev/deepseek/deepseek-v4-flash": officialApi(
    "deepseek-v4-flash",
    ["openai_chat_completions", "anthropic_messages"],
    "DeepSeek 官方 API 文档确认精确模型 ID 和两种协议格式；运行时字段仍须在 provider offering 中完成显式映射后才可发送。",
    [sources.deepseek],
  ),
  "models-dev/deepseek/deepseek-v4-pro": officialApi(
    "deepseek-v4-pro",
    ["openai_chat_completions", "anthropic_messages"],
    "DeepSeek 官方 API 文档确认精确模型 ID 和两种协议格式；运行时字段仍须在 provider offering 中完成显式映射后才可发送。",
    [sources.deepseek],
  ),
  "models-dev/tencent/hy3-preview": officialApi(
    "hy3-preview",
    ["openai_chat_completions", "openai_responses", "anthropic_messages"],
    "腾讯云 TokenHub 官方模型表确认 hy3-preview 的 ID 和三种协议支持；目录原始 namespaced ID 不等于实际 model 参数。",
    [sources.tencent],
  ),
  "models-dev/xiaomi/mimo-v2.5": officialApi(
    "mimo-v2.5",
    ["openai_chat_completions"],
    "小米官方 OpenAI 兼容 API 文档列出 mimo-v2.5；推理字段和内容格式仍须专项适配。",
    [sources.xiaomi],
  ),
  "models-dev/xiaomi/mimo-v2.5-pro": officialApi(
    "mimo-v2.5-pro",
    ["openai_chat_completions"],
    "小米官方 OpenAI 兼容 API 文档列出 mimo-v2.5-pro；推理字段和内容格式仍须专项适配。",
    [sources.xiaomi],
  ),

  "models-dev/z-ai/glm-5.1": officialApi(
    "glm-5.1",
    ["openai_chat_completions"],
    "Z.AI 官方 GLM-5.1 页给出 glm-5.1 的 Chat Completions 示例；本次不把采样或 thinking 参数自动接入 runtime。",
    [sources.zaiGlm51],
  ),
  "models-dev/z-ai/glm-5-turbo": officialApi(
    "glm-5-turbo",
    ["openai_chat_completions"],
    "Z.AI 官方 Chat Completion 文档列出 GLM-5-Turbo；细粒度工具/推理能力仍需字段级资料和契约测试。",
    [sources.zaiChat],
  ),
  "models-dev/z-ai/glm-5": officialApi(
    "glm-5",
    ["openai_chat_completions"],
    "Z.AI 官方 Chat Completion 文档列出 GLM-5；细粒度工具/推理能力仍需字段级资料和契约测试。",
    [sources.zaiChat],
  ),

  "models-dev/arcee-ai/trinity-large-thinking": officialApi(
    "trinity-large-thinking",
    "unknown",
    "Arcee 官方发布页确认 Trinity-Large-Thinking 在其 API 上可用；未找到足以映射本目录协议枚举的公开 API 细节。",
    [sources.arceeThinking],
  ),
  "models-dev/arcee-ai/trinity-large-preview": officialModel(
    "Arcee 官方发布页确认 Trinity-Large-Preview 的模型身份，但没有把其第三方路由名提升为 Arcee 直连 API offering。",
    [sources.arceePreview],
  ),
  "models-dev/x-ai/grok-4.20": officialModel(
    "xAI 官方系统卡确认 Grok 4.20 的模型身份和能力方向；没有据此推断 API ID 或协议。",
    [sources.xaiGrok],
  ),
  "models-dev/kwaipilot/kat-coder-pro-v2": officialModel(
    "快手官方披露确认 KAT-Coder-Pro V2 已发布；公开资料未提供可复现的厂商直连 API offering 映射。",
    [sources.kwaipilot],
  ),
  "models-dev/rekaai/reka-edge": officialApi(
    "reka-edge-2603",
    ["openai_chat_completions"],
    "Reka 官方 API 文档列出 reka-edge/reka-edge-2603；observed 默认别名需显式 alias 策略才能用于运行时。",
    [sources.reka],
  ),
  "models-dev/minimax/minimax-m2.7": officialApi(
    "MiniMax-M2.7",
    "unknown",
    "MiniMax 官方模型概览使用 MiniMax-M2.7 的大小写形式；尚未从模型页推断当前 adapter 协议。",
    [sources.minimax],
  ),
  "models-dev/minimax/minimax-m2.5": officialApi(
    "MiniMax-M2.5",
    "unknown",
    "MiniMax 官方模型概览使用 MiniMax-M2.5 的大小写形式；尚未从模型页推断当前 adapter 协议。",
    [sources.minimax],
  ),
  "models-dev/minimax/minimax-m2-her": officialApi(
    "M2-her",
    "unknown",
    "MiniMax 官方模型概览使用 M2-her；observed 的 minimax-m2-her 不是已确认的实际请求值。",
    [sources.minimax],
  ),
  "models-dev/nvidia/nemotron-3-super-120b-a12b": officialModel(
    "NVIDIA 官方模型卡确认 Nemotron 3 Super 120B-A12B；公开自托管/NIM 资料不能自动成为国内厂商公共 API offering。",
    [sources.nvidia],
  ),
  "models-dev/bytedance-seed/seed-2.0-lite": officialModel(
    "火山引擎官方产品页确认 Doubao-Seed-2.0-lite；未将 models.dev 的 seed-2.0-lite 简写误作方舟实际请求 ID。",
    [sources.volcengine],
  ),
  "models-dev/bytedance-seed/seed-2.0-mini": officialModel(
    "火山引擎官方产品页确认 Doubao-Seed-2.0-mini；未将 models.dev 的 seed-2.0-mini 简写误作方舟实际请求 ID。",
    [sources.volcengine],
  ),
  "models-dev/aion-labs/aion-2.0": officialApi(
    "aion-labs/aion-2.0",
    ["openai_chat_completions", "openai_responses"],
    "Aion Labs 官方 API 参考列出与 observed 相同的模型 ID，并说明 OpenAI 兼容 Chat 与 Responses 端点。",
    [sources.aion],
  ),
  "models-dev/stepfun/step-3.5-flash": officialApi(
    "step-3.5-flash",
    ["openai_chat_completions", "anthropic_messages"],
    "StepFun 官方文档列出 step-3.5-flash 与 OpenAI/Anthropic 路径；目录 namespaced ID 仍须经 alias/override 显式转换。",
    [sources.stepfun],
  ),
  "models-dev/moonshotai/kimi-k2.5": officialApi(
    "kimi-k2.5",
    ["openai_chat_completions"],
    "Moonshot 官方公告的 API 示例使用 kimi-k2.5；思考字段尚未纳入当前 runtime 构造器。",
    [sources.moonshot],
  ),
  "models-dev/writer/palmyra-x5": officialApi(
    "palmyra-x5",
    "unknown",
    "Writer 官方模型选择文档确认 palmyra-x5；当前目录没有将 Writer 接口细节映射为 runtime adapter。",
    [sources.writer],
  ),
};

async function main(): Promise<void> {
  const [candidates, catalog] = await Promise.all([
    readJson<ModelsDevCandidates>(join(REPOSITORY_ROOT, "upstream", "models-dev-2026.json")),
    loadSourceCatalog(REPOSITORY_ROOT),
  ]);
  const offeringByCandidateKey = new Map(
    catalog.offerings.map((offering) => [
      `${offering.provider_id}\u0000${offering.canonical_id}\u0000${offering.api_model_id}`,
      offering,
    ]),
  );
  const reviews: ModelsDevOfferingReview[] = candidates.models
    .filter((candidate) => candidate.route_kind === "direct")
    .map((candidate) => {
      const key = `${candidate.provider_id}\u0000${candidate.canonical_slug}\u0000${candidate.api_model_id}`;
      const offering = offeringByCandidateKey.get(key);
      if (offering === undefined) {
        throw new Error(`未找到已提升直连候选对应 offering: ${candidate.candidate_id}`);
      }
      const seed = seeds[candidate.candidate_id] ?? noQualifyingEvidence(candidate.candidate_id);
      return {
        offering_id: offering.offering_id,
        provider_id: offering.provider_id,
        canonical_id: offering.canonical_id,
        observed_api_model_id: offering.api_model_id,
        reviewed_at: REVIEWED_AT,
        ...seed,
      };
    })
    .sort((left, right) => left.offering_id.localeCompare(right.offering_id, "en"));
  const document: ModelsDevOfficialReviews = {
    $schema: "https://llm-catalog.example.cn/schemas/models-dev-official-review.schema.json",
    schema_version: catalog.release.schema_version,
    review_set_id: "models-dev-2026-official-review",
    source_snapshot_sha256: sha256(stableJson(candidates)),
    reviewed_at: REVIEWED_AT,
    reviews,
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, stableJson(document));
  process.stdout.write(`已生成 ${reviews.length} 条逐条核验记录: ${OUTPUT_PATH}\n`);
}

void main();
