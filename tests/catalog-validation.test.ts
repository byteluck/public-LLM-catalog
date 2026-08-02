import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readJson } from "../src/json.js";
import { loadModelsDevOfficialReviews, loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import {
  createValidators,
  validateEvidenceAndAnnotations,
  validateIdentityAndReferences,
  validateLimitConsistency,
  validateModelsDevOfficialReviews,
  validateSchemaVersionConsistency,
  validateSourceCatalog,
  validateWith,
} from "../src/validate.js";
import type { AliasEntry, ModelsDevCandidates } from "../src/types.js";

describe("目录约束", () => {
  test("当前源数据通过 Schema、引用、唯一性和证据校验", async () => {
    const result = await validateSourceCatalog(REPOSITORY_ROOT);
    expect(result.issues).toEqual([]);
  });

  test("每条已提升的 models.dev 直连记录都有独立官方核验，且核验不放开运行时", async () => {
    const [catalog, candidates, reviews] = await Promise.all([
      loadSourceCatalog(REPOSITORY_ROOT),
      readJson<ModelsDevCandidates>(join(REPOSITORY_ROOT, "upstream/models-dev-2026.json")),
      loadModelsDevOfficialReviews(REPOSITORY_ROOT),
    ]);
    const direct = candidates.models.filter((candidate) => candidate.route_kind === "direct");
    expect(reviews.reviews).toHaveLength(direct.length);
    expect(validateModelsDevOfficialReviews(catalog, candidates, reviews)).toEqual([]);
    expect(new Set(reviews.reviews.map((review) => review.runtime_disposition))).toEqual(
      new Set(["keep_fail_closed"]),
    );
    for (const review of reviews.reviews.filter((item) => item.review_status === "official_api_verified")) {
      expect(review.evidence.length).toBeGreaterThan(0);
      expect(review.verified_fields).toEqual(expect.arrayContaining(["model_identity", "api_model_id"]));
    }

    const duplicate = structuredClone(reviews);
    duplicate.reviews.push(structuredClone(duplicate.reviews[0]!));
    expect(validateModelsDevOfficialReviews(catalog, candidates, duplicate).map((item) => item.code)).toContain(
      "duplicate_offering_review",
    );
  });

  test("能力布尔值只能为 true/false/unknown", async () => {
    const [catalog, validators] = await Promise.all([
      loadSourceCatalog(REPOSITORY_ROOT),
      createValidators(REPOSITORY_ROOT),
    ]);
    const invalid = structuredClone(catalog.offerings.at(0)!);
    (invalid.capabilities.agent as unknown as Record<string, unknown>).streaming = null;
    expect(validateWith(validators.offering, invalid, "invalid.json")).not.toEqual([]);
  });

  test("所有权威源文档使用 release 声明的同一 Schema 版本", async () => {
    const catalog = structuredClone(await loadSourceCatalog(REPOSITORY_ROOT));
    catalog.models[0]!.schema_version = "1.0.0";
    expect(validateSchemaVersionConsistency(catalog)).toEqual([
      expect.objectContaining({
        code: "schema_version_mismatch",
        path: "/schema_version",
      }),
    ]);
  });

  test("canonical model 禁止出现采样默认配置", async () => {
    const [catalog, validators] = await Promise.all([
      loadSourceCatalog(REPOSITORY_ROOT),
      createValidators(REPOSITORY_ROOT),
    ]);
    const invalid = structuredClone(catalog.models[0]) as unknown as Record<string, unknown>;
    invalid.temperature = 0.5;
    expect(validateWith(validators.canonical, invalid, "invalid.json")).not.toEqual([]);
  });

  test("检测重复 ID、别名循环和缺失目标", async () => {
    const catalog = structuredClone(await loadSourceCatalog(REPOSITORY_ROOT));
    catalog.offerings.push(structuredClone(catalog.offerings.at(0)!));
    const cycleEntries: AliasEntry[] = [
      { alias: "cycle-a", provider_id: "openai", target_type: "alias", target_id: "cycle-b" },
      { alias: "cycle-b", provider_id: "openai", target_type: "alias", target_id: "cycle-a" },
      { alias: "missing", provider_id: "openai", target_type: "offering", target_id: "none/missing" },
    ];
    catalog.aliases[0]?.entries.push(...cycleEntries);
    const codes = validateIdentityAndReferences(catalog).map((item) => item.code);
    expect(codes).toContain("duplicate_offering_id");
    expect(codes).toContain("duplicate_api_model_id");
    expect(codes).toContain("alias_cycle");
    expect(codes).toContain("missing_alias_target");
  });

  test("检测 canonical/offering 类型、限额、模态和生命周期不一致", async () => {
    const catalog = structuredClone(await loadSourceCatalog(REPOSITORY_ROOT));
    const offering = catalog.offerings.find((item) => item.offering_id === "openai/gpt-5.5")!;
    offering.status = "deprecated";
    if (!Array.isArray(offering.protocols)) {
      throw new Error("测试基准 offering 的 protocols 必须为已验证数组");
    }
    offering.protocols.push("embeddings");
    offering.limits.max_context_tokens = 2_000_000;
    offering.modalities.output_modalities.push("audio");
    offering.lifecycle.replacement = "openai/not-found";
    const codes = validateIdentityAndReferences(catalog).map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "lifecycle_status_mismatch",
        "model_kind_mismatch",
        "offering_limit_exceeds_canonical",
        "offering_modality_exceeds_canonical",
        "missing_replacement",
      ]),
    );
  });

  test("三类 token 限额不可混用或倒挂", () => {
    const issues = validateLimitConsistency(
      { max_context_tokens: 100, max_input_tokens: 101, max_output_tokens: 120 },
      "limits.json",
    );
    expect(issues.map((item) => item.path)).toEqual([
      "/limits/max_input_tokens",
      "/limits/max_output_tokens",
    ]);
  });

  test("token、维度和批量等已知整数必须为正数", async () => {
    const [catalog, validators] = await Promise.all([
      loadSourceCatalog(REPOSITORY_ROOT),
      createValidators(REPOSITORY_ROOT),
    ]);
    const invalid = structuredClone(catalog.models.at(0)!);
    invalid.limits.max_context_tokens = 0;
    expect(validateWith(validators.canonical, invalid, "invalid.json")).not.toEqual([]);
  });

  test("字段必须有运行时标记和可解析的字段级证据", async () => {
    const catalog = await loadSourceCatalog(REPOSITORY_ROOT);
    const model = structuredClone(catalog.models.at(0)!);
    delete model.field_annotations["/name"];
    const missingAnnotation = validateEvidenceAndAnnotations(model, "model.json");
    expect(missingAnnotation.some((item) => item.code === "missing_annotation" && item.path === "/name")).toBe(true);

    const annotated = structuredClone(catalog.models.at(0)!);
    const nameAnnotation = annotated.field_annotations["/name"];
    expect(nameAnnotation).toBeDefined();
    nameAnnotation?.source_ids.push("not-found");
    expect(
      validateEvidenceAndAnnotations(annotated, "model.json").some(
        (item) => item.code === "unknown_source_reference",
      ),
    ).toBe(true);
  });
});
