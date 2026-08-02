import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readJson } from "../src/json.js";
import { loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { filterGenerationSettings } from "../src/runtime.js";
import type { ModelsDevCandidates } from "../src/types.js";

const OBSERVATION_SOURCE_ID = "models-dev-2026-observation";

describe("models.dev 2026 直连记录提升", () => {
  test("每条直连记录都有隔离的 canonical model 与 offering，路线记录不混入权威目录", async () => {
    const [catalog, snapshot] = await Promise.all([
      loadSourceCatalog(REPOSITORY_ROOT),
      readJson<ModelsDevCandidates>(join(REPOSITORY_ROOT, "upstream", "models-dev-2026.json")),
    ]);
    const direct = snapshot.models.filter((candidate) => candidate.route_kind === "direct");
    const observedModels = catalog.models.filter((model) =>
      model.evidence.some((source) => source.source_id === OBSERVATION_SOURCE_ID),
    );
    const observedOfferings = catalog.offerings.filter((offering) =>
      offering.evidence.some((source) => source.source_id === OBSERVATION_SOURCE_ID),
    );

    expect(observedModels).toHaveLength(direct.length);
    expect(observedOfferings).toHaveLength(direct.length);
    for (const candidate of direct) {
      const model = observedModels.find((value) => value.canonical_id === candidate.canonical_slug);
      const offering = observedOfferings.find((value) => value.offering_id === candidate.canonical_slug);
      expect(model).toMatchObject({
        canonical_id: candidate.canonical_slug,
        manufacturer_id: candidate.provider_id,
        lifecycle: { release_date: "unknown", status: "unknown" },
        limits: {
          max_context_tokens: candidate.context_length,
          max_input_tokens: "unknown",
          max_output_tokens: candidate.max_output_tokens,
        },
      });
      expect(offering).toMatchObject({
        provider_id: candidate.provider_id,
        canonical_id: candidate.canonical_slug,
        api_model_id: candidate.api_model_id,
        protocols: "unknown",
        status: "unknown",
      });
      expect(model?.lifecycle.release_date).not.toBe(candidate.models_dev_created_at);
    }
  });

  test("聚合源观测绝不升级为可运行能力或采样默认值", async () => {
    const catalog = await loadSourceCatalog(REPOSITORY_ROOT);
    const offering = catalog.offerings.find((value) => value.offering_id === "qwen/qwen3.6-27b-20260422");
    if (offering === undefined) {
      throw new Error("缺少 models.dev 提升的 Qwen offering");
    }
    expect(offering.capabilities.agent).toEqual({
      streaming: "unknown",
      stream_usage: "unknown",
      system_message: "unknown",
      tool_call: "unknown",
      tool_choice: "unknown",
      parallel_tool_calls: "unknown",
      strict_tools: "unknown",
      structured_output: "unknown",
      json_schema: "unknown",
    });
    for (const capability of Object.values(offering.sampling_parameters)) {
      expect(capability).toMatchObject({
        supported: "unknown",
        range: "unknown",
        official_default: "unknown",
        protocol_mapping: {},
      });
    }
    expect(() =>
      filterGenerationSettings(offering, "openai_chat_completions", {
        agentPolicy: { temperature: 0.7 },
      }),
    ).toThrow(/不支持协议/);
  });
});
