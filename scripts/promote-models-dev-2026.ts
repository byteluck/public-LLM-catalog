import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readJson, stableJson } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { createValidators, formatValidationIssues, validateWith } from "../src/validate.js";
import type {
  CanonicalModel,
  FieldAnnotation,
  ModelsDevCandidate,
  ModelsDevCandidates,
  Offering,
  Provider,
  SourceEvidence,
} from "../src/types.js";

const WRITE = process.argv.includes("--write");
const SOURCE_ID = "models-dev-2026-observation";
const MODEL_SCHEMA = "https://llm-catalog.example.cn/schemas/canonical-model.schema.json";
const OFFERING_SCHEMA = "https://llm-catalog.example.cn/schemas/offering.schema.json";
const PROVIDER_SCHEMA = "https://llm-catalog.example.cn/schemas/provider.schema.json";

interface ReleaseInput {
  schema_version: string;
}

function fieldAnnotation(input: {
  runtime_effective: boolean;
  metadata_only: boolean;
  adapter_mapping: string | null;
  unsupported_reason: string | null;
}): FieldAnnotation {
  return { ...input, source_ids: [SOURCE_ID] };
}

function metadataAnnotation(): FieldAnnotation {
  return fieldAnnotation({
    runtime_effective: false,
    metadata_only: true,
    adapter_mapping: null,
    unsupported_reason: null,
  });
}

function unsupportedAnnotation(mapping: string, reason: string): FieldAnnotation {
  return fieldAnnotation({
    runtime_effective: false,
    metadata_only: false,
    adapter_mapping: mapping,
    unsupported_reason: reason,
  });
}

function evidence(snapshot: ModelsDevCandidates, candidate?: ModelsDevCandidate): SourceEvidence {
  return {
    source_id: SOURCE_ID,
    source_url: snapshot.source.source_url,
    source_type: "upstream_aggregator",
    retrieved_at: snapshot.source.retrieved_at,
    verified_at: snapshot.source.retrieved_at,
    confidence: "low",
    redistribution: "attribution_required",
    notes: candidate === undefined
      ? "仅由 models.dev 2026 直连记录发现；未据此确认厂商官网、协议、公开 Base URL、鉴权或国内可访问性。"
      : `仅记录 models.dev 直连条目 ${candidate.api_model_id}（上游收录日期 ${candidate.models_dev_created_at}）。该日期不是官方发布日期；未核验运行时能力、协议或请求模型标识。`,
  };
}

function canonicalDocument(
  snapshot: ModelsDevCandidates,
  candidate: ModelsDevCandidate,
  schemaVersion: string,
): CanonicalModel {
  const unverifiedRuntime = "仅有 models.dev 聚合记录，未取得厂商官方运行时文档；不得据此自动装配 Agent 或发送参数。";
  return {
    $schema: MODEL_SCHEMA,
    schema_version: schemaVersion,
    canonical_id: candidate.canonical_slug,
    manufacturer_id: candidate.provider_id,
    name: candidate.name,
    family: "unknown",
    aliases: [],
    kind: "chat",
    lifecycle: {
      release_date: "unknown",
      last_updated: "unknown",
      status: "unknown",
      deprecated_at: "unknown",
      replacement: "unknown",
    },
    limits: {
      max_context_tokens: candidate.context_length,
      max_input_tokens: "unknown",
      max_output_tokens: candidate.max_output_tokens,
    },
    modalities: {
      input_modalities: candidate.input_modalities,
      output_modalities: candidate.output_modalities,
    },
    capabilities: {
      agent: {
        streaming: "unknown",
        stream_usage: "unknown",
        system_message: "unknown",
        tool_call: "unknown",
        tool_choice: "unknown",
        parallel_tool_calls: "unknown",
        strict_tools: "unknown",
        structured_output: "unknown",
        json_schema: "unknown",
      },
      reasoning: {
        supported: "unknown",
        modes: ["unknown"],
        effort_values: ["unknown"],
        budget_tokens: "unknown",
        interleaved_reasoning: "unknown",
        protocol_fields: {},
      },
    },
    embedding: null,
    evidence: [evidence(snapshot, candidate)],
    field_annotations: {
      "/canonical_id": metadataAnnotation(),
      "/manufacturer_id": metadataAnnotation(),
      "/name": metadataAnnotation(),
      "/family": metadataAnnotation(),
      "/aliases": metadataAnnotation(),
      "/kind": unsupportedAnnotation("FDE modelType role-admission gate", unverifiedRuntime),
      "/lifecycle/*": metadataAnnotation(),
      "/limits/*": unsupportedAnnotation("runtime token-limit guard", unverifiedRuntime),
      "/modalities/*": unsupportedAnnotation("FDE role/content validation", unverifiedRuntime),
      "/capabilities/*": unsupportedAnnotation(
        "capability-aware Chat adapter / DeepAgent admission",
        unverifiedRuntime,
      ),
      "/embedding": metadataAnnotation(),
    },
  };
}

