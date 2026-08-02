import { join, relative } from "node:path";

import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { listFiles } from "./files.js";
import { isPlainObject, readJson } from "./json.js";
import { loadSourceCatalog } from "./load.js";
import type {
  AliasEntry,
  AliasSet,
  CanonicalModel,
  FieldAnnotation,
  Offering,
  ParameterCapability,
  Provider,
  SourceCatalog,
  ValidationIssue,
} from "./types.js";

const SCHEMA_IDS = {
  alias: "https://llm-catalog.example.cn/schemas/alias.schema.json",
  canonical: "https://llm-catalog.example.cn/schemas/canonical-model.schema.json",
  catalog: "https://llm-catalog.example.cn/schemas/catalog.schema.json",
  manifest: "https://llm-catalog.example.cn/schemas/manifest.schema.json",
  offering: "https://llm-catalog.example.cn/schemas/offering.schema.json",
  provider: "https://llm-catalog.example.cn/schemas/provider.schema.json",
  providerShard: "https://llm-catalog.example.cn/schemas/provider-shard.schema.json",
  release: "https://llm-catalog.example.cn/schemas/release.schema.json",
  searchIndex: "https://llm-catalog.example.cn/schemas/search-index.schema.json",
  upstreamConfig: "https://llm-catalog.example.cn/schemas/upstream-config.schema.json",
} as const;

const TECHNICAL_ROOT_FIELDS = new Set(["$schema", "schema_version", "evidence", "field_annotations"]);
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "tenant",
  "tenantid",
  "apikey",
  "secret",
  "secretkey",
  "accesskey",
  "accesskeyid",
  "privatebaseurl",
  "envendpoints",
  "natinfo",
  "loadbalancing",
  "credential",
  "credentials",
  "deploymentoverride",
  "scopeapps",
]);

interface Validators {
  alias: ValidateFunction;
  canonical: ValidateFunction;
  catalog: ValidateFunction;
  manifest: ValidateFunction;
  offering: ValidateFunction;
  provider: ValidateFunction;
  providerShard: ValidateFunction;
  release: ValidateFunction;
  searchIndex: ValidateFunction;
  upstreamConfig: ValidateFunction;
}

function issue(
  code: string,
  file: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, file, path, message };
}

export async function createValidators(root: string): Promise<Validators> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormatsModule.default(ajv);
  for (const schemaPath of await listFiles(join(root, "schemas"))) {
    ajv.addSchema(await readJson<AnySchema>(schemaPath));
  }
  const get = (id: string): ValidateFunction => {
    const validator = ajv.getSchema(id);
    if (validator === undefined) {
      throw new Error(`未加载 Schema: ${id}`);
    }
    return validator;
  };
  return {
    alias: get(SCHEMA_IDS.alias),
    canonical: get(SCHEMA_IDS.canonical),
    catalog: get(SCHEMA_IDS.catalog),
    manifest: get(SCHEMA_IDS.manifest),
    offering: get(SCHEMA_IDS.offering),
    provider: get(SCHEMA_IDS.provider),
    providerShard: get(SCHEMA_IDS.providerShard),
    release: get(SCHEMA_IDS.release),
    searchIndex: get(SCHEMA_IDS.searchIndex),
    upstreamConfig: get(SCHEMA_IDS.upstreamConfig),
  };
}

function schemaIssues(
  validator: ValidateFunction,
  document: unknown,
  file: string,
): ValidationIssue[] {
  if (validator(document)) {
    return [];
  }
  return (validator.errors ?? []).map((error: ErrorObject) =>
    issue(
      "schema",
      file,
      error.instancePath || "/",
      `${error.message ?? "Schema 校验失败"} (${JSON.stringify(error.params)})`,
    ),
  );
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function factualLeafPaths(document: Record<string, unknown>): string[] {
  const leaves: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      leaves.push(path);
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      leaves.push(path);
      return;
    }
    for (const [key, child] of entries) {
      visit(child, `${path}/${escapePointer(key)}`);
    }
  };

  for (const [key, value] of Object.entries(document)) {
    if (!TECHNICAL_ROOT_FIELDS.has(key)) {
      visit(value, `/${escapePointer(key)}`);
    }
  }
  return leaves.sort((left, right) => left.localeCompare(right, "en"));
}

function annotationMatches(pattern: string, path: string): boolean {
  if (pattern === path) {
    return true;
  }
  if (!pattern.endsWith("/*")) {
    return false;
  }
  const prefix = pattern.slice(0, -2);
  return path.startsWith(`${prefix}/`);
}

