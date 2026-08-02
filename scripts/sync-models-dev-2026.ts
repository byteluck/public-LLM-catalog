import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createValidators, formatValidationIssues, validateWith } from "../src/validate.js";
import { readJson, sha256, stableJson } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import type {
  ModelsDevCandidate,
  ModelsDevCandidates,
  ModelsDevCandidateProvider,
} from "../src/types.js";

const MODELS_URL = "https://models.dev/models.json";
const CUTOFF = "2026-01-01";
const CUTOFF_EPOCH = Date.parse(`${CUTOFF}T00:00:00Z`) / 1000;
const MAX_MODELS_BYTES = 52_428_800;
const MAX_LOGO_BYTES = 1_048_576;
const SNAPSHOT_PATH = join(REPOSITORY_ROOT, "upstream", "models-dev-2026.json");
const LOGO_DIRECTORY = join(REPOSITORY_ROOT, "upstream", "logos");
const LOGO_SOURCE_MAP: Record<string, string> = {
  mistralai: "mistral",
  qwen: "alibaba",
  tencent: "tencent-tokenhub",
  "x-ai": "xai",
  "z-ai": "zai",
};
const DEDICATED_LOGOS = new Set([
  "anthropic",
  "deepseek",
  "google",
  "inception",
  "minimax",
  "moonshotai",
  "nvidia",
  "openai",
  "openrouter",
  "poolside",
  "stepfun",
  "xiaomi",
]);
const PROVIDER_NAMES: Record<string, string> = {
  "aion-labs": "Aion Labs",
  anthropic: "Anthropic",
  "arcee-ai": "Arcee AI",
  baidu: "Baidu Qianfan",
  "bytedance-seed": "ByteDance Seed",
  deepseek: "DeepSeek",
  google: "Google",
  "ibm-granite": "IBM Granite",
  inception: "Inception Labs",
  inclusionai: "inclusionAI",
  kwaipilot: "Kwaipilot",
  liquid: "Liquid AI",
  minimax: "MiniMax",
  mistralai: "Mistral AI",
  moonshotai: "Moonshot AI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perceptron: "Perceptron",
  poolside: "Poolside",
  qwen: "Qwen",
  rekaai: "Reka AI",
  stepfun: "StepFun",
  tencent: "Tencent",
  upstage: "Upstage",
  writer: "Writer",
  "x-ai": "xAI",
  xiaomi: "Xiaomi",
  "z-ai": "Z.ai",
};

interface ModelsDevRecord {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  created?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  context_length?: unknown;
  top_provider?: { max_completion_tokens?: unknown };
  supported_parameters?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort()
    : [];
}

function routeKind(id: string): ModelsDevCandidate["route_kind"] {
  if (id.startsWith("~")) {
    return "alias";
  }
  if (id.startsWith("openrouter/")) {
    return "router";
  }
  if (id.endsWith(":free")) {
    return "free";
  }
  return "direct";
}

function normalizeRecord(record: ModelsDevRecord): ModelsDevCandidate | null {
  if (typeof record.id !== "string" || typeof record.created !== "number" || record.created < CUTOFF_EPOCH) {
    return null;
  }
  const id = record.id;
  const providerId = id.split("/")[0]?.replace(/^~/u, "");
  if (providerId === undefined || providerId === "") {
    return null;
  }
  const contextLength = Number.isInteger(record.context_length) && Number(record.context_length) > 0
    ? Number(record.context_length)
    : "unknown";
  const maxOutput = Number.isInteger(record.top_provider?.max_completion_tokens) && Number(record.top_provider?.max_completion_tokens) > 0
    ? Number(record.top_provider?.max_completion_tokens)
    : "unknown";
  return {
    candidate_id: `models-dev/${id}`,
    provider_id: providerId,
    api_model_id: id,
    canonical_slug: typeof record.canonical_slug === "string" ? record.canonical_slug : id,
    name: typeof record.name === "string" ? record.name : id,
    models_dev_created_at: new Date(record.created * 1000).toISOString().slice(0, 10),
    route_kind: routeKind(id),
    verification_status: "unverified",
    input_modalities: asStringArray(record.architecture?.input_modalities) as ModelsDevCandidate["input_modalities"],
    output_modalities: asStringArray(record.architecture?.output_modalities) as ModelsDevCandidate["output_modalities"],
    context_length: contextLength,
    max_output_tokens: maxOutput,
    supported_parameters: asStringArray(record.supported_parameters),
    source_url: MODELS_URL,
  };
}

function logoProvider(providerId: string): { sourceProviderId: string; status: ModelsDevCandidateProvider["logo_status"]; sourceUrl: string } {
  const sourceProviderId = DEDICATED_LOGOS.has(providerId) ? providerId : (LOGO_SOURCE_MAP[providerId] ?? "default");
  return {
    sourceProviderId,
    status: sourceProviderId === "default" ? "fallback" : (sourceProviderId === providerId ? "dedicated" : "mapped"),
    sourceUrl: sourceProviderId === "default"
      ? `https://models.dev/logos/${providerId}.svg`
      : `https://raw.githubusercontent.com/anomalyco/models.dev/refs/heads/dev/providers/${sourceProviderId}/logo.svg`,
  };
}