function offeringDocument(
  snapshot: ModelsDevCandidates,
  candidate: ModelsDevCandidate,
  schemaVersion: string,
): Offering {
  const unverifiedRuntime = "仅有 models.dev 聚合记录；API 协议、真实请求模型标识和全部运行时能力均未获官方核验，默认不得发送。";
  const unknownParameter = {
    supported: "unknown" as const,
    range: "unknown" as const,
    official_default: "unknown" as const,
    protocol_mapping: {},
  };
  return {
    $schema: OFFERING_SCHEMA,
    schema_version: schemaVersion,
    offering_id: candidate.canonical_slug,
    provider_id: candidate.provider_id,
    canonical_id: candidate.canonical_slug,
    api_model_id: candidate.api_model_id,
    name: candidate.name,
    status: "unknown",
    lifecycle: {
      release_date: "unknown",
      last_updated: "unknown",
      status: "unknown",
      deprecated_at: "unknown",
      replacement: "unknown",
    },
    protocols: "unknown",
    limits: {
      max_context_tokens: candidate.context_length,
      max_input_tokens: "unknown",
      max_output_tokens: candidate.max_output_tokens,
    },
    modalities: {
      input_modalities: candidate.input_modalities,
      output_modalities: candidate.output_modalities,
    },
    capabilities: {
      agent: {
        streaming: "unknown",
        stream_usage: "unknown",
        system_message: "unknown",
        tool_call: "unknown",
        tool_choice: "unknown",
        parallel_tool_calls: "unknown",
        strict_tools: "unknown",
        structured_output: "unknown",
        json_schema: "unknown",
      },
      reasoning: {
        supported: "unknown",
        modes: ["unknown"],
        effort_values: ["unknown"],
        budget_tokens: "unknown",
        interleaved_reasoning: "unknown",
        protocol_fields: {},
      },
    },
    sampling_parameters: {
      temperature: unknownParameter,
      top_p: unknownParameter,
      top_k: unknownParameter,
    },
    embedding: null,
    evidence: [evidence(snapshot, candidate)],
    field_annotations: {
      "/offering_id": metadataAnnotation(),
      "/provider_id": unsupportedAnnotation("provider adapter selection", unverifiedRuntime),
      "/canonical_id": metadataAnnotation(),
      "/api_model_id": unsupportedAnnotation("ChatOpenAI.model / ChatAnthropic.model", unverifiedRuntime),
      "/name": metadataAnnotation(),
      "/status": metadataAnnotation(),
      "/lifecycle/*": metadataAnnotation(),
      "/protocols": unsupportedAnnotation("Chat adapter protocol selection", unverifiedRuntime),
      "/limits/*": unsupportedAnnotation("runtime token-limit guard", unverifiedRuntime),
      "/modalities/*": unsupportedAnnotation("FDE role/content validation", unverifiedRuntime),
      "/capabilities/*": unsupportedAnnotation(
        "capability-aware Chat adapter / DeepAgent admission",
        unverifiedRuntime,
      ),
      "/sampling_parameters/*": unsupportedAnnotation(
        "three-layer policy merge then constructor filtering",
        unverifiedRuntime,
      ),
      "/embedding": metadataAnnotation(),
    },
  };
}

function providerDocument(
  snapshot: ModelsDevCandidates,
  providerId: string,
  name: string,
  schemaVersion: string,
): Provider {
  const unverifiedRuntime = "仅有 models.dev 聚合记录，未取得供应商官方协议或端点资料；不得生成租户部署或自动选择 adapter。";
  return {
    $schema: PROVIDER_SCHEMA,
    schema_version: schemaVersion,
    provider_id: providerId,
    name,
    website: "unknown",
    domestic_access: "unknown",
    api_key_required: "unknown",
    status: "unknown",
    protocols: "unknown",
    public_base_urls: "unknown",
    evidence: [evidence(snapshot)],
    field_annotations: {
      "/provider_id": metadataAnnotation(),
      "/name": metadataAnnotation(),
      "/website": metadataAnnotation(),
      "/domestic_access": metadataAnnotation(),
      "/api_key_required": metadataAnnotation(),
      "/status": metadataAnnotation(),
      "/protocols": unsupportedAnnotation("provider adapter selection", unverifiedRuntime),
      "/public_base_urls": unsupportedAnnotation(
        "tenant deployment endpoint resolver",
        unverifiedRuntime,
      ),
    },
  };
}

