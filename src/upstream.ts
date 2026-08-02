import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isPlainObject, sha256, stableJson } from "./json.js";
import type { SourceCatalog, TriState } from "./types.js";

export interface UpstreamSourceConfig {
  source_id: string;
  url: string;
  format: "models_dev" | "litellm" | "openai_models";
  enabled: boolean;
  api_key_env: string | null;
  max_bytes: number;
}

export interface UpstreamConfig {
  $schema: string;
  schema_version: string;
  targets: string[];
  sources: UpstreamSourceConfig[];
}

export interface CandidateModel {
  upstream_key: string;
  api_model_id: string;
  limits: {
    max_context_tokens?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
  };
  capabilities: {
    reasoning?: TriState;
    tool_call?: TriState;
    tool_choice?: TriState;
    parallel_tool_calls?: TriState;
    structured_output?: TriState;
  };
}

export interface CandidateSnapshot {
  schema_version: string;
  source_id: string;
  source_url: string;
  normalized_sha256: string;
  models: CandidateModel[];
}

export interface CandidateReviewItem {
  type: "conflict" | "deletion" | "capability_degradation" | "limit_decrease";
  source_id: string;
  model: string;
  field: string;
  previous: unknown;
  candidate: unknown;
  message: string;
}

export interface CandidateReview {
  schema_version: string;
  review_required: boolean;
  items: CandidateReviewItem[];
}