function resolveAnnotation(
  annotations: Record<string, FieldAnnotation>,
  path: string,
): FieldAnnotation | undefined {
  const matches = Object.entries(annotations)
    .filter(([pattern]) => annotationMatches(pattern, path))
    .sort(([left], [right]) => right.length - left.length);
  return matches[0]?.[1];
}

export function validateEvidenceAndAnnotations(
  document: CanonicalModel | Provider | Offering | AliasSet,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sourceIds = new Set<string>();
  for (const [index, source] of document.evidence.entries()) {
    if (sourceIds.has(source.source_id)) {
      issues.push(
        issue("duplicate_source", file, `/evidence/${index}/source_id`, "source_id 重复"),
      );
    }
    sourceIds.add(source.source_id);
  }

  const documentRecord = document as unknown as Record<string, unknown>;
  const leafPaths = factualLeafPaths(documentRecord);
  for (const path of leafPaths) {
    const annotation = resolveAnnotation(document.field_annotations, path);
    if (annotation === undefined) {
      issues.push(issue("missing_annotation", file, path, "字段缺少 field_annotations 标记"));
      continue;
    }
    if (annotation.runtime_effective && annotation.metadata_only) {
      issues.push(
        issue(
          "annotation_conflict",
          file,
          path,
          "runtime_effective 与 metadata_only 不能同时为 true",
        ),
      );
    }
    if (!annotation.runtime_effective && !annotation.metadata_only && annotation.unsupported_reason === null) {
      issues.push(
        issue(
          "missing_unsupported_reason",
          file,
          path,
          "未进入当前运行时且并非展示字段时必须说明 unsupported_reason",
        ),
      );
    }
    for (const sourceId of annotation.source_ids) {
      if (!sourceIds.has(sourceId)) {
        issues.push(
          issue(
            "unknown_source_reference",
            file,
            path,
            `字段引用了不存在的 source_id: ${sourceId}`,
          ),
        );
      }
    }
  }

  for (const pattern of Object.keys(document.field_annotations)) {
    if (!leafPaths.some((path) => annotationMatches(pattern, path))) {
      issues.push(
        issue("stale_annotation", file, `/field_annotations/${escapePointer(pattern)}`, "标记未匹配任何字段"),
      );
    }
  }
  return issues;
}

export function validateLimitConsistency(
  limits: { max_context_tokens: number | "unknown"; max_input_tokens: number | "unknown"; max_output_tokens: number | "unknown" },
  file: string,
  path = "/limits",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (
    typeof limits.max_context_tokens === "number" &&
    typeof limits.max_input_tokens === "number" &&
    limits.max_input_tokens > limits.max_context_tokens
  ) {
    issues.push(
      issue("limit_inconsistent", file, `${path}/max_input_tokens`, "max_input_tokens 大于 max_context_tokens"),
    );
  }
  if (
    typeof limits.max_context_tokens === "number" &&
    typeof limits.max_output_tokens === "number" &&
    limits.max_output_tokens > limits.max_context_tokens
  ) {
    issues.push(
      issue("limit_inconsistent", file, `${path}/max_output_tokens`, "max_output_tokens 大于 max_context_tokens"),
    );
  }
  return issues;
}

function parameterIssues(
  capability: ParameterCapability,
  file: string,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (capability.range !== "unknown") {
    if (capability.range.minimum > capability.range.maximum) {
      issues.push(issue("invalid_parameter_range", file, `${path}/range`, "参数最小值大于最大值"));
    }
    if (
      typeof capability.official_default === "number" &&
      (capability.official_default < capability.range.minimum ||
        capability.official_default > capability.range.maximum)
    ) {
      issues.push(
        issue("invalid_official_default", file, `${path}/official_default`, "官方默认值超出声明范围"),
      );
    }
  }
  if (capability.supported === false && capability.official_default !== "unknown") {
    issues.push(
      issue("invalid_official_default", file, `${path}/official_default`, "不支持的参数不能声明官方默认值"),
    );
  }
  return issues;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function inspectString(value: string, file: string, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(value) || /\bLTAI[A-Za-z0-9]{12,}\b/.test(value)) {
    issues.push(issue("possible_secret", file, path, "疑似包含真实访问密钥"));
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (
        url.username !== "" ||
        url.password !== "" ||
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname.endsWith(".local") ||
        isPrivateIpv4(hostname)
      ) {
        issues.push(issue("private_url", file, path, "公开目录禁止私有地址、用户信息或回环地址"));
      }
    } catch {
      issues.push(issue("invalid_url", file, path, "URL 无法解析"));
    }
  }
  return issues;
}