function documentPath(directory: "models" | "offerings", canonicalId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(canonicalId) || canonicalId.includes("..")) {
    throw new Error(`不安全的 canonical_slug: ${canonicalId}`);
  }
  return join(REPOSITORY_ROOT, "catalog", directory, `${canonicalId}.json`);
}

async function existingJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeIfMissingOrIdentical(
  path: string,
  document: unknown,
  keepExisting = false,
): Promise<"created" | "unchanged" | "kept_existing"> {
  const expected = stableJson(document);
  const existing = await existingJson(path);
  if (existing !== null) {
    const identical = stableJson(existing) === expected;
    if (!keepExisting && !identical) {
      throw new Error(`拒绝覆盖已有且不同的权威文档: ${path}`);
    }
    return identical ? "unchanged" : "kept_existing";
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected);
  return "created";
}

const [snapshot, release, validators] = await Promise.all([
  readJson<ModelsDevCandidates>(join(REPOSITORY_ROOT, "upstream", "models-dev-2026.json")),
  readJson<ReleaseInput>(join(REPOSITORY_ROOT, "catalog", "release.json")),
  createValidators(REPOSITORY_ROOT),
]);
const direct = snapshot.models
  .filter((candidate) => candidate.route_kind === "direct")
  .sort((left, right) => left.canonical_slug.localeCompare(right.canonical_slug, "en"));
const canonicalIds = new Set<string>();
for (const candidate of direct) {
  if (canonicalIds.has(candidate.canonical_slug)) {
    throw new Error(`models.dev 直连记录 canonical_slug 重复: ${candidate.canonical_slug}`);
  }
  canonicalIds.add(candidate.canonical_slug);
}

const providerNames = new Map(snapshot.providers.map((provider) => [provider.provider_id, provider.name]));
const providers = [...new Set(direct.map((candidate) => candidate.provider_id))]
  .sort((left, right) => left.localeCompare(right, "en"));
for (const providerId of providers) {
  if (!providerNames.has(providerId)) {
    throw new Error(`models.dev 直连记录引用了未声明 provider: ${providerId}`);
  }
}

const canonicalDocuments = direct.map((candidate) => canonicalDocument(snapshot, candidate, release.schema_version));
const offeringDocuments = direct.map((candidate) => offeringDocument(snapshot, candidate, release.schema_version));
const providerDocuments = providers.map((providerId) =>
  providerDocument(snapshot, providerId, providerNames.get(providerId)!, release.schema_version),
);
const issues = [
  ...canonicalDocuments.flatMap((document) =>
    validateWith(validators.canonical, document, `catalog/models/${document.canonical_id}.json`),
  ),
  ...offeringDocuments.flatMap((document) =>
    validateWith(validators.offering, document, `catalog/offerings/${document.offering_id}.json`),
  ),
  ...providerDocuments.flatMap((document) =>
    validateWith(validators.provider, document, `catalog/providers/${document.provider_id}.json`),
  ),
];
if (issues.length > 0) {
  throw new Error(`models.dev 提升文档 Schema 校验失败:\n${formatValidationIssues(issues)}`);
}

const providerPaths = providerDocuments.map((document) =>
  [join(REPOSITORY_ROOT, "catalog", "providers", `${document.provider_id}.json`), document, true] as const,
);
const paths = [
  ...canonicalDocuments.map((document) => [documentPath("models", document.canonical_id), document, false] as const),
  ...offeringDocuments.map((document) => [documentPath("offerings", document.offering_id), document, false] as const),
  ...providerPaths,
];

if (!WRITE) {
  console.log(
    `计划提升 ${canonicalDocuments.length} 个 canonical model、${offeringDocuments.length} 个 offering、${providerDocuments.length} 个 provider；传入 --write 才会写入 catalog/。`,
  );
} else {
  let created = 0;
  let unchanged = 0;
  let keptExisting = 0;
  for (const [path, document, keepExisting] of paths) {
    const result = await writeIfMissingOrIdentical(path, document, keepExisting);
    if (result === "created") {
      created += 1;
    } else if (result === "unchanged") {
      unchanged += 1;
    } else {
      keptExisting += 1;
    }
  }
  console.log(
    `已提升 models.dev 2026 直连记录：新建 ${created} 个文档，已有相同文档 ${unchanged} 个，保留既有 provider 文档 ${keptExisting} 个。`,
  );
}