function optionalNumber(record: Record<string, unknown>, paths: string[][]): number | undefined {
  for (const path of paths) {
    let value: unknown = record;
    for (const segment of path) {
      if (!isPlainObject(value)) {
        value = undefined;
        break;
      }
      value = value[segment];
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function optionalBoolean(record: Record<string, unknown>, keys: string[]): TriState | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function candidateFromRecord(upstreamKey: string, apiModelId: string, record: Record<string, unknown>): CandidateModel {
  const limits = {
    max_context_tokens: optionalNumber(record, [
      ["max_context_tokens"],
      ["context_window"],
      ["limit", "context"],
    ]),
    max_input_tokens: optionalNumber(record, [["max_input_tokens"]]),
    max_output_tokens: optionalNumber(record, [
      ["max_output_tokens"],
      ["limit", "output"],
    ]),
  };
  const capabilities = {
    reasoning: optionalBoolean(record, ["supports_reasoning", "reasoning"]),
    tool_call: optionalBoolean(record, ["supports_function_calling", "tool_call"]),
    tool_choice: optionalBoolean(record, ["supports_tool_choice", "tool_choice"]),
    parallel_tool_calls: optionalBoolean(record, [
      "supports_parallel_function_calling",
      "parallel_tool_calls",
    ]),
    structured_output: optionalBoolean(record, [
      "supports_response_schema",
      "supports_structured_output",
    ]),
  };
  return {
    upstream_key: upstreamKey,
    api_model_id: apiModelId,
    limits: Object.fromEntries(
      Object.entries(limits).filter((entry): entry is [string, number] => entry[1] !== undefined),
    ),
    capabilities: Object.fromEntries(
      Object.entries(capabilities).filter(
        (entry): entry is [string, TriState] => entry[1] !== undefined,
      ),
    ),
  };
}

function targetMatches(value: string, target: string): boolean {
  const normalized = value.toLowerCase();
  const expected = target.toLowerCase();
  return normalized === expected || normalized.endsWith(`/${expected}`) || normalized.endsWith(`:${expected}`);
}

function collectRecords(payload: unknown, targets: string[]): CandidateModel[] {
  const found: CandidateModel[] = [];
  const visit = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    const pathKey = path.at(-1) ?? "root";
    const declaredIds = [value.id, value.model, value.model_name]
      .filter((item): item is string => typeof item === "string");
    const identifiers = [pathKey, ...declaredIds];
    for (const target of targets) {
      const matched = identifiers.find((identifier) => targetMatches(identifier, target));
      if (matched !== undefined) {
        found.push(candidateFromRecord(path.join("/"), matched, value));
        break;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, [...path, key]);
    }
  };
  visit(payload, []);
  const deduplicated = new Map<string, CandidateModel>();
  for (const candidate of found) {
    const key = `${candidate.upstream_key}\u0000${candidate.api_model_id}`;
    deduplicated.set(key, candidate);
  }
  return [...deduplicated.values()].sort((left, right) =>
    `${left.api_model_id}\u0000${left.upstream_key}`.localeCompare(
      `${right.api_model_id}\u0000${right.upstream_key}`,
      "en",
    ),
  );
}

export function normalizeCandidateSnapshot(input: {
  schemaVersion: string;
  source: UpstreamSourceConfig;
  targets: string[];
  payload: unknown;
}): CandidateSnapshot {
  const models = collectRecords(input.payload, input.targets);
  const normalized = { models };
  return {
    schema_version: input.schemaVersion,
    source_id: input.source.source_id,
    source_url: input.source.url,
    normalized_sha256: sha256(stableJson(normalized)),
    models,
  };
}

function flattenedFacts(model: CandidateModel): Map<string, unknown> {
  const facts = new Map<string, unknown>();
  for (const [field, value] of Object.entries(model.limits)) {
    facts.set(`limits.${field}`, value);
  }
  for (const [field, value] of Object.entries(model.capabilities)) {
    facts.set(`capabilities.${field}`, value);
  }
  return facts;
}

function currentCatalogFacts(catalog: SourceCatalog, apiModelId: string): Map<string, unknown> | null {
  const offering = catalog.offerings.find((item) => targetMatches(item.api_model_id, apiModelId));
  if (offering === undefined) {
    return null;
  }
  return new Map<string, unknown>([
    ["limits.max_context_tokens", offering.limits.max_context_tokens],
    ["limits.max_input_tokens", offering.limits.max_input_tokens],
    ["limits.max_output_tokens", offering.limits.max_output_tokens],
    ["capabilities.reasoning", offering.capabilities.reasoning.supported],
    ["capabilities.tool_call", offering.capabilities.agent.tool_call],
    ["capabilities.tool_choice", offering.capabilities.agent.tool_choice],
    ["capabilities.parallel_tool_calls", offering.capabilities.agent.parallel_tool_calls],
    ["capabilities.structured_output", offering.capabilities.agent.structured_output],
  ]);
}

export function assessCandidateChange(input: {
  previous: CandidateSnapshot | null;
  candidate: CandidateSnapshot;
  catalog: SourceCatalog;
}): CandidateReviewItem[] {
  const items: CandidateReviewItem[] = [];
  const previousModels = new Map(
    (input.previous?.models ?? []).map((model) => [model.upstream_key, model]),
  );
  const candidateModels = new Map(input.candidate.models.map((model) => [model.upstream_key, model]));

  for (const [key, previous] of previousModels) {
    if (!candidateModels.has(key)) {
      items.push({
        type: "deletion",
        source_id: input.candidate.source_id,
        model: previous.api_model_id,
        field: "model",
        previous: key,
        candidate: null,
        message: "上游候选中模型消失，必须人工确认生命周期，不能自动删除目录模型。",
      });
    }
  }

  for (const candidate of input.candidate.models) {
    const previous = previousModels.get(candidate.upstream_key);
    if (previous !== undefined) {
      const previousFacts = flattenedFacts(previous);
      const candidateFacts = flattenedFacts(candidate);
      for (const [field, previousValue] of previousFacts) {
        const value = candidateFacts.get(field);
        if (
          field.startsWith("capabilities.") &&
          previousValue === true &&
          value !== true
        ) {
          items.push({
            type: "capability_degradation",
            source_id: input.candidate.source_id,
            model: candidate.api_model_id,
            field,
            previous: previousValue,
            candidate: value === undefined ? null : value,
            message: "上游能力从 true 变为 false/unknown/缺失，必须人工审核。",
          });
        }
        if (
          field.startsWith("limits.") &&
          typeof previousValue === "number" &&
          typeof value === "number" &&
          value < previousValue
        ) {
          items.push({
            type: "limit_decrease",
            source_id: input.candidate.source_id,
            model: candidate.api_model_id,
            field,
            previous: previousValue,
            candidate: value,
            message: "上游限额下降，必须人工审核。",
          });
        }
      }
    }

    const authoritative = currentCatalogFacts(input.catalog, candidate.api_model_id);
    if (authoritative !== null) {
      for (const [field, value] of flattenedFacts(candidate)) {
        const current = authoritative.get(field);
        if (current !== undefined && current !== "unknown" && current !== value) {
          items.push({
            type: "conflict",
            source_id: input.candidate.source_id,
            model: candidate.api_model_id,
            field,
            previous: current,
            candidate: value,
            message: "聚合源候选与已验证目录事实冲突；聚合源不得覆盖官方证据。",
          });
        }
      }
    }
  }
  return items;
}

export function assessCrossSourceConflicts(
  snapshots: CandidateSnapshot[],
): CandidateReviewItem[] {
  const firstSeen = new Map<string, { sourceId: string; value: unknown }>();
  const conflicts: CandidateReviewItem[] = [];
  for (const snapshot of [...snapshots].sort((left, right) =>
    left.source_id.localeCompare(right.source_id, "en"),
  )) {
    for (const model of snapshot.models) {
      for (const [field, value] of flattenedFacts(model)) {
        const key = `${model.api_model_id}\u0000${field}`;
        const previous = firstSeen.get(key);
        if (previous === undefined) {
          firstSeen.set(key, { sourceId: snapshot.source_id, value });
        } else if (JSON.stringify(previous.value) !== JSON.stringify(value)) {
          conflicts.push({
            type: "conflict",
            source_id: snapshot.source_id,
            model: model.api_model_id,
            field,
            previous: { source_id: previous.sourceId, value: previous.value },
            candidate: value,
            message: "不同上游候选对同一字段给出冲突值，必须回到官方来源复核。",
          });
        }
      }
    }
  }
  return conflicts;
}

async function fetchPayload(source: UpstreamSourceConfig): Promise<unknown> {
  const headers = new Headers({ accept: "application/json" });
  if (source.api_key_env !== null) {
    const key = process.env[source.api_key_env];
    if (key === undefined || key === "") {
      throw new Error(`MISSING_KEY:${source.api_key_env}`);
    }
    headers.set("authorization", `Bearer ${key}`);
  }
  const response = await fetch(source.url, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${source.source_id} HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > source.max_bytes) {
    throw new Error(`${source.source_id} 响应超过 max_bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > source.max_bytes) {
    throw new Error(`${source.source_id} 响应超过 max_bytes`);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function readPrevious(path: string): Promise<CandidateSnapshot | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CandidateSnapshot;
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, value);
  await rename(temporary, path);
}

export async function syncUpstreamCandidates(input: {
  config: UpstreamConfig;
  catalog: SourceCatalog;
  outputDirectory: string;
}): Promise<CandidateReview> {
  const pending: Array<{ path: string; snapshot: CandidateSnapshot; previous: CandidateSnapshot | null }> = [];
  for (const source of input.config.sources.filter((item) => item.enabled)) {
    if (
      source.api_key_env !== null &&
      (process.env[source.api_key_env] === undefined || process.env[source.api_key_env] === "")
    ) {
      console.warn(`${source.source_id}: 缺少 ${source.api_key_env}，保留已有候选且跳过。`);
      continue;
    }
    const payload = await fetchPayload(source);
    const snapshot = normalizeCandidateSnapshot({
      schemaVersion: input.config.schema_version,
      source,
      targets: input.config.targets,
      payload,
    });
    const path = join(input.outputDirectory, `${source.source_id}.json`);
    pending.push({ path, snapshot, previous: await readPrevious(path) });
  }

  const items = [
    ...pending.flatMap(({ previous, snapshot }) =>
      assessCandidateChange({ previous, candidate: snapshot, catalog: input.catalog }),
    ),
    ...assessCrossSourceConflicts(pending.map((item) => item.snapshot)),
  ];
  for (const { path, snapshot } of pending) {
    await atomicWrite(path, stableJson(snapshot));
  }
  const review: CandidateReview = {
    schema_version: input.config.schema_version,
    review_required: items.length > 0,
    items: items.sort((left, right) =>
      `${left.source_id}${left.model}${left.field}${left.type}`.localeCompare(
        `${right.source_id}${right.model}${right.field}${right.type}`,
        "en",
      ),
    ),
  };
  await atomicWrite(join(dirname(input.outputDirectory), "review.json"), stableJson(review));
  return review;
}