export function scanForTenantData(
  value: unknown,
  file = "document",
  path = "",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof value === "string") {
    return inspectString(value, file, path || "/");
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      issues.push(...scanForTenantData(item, file, `${path}/${index}`));
    });
    return issues;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      const childPath = `${path}/${escapePointer(key)}`;
      if (FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey)) {
        issues.push(issue("tenant_data_key", file, childPath, `禁止公开租户部署字段: ${key}`));
      }
      issues.push(...scanForTenantData(child, file, childPath));
    }
  }
  return issues;
}

export function validateIdentityAndReferences(catalog: SourceCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const canonicalIds = new Set<string>();
  const canonicalById = new Map<string, CanonicalModel>();
  const providerIds = new Set<string>();
  const offeringIds = new Set<string>();
  const providerModelIds = new Set<string>();

  for (const model of catalog.models) {
    const file = `catalog/models/${model.canonical_id}.json`;
    if (canonicalIds.has(model.canonical_id)) {
      issues.push(issue("duplicate_canonical_id", file, "/canonical_id", "canonical_id 重复"));
    }
    canonicalIds.add(model.canonical_id);
    canonicalById.set(model.canonical_id, model);
  }
  for (const provider of catalog.providers) {
    const file = `catalog/providers/${provider.provider_id}.json`;
    if (providerIds.has(provider.provider_id)) {
      issues.push(issue("duplicate_provider_id", file, "/provider_id", "provider_id 重复"));
    }
    providerIds.add(provider.provider_id);
  }
  for (const offering of catalog.offerings) {
    const file = `catalog/offerings/${offering.offering_id}.json`;
    if (offeringIds.has(offering.offering_id)) {
      issues.push(issue("duplicate_offering_id", file, "/offering_id", "offering_id 重复"));
    }
    offeringIds.add(offering.offering_id);
    const providerModelId = `${offering.provider_id}\u0000${offering.api_model_id}`;
    if (providerModelIds.has(providerModelId)) {
      issues.push(
        issue("duplicate_api_model_id", file, "/api_model_id", "同一 provider 下 api_model_id 重复"),
      );
    }
    providerModelIds.add(providerModelId);
    const canonical = canonicalById.get(offering.canonical_id);
    if (canonical === undefined) {
      issues.push(issue("missing_canonical", file, "/canonical_id", "offering 引用了不存在的 canonical model"));
    } else {
      if (offering.status !== offering.lifecycle.status) {
        issues.push(
          issue("lifecycle_status_mismatch", file, "/status", "offering.status 与 lifecycle.status 不一致"),
        );
      }
      const isEmbeddingOffering = offering.protocols.includes("embeddings");
      if (
        (canonical.kind === "embedding" && (!isEmbeddingOffering || offering.embedding === null)) ||
        (canonical.kind === "chat" && (isEmbeddingOffering || offering.embedding !== null))
      ) {
        issues.push(
          issue("model_kind_mismatch", file, "/protocols", "offering 协议/Embedding 数据与 canonical kind 不一致"),
        );
      }
      for (const field of [
        "max_context_tokens",
        "max_input_tokens",
        "max_output_tokens",
      ] as const) {
        const canonicalLimit = canonical.limits[field];
        const offeringLimit = offering.limits[field];
        if (
          typeof canonicalLimit === "number" &&
          typeof offeringLimit === "number" &&
          offeringLimit > canonicalLimit
        ) {
          issues.push(
            issue(
              "offering_limit_exceeds_canonical",
              file,
              `/limits/${field}`,
              `${field} 超过 canonical model 已验证上限`,
            ),
          );
        }
      }
      for (const direction of ["input_modalities", "output_modalities"] as const) {
        const canonicalModalities = new Set(canonical.modalities[direction]);
        for (const modality of offering.modalities[direction]) {
          if (!canonicalModalities.has(modality)) {
            issues.push(
              issue(
                "offering_modality_exceeds_canonical",
                file,
                `/modalities/${direction}`,
                `${modality} 未在 canonical model 中声明`,
              ),
            );
          }
        }
      }
    }
    const provider = catalog.providers.find((candidate) => candidate.provider_id === offering.provider_id);
    if (provider === undefined) {
      issues.push(issue("missing_provider", file, "/provider_id", "offering 引用了不存在的 provider"));
    } else {
      for (const protocol of offering.protocols) {
        if (!provider.protocols.includes(protocol)) {
          issues.push(
            issue("provider_protocol_mismatch", file, "/protocols", `provider 未声明协议 ${protocol}`),
          );
        }
      }
    }
  }

  for (const model of catalog.models) {
    if (
      model.lifecycle.replacement !== "unknown" &&
      !canonicalIds.has(model.lifecycle.replacement)
    ) {
      issues.push(
        issue(
          "missing_replacement",
          `catalog/models/${model.canonical_id}.json`,
          "/lifecycle/replacement",
          "canonical replacement 不存在",
        ),
      );
    }
  }
  for (const offering of catalog.offerings) {
    if (
      offering.lifecycle.replacement !== "unknown" &&
      !offeringIds.has(offering.lifecycle.replacement)
    ) {
      issues.push(
        issue(
          "missing_replacement",
          `catalog/offerings/${offering.offering_id}.json`,
          "/lifecycle/replacement",
          "offering replacement 不存在",
        ),
      );
    }
  }

  const aliasEntries = catalog.aliases.flatMap((set) => set.entries);
  const aliasMap = new Map<string, AliasEntry>();
  const aliasKey = (entry: Pick<AliasEntry, "provider_id" | "alias">): string =>
    `${entry.provider_id ?? "*"}:${entry.alias}`;
  for (const entry of aliasEntries) {
    const key = aliasKey(entry);
    if (aliasMap.has(key)) {
      issues.push(issue("duplicate_alias", "catalog/aliases", "/entries", `别名重复: ${key}`));
    }
    aliasMap.set(key, entry);
    if (entry.provider_id !== null && !providerIds.has(entry.provider_id)) {
      issues.push(issue("missing_provider", "catalog/aliases", "/entries", `别名 provider 不存在: ${entry.provider_id}`));
    }
    if (entry.target_type === "canonical" && !canonicalIds.has(entry.target_id)) {
      issues.push(issue("missing_alias_target", "catalog/aliases", "/entries", `canonical 目标不存在: ${entry.target_id}`));
    }
    if (entry.target_type === "offering" && !offeringIds.has(entry.target_id)) {
      issues.push(issue("missing_alias_target", "catalog/aliases", "/entries", `offering 目标不存在: ${entry.target_id}`));
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitAlias = (key: string): void => {
    if (visiting.has(key)) {
      issues.push(issue("alias_cycle", "catalog/aliases", "/entries", `检测到别名循环: ${key}`));
      return;
    }
    if (visited.has(key)) {
      return;
    }
    const entry = aliasMap.get(key);
    if (entry === undefined) {
      issues.push(issue("missing_alias_target", "catalog/aliases", "/entries", `alias 目标不存在: ${key}`));
      return;
    }
    visiting.add(key);
    if (entry.target_type === "alias") {
      const targetKey = `${entry.provider_id ?? "*"}:${entry.target_id}`;
      visitAlias(targetKey);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of aliasMap.keys()) {
    visitAlias(key);
  }
  return issues;
}

export function validateSchemaVersionConsistency(
  catalog: SourceCatalog,
  upstreamConfig?: unknown,
): ValidationIssue[] {
  const expected = catalog.release.schema_version;
  const documents: Array<{ file: string; schema_version: string }> = [
    ...catalog.models.map((model) => ({
      file: `catalog/models/${model.canonical_id}.json`,
      schema_version: model.schema_version,
    })),
    ...catalog.providers.map((provider) => ({
      file: `catalog/providers/${provider.provider_id}.json`,
      schema_version: provider.schema_version,
    })),
    ...catalog.offerings.map((offering) => ({
      file: `catalog/offerings/${offering.offering_id}.json`,
      schema_version: offering.schema_version,
    })),
    ...catalog.aliases.map((aliasSet) => ({
      file: `catalog/aliases/${aliasSet.alias_set_id}.json`,
      schema_version: aliasSet.schema_version,
    })),
  ];
  if (
    isPlainObject(upstreamConfig) &&
    typeof upstreamConfig.schema_version === "string"
  ) {
    documents.push({
      file: "catalog/upstreams.json",
      schema_version: upstreamConfig.schema_version,
    });
  }
  return documents
    .filter((document) => document.schema_version !== expected)
    .map((document) =>
      issue(
        "schema_version_mismatch",
        document.file,
        "/schema_version",
        `文档 Schema ${document.schema_version} 与 release ${expected} 不一致`,
      ),
    );
}

export async function validateSourceCatalog(root: string): Promise<{
  catalog: SourceCatalog;
  issues: ValidationIssue[];
  validators: Validators;
}> {
  const [catalog, validators, upstreamConfig] = await Promise.all([
    loadSourceCatalog(root),
    createValidators(root),
    readJson<unknown>(join(root, "catalog", "upstreams.json")),
  ]);
  const issues: ValidationIssue[] = [];

  issues.push(...schemaIssues(validators.release, catalog.release, "catalog/release.json"));
  issues.push(
    ...schemaIssues(validators.upstreamConfig, upstreamConfig, "catalog/upstreams.json"),
  );

  for (const model of catalog.models) {
    const file = `catalog/models/${model.canonical_id}.json`;
    issues.push(...schemaIssues(validators.canonical, model, file));
    issues.push(...validateEvidenceAndAnnotations(model, file));
    issues.push(...validateLimitConsistency(model.limits, file));
    issues.push(...scanForTenantData(model, file));
    if (
      model.kind === "embedding" &&
      model.embedding !== null &&
      typeof model.limits.max_input_tokens === "number" &&
      typeof model.embedding.max_input_tokens === "number" &&
      model.limits.max_input_tokens !== model.embedding.max_input_tokens
    ) {
      issues.push(
        issue(
          "embedding_limit_mismatch",
          file,
          "/embedding/max_input_tokens",
          "embedding.max_input_tokens 与 limits.max_input_tokens 不一致",
        ),
      );
    }
  }
  for (const provider of catalog.providers) {
    const file = `catalog/providers/${provider.provider_id}.json`;
    issues.push(...schemaIssues(validators.provider, provider, file));
    issues.push(...validateEvidenceAndAnnotations(provider, file));
    issues.push(...scanForTenantData(provider, file));
  }
  for (const offering of catalog.offerings) {
    const file = `catalog/offerings/${offering.offering_id}.json`;
    issues.push(...schemaIssues(validators.offering, offering, file));
    issues.push(...validateEvidenceAndAnnotations(offering, file));
    issues.push(...validateLimitConsistency(offering.limits, file));
    issues.push(
      ...parameterIssues(offering.sampling_parameters.temperature, file, "/sampling_parameters/temperature"),
      ...parameterIssues(offering.sampling_parameters.top_p, file, "/sampling_parameters/top_p"),
      ...parameterIssues(offering.sampling_parameters.top_k, file, "/sampling_parameters/top_k"),
      ...scanForTenantData(offering, file),
    );
  }
  for (const aliasSet of catalog.aliases) {
    const file = `catalog/aliases/${aliasSet.alias_set_id}.json`;
    issues.push(...schemaIssues(validators.alias, aliasSet, file));
    issues.push(...validateEvidenceAndAnnotations(aliasSet, file));
    issues.push(...scanForTenantData(aliasSet, file));
  }
  issues.push(...validateIdentityAndReferences(catalog));
  issues.push(...validateSchemaVersionConsistency(catalog, upstreamConfig));

  const releaseFile = relative(root, join(root, "catalog", "release.json"));
  if (!/^\d{4}\.\d{2}\.\d+$/.test(catalog.release.catalog_version)) {
    issues.push(issue("invalid_release", releaseFile, "/catalog_version", "catalog_version 格式错误"));
  }
  if (Number.isNaN(Date.parse(catalog.release.generated_at))) {
    issues.push(issue("invalid_release", releaseFile, "/generated_at", "generated_at 不是有效时间"));
  }
  return { catalog, issues, validators };
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .sort((left, right) =>
      `${left.file}${left.path}${left.code}`.localeCompare(`${right.file}${right.path}${right.code}`, "en"),
    )
    .map((item) => `${item.file}${item.path} [${item.code}] ${item.message}`)
    .join("\n");
}

export async function assertValidSourceCatalog(root: string): Promise<SourceCatalog> {
  const { catalog, issues } = await validateSourceCatalog(root);
  if (issues.length > 0) {
    throw new Error(`目录校验失败（${issues.length} 项）:\n${formatValidationIssues(issues)}`);
  }
  return catalog;
}

export function validateWith(
  validator: ValidateFunction,
  value: unknown,
  file: string,
): ValidationIssue[] {
  return schemaIssues(validator, value, file);
}