function normalizeSnapshot(payload: unknown, sourceRevision: string, retrievedAt: string): ModelsDevCandidates {
  const records = (payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data))
    ? payload.data as ModelsDevRecord[]
    : Array.isArray(payload) ? payload as ModelsDevRecord[] : [];
  const models = records
    .map(normalizeRecord)
    .filter((model): model is ModelsDevCandidate => model !== null)
    .sort((left, right) => `${right.models_dev_created_at}\u0000${left.api_model_id}`.localeCompare(`${left.models_dev_created_at}\u0000${right.api_model_id}`, "en"));
  if (models.length === 0) {
    throw new Error("models.dev models.json 未找到 2026-01-01 之后的模型记录");
  }
  const providerIds = [...new Set(models.map((model) => model.provider_id))].sort((left, right) => left.localeCompare(right, "en"));
  const providers = providerIds.map((providerId): ModelsDevCandidateProvider => {
    const logo = logoProvider(providerId);
    return {
      provider_id: providerId,
      name: PROVIDER_NAMES[providerId] ?? providerId,
      logo_path: `assets/logos/${providerId}.svg`,
      logo_source_url: logo.sourceUrl,
      logo_status: logo.status,
      logo_source_provider_id: logo.sourceProviderId,
    };
  });
  return {
    $schema: "https://llm-catalog.example.cn/schemas/models-dev-candidates.schema.json",
    schema_version: "1.0.0",
    source: {
      source_id: "models-dev-models-json",
      source_url: MODELS_URL,
      retrieved_at: retrievedAt,
      source_revision: `sha256:${sourceRevision}`,
    },
    filter: {
      field: "created",
      since: CUTOFF,
      comparison: ">=",
      semantics: "models.dev catalog created timestamp; not an official release-date assertion",
    },
    providers,
    models,
  };
}

function assertSafeSvg(contents: string, path: string): void {
  if (!/^\s*<svg\b[\s\S]*<\/svg>\s*$/u.test(contents)) {
    throw new Error(`logo 不是完整 SVG 文档: ${path}`);
  }
  if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']https?:/iu.test(contents)) {
    throw new Error(`logo 包含不允许的活动内容或外部引用: ${path}`);
  }
}

async function fetchBytes(url: string, accept: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${url} 响应超过 ${maxBytes} bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${url} 响应超过 ${maxBytes} bytes`);
  }
  return bytes;
}

async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

const rawBytes = await fetchBytes(MODELS_URL, "application/json", MAX_MODELS_BYTES);
const rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
const sourceRevision = sha256(rawBytes);
const previous = await readJson<ModelsDevCandidates>(SNAPSHOT_PATH).catch(() => null);
const sourceUnchanged = previous?.source.source_revision === `sha256:${sourceRevision}`;
const retrievedAt = sourceUnchanged
  ? previous.source.retrieved_at
  : (process.env.MODELS_DEV_RETRIEVED_AT ?? new Date().toISOString());
const snapshot = normalizeSnapshot(JSON.parse(rawText) as unknown, sourceRevision, retrievedAt);
const validators = await createValidators(REPOSITORY_ROOT);
const issues = validateWith(validators.modelsDevCandidates, snapshot, "upstream/models-dev-2026.json");
if (issues.length > 0) {
  throw new Error(`models.dev 候选快照校验失败:\n${formatValidationIssues(issues)}`);
}

const staging = join(REPOSITORY_ROOT, ".cache", `models-dev-2026-${process.pid}`);
await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "logos"), { recursive: true });
try {
  await writeFile(join(staging, "models-dev-2026.json"), stableJson(snapshot));
  for (const provider of snapshot.providers) {
    const logo = logoProvider(provider.provider_id);
    const logoPath = join(staging, "logos", `${provider.provider_id}.svg`);
    let logoContents: string;
    if (logo.sourceProviderId === "default") {
      logoContents = await readFile(join(LOGO_DIRECTORY, "default.svg"), "utf8");
    } else {
      logoContents = new TextDecoder("utf-8", { fatal: true }).decode(
        await fetchBytes(logo.sourceUrl, "image/svg+xml", MAX_LOGO_BYTES),
      );
    }
    assertSafeSvg(logoContents, logo.sourceUrl);
    await writeFile(logoPath, logoContents);
  }
  await atomicWrite(SNAPSHOT_PATH, await readFile(join(staging, "models-dev-2026.json")));
  for (const provider of snapshot.providers) {
    await atomicWrite(
      join(LOGO_DIRECTORY, `${provider.provider_id}.svg`),
      await readFile(join(staging, "logos", `${provider.provider_id}.svg`)),
    );
  }
  console.log(sourceUnchanged
    ? `models.dev 模型数据未变化，已重新校验 ${snapshot.providers.length} 家厂家 logo。`
    : `models.dev 2026 候选已更新：${snapshot.models.length} 条模型，${snapshot.providers.length} 家厂家。`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
