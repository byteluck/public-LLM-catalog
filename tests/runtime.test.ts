import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import {
  buildChatRuntimePlan,
  buildEmbeddingRuntimePlan,
  filterGenerationSettings,
  mergeGenerationSettings,
  resolveMaxInputTokens,
  selectDeploymentOffering,
} from "../src/runtime.js";
import type { Offering, SourceCatalog } from "../src/types.js";

let catalog: SourceCatalog;

beforeAll(async () => {
  catalog = await loadSourceCatalog(REPOSITORY_ROOT);
});

function offering(id: string): Offering {
  const value = catalog.offerings.find((item) => item.offering_id === id);
  if (value === undefined) {
    throw new Error(`test offering missing: ${id}`);
  }
  return value;
}

describe("运行时参数契约", () => {
  test("三层合并优先级为 Agent Policy > Tenant Override > System Default", () => {
    expect(
      mergeGenerationSettings({
        systemDefault: { temperature: 0.1, top_p: 0.2, max_output_tokens: 100 },
        tenantDeploymentOverride: { temperature: 0.4, top_p: 0.5 },
        agentPolicy: { temperature: 0.8 },
      }),
    ).toEqual({ temperature: 0.8, top_p: 0.5, max_output_tokens: 100 });
  });

  test("supported=true 才发送，false/unknown 均省略并诊断", () => {
    const glm = offering("zhipu/glm-5.2");
    const filtered = filterGenerationSettings(glm, "openai_chat_completions", {
      systemDefault: { temperature: 0.2, top_p: 0.3, top_k: 40 },
      tenantDeploymentOverride: { temperature: 0.5 },
      agentPolicy: { temperature: 0.8 },
    });
    expect(filtered.logical).toEqual({ temperature: 0.8, top_p: 0.3 });
    expect(filtered.protocol).toEqual({ temperature: 0.8, top_p: 0.3 });
    expect(filtered.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown_parameter_support", field: "top_k" }),
      ]),
    );

    const gpt = filterGenerationSettings(offering("openai/gpt-5.5"), "openai_responses", {
      agentPolicy: { temperature: 0.7 },
    });
    expect(gpt.logical).toEqual({});
    expect(gpt.diagnostics[0]).toMatchObject({
      code: "unknown_parameter_support",
      field: "temperature",
    });
  });

  test("ChatOpenAI 构造器、reasoning 和 DeepAgent profile 均有精确映射", () => {
    const plan = buildChatRuntimePlan({
      offering: offering("zhipu/glm-5.2"),
      protocol: "openai_chat_completions",
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        maxInputTokensOverride: 900000,
      },
      generationLayers: {
        agentPolicy: {
          temperature: 0.8,
          top_p: 0.9,
          max_output_tokens: 4096,
          streaming: true,
          stream_usage: true,
          reasoning_effort: "high",
        },
      },
    });
    expect(plan.adapter).toBe("ChatOpenAI");
    expect(plan.constructorOptions).toMatchObject({
      model: "glm-5.2",
      apiKey: "runtime-only-placeholder",
      configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
      useResponsesApi: false,
      maxTokens: 4096,
      streaming: true,
      temperature: 0.8,
      topP: 0.9,
      reasoning: { effort: "high" },
    });
    expect(plan.constructorOptions).not.toHaveProperty("streamUsage");
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown_capability", field: "stream_usage" })]),
    );
    expect(plan.deepAgentProfile).toEqual({ maxInputTokens: 900000 });
  });

  test("ChatOpenAI 没有高阶构造器字段的已验证采样参数进入 modelKwargs", () => {
    const withTopK = structuredClone(offering("zhipu/glm-5.2"));
    withTopK.sampling_parameters.top_k = {
      supported: true,
      range: {
        minimum: 1,
        maximum: 100,
        minimum_inclusive: true,
        maximum_inclusive: true,
      },
      official_default: "unknown",
      protocol_mapping: { openai_chat_completions: "top_k" },
    };
    const plan = buildChatRuntimePlan({
      offering: withTopK,
      protocol: "openai_chat_completions",
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        maxInputTokensOverride: 900000,
      },
      generationLayers: { agentPolicy: { top_k: 40 } },
    });
    expect(plan.constructorOptions.modelKwargs).toEqual({ top_k: 40 });
  });

  test("stream usage 只有明确支持时才映射，明确不支持时配置也不发送", () => {
    const supported = structuredClone(offering("zhipu/glm-5.2"));
    supported.capabilities.agent.stream_usage = true;
    const supportedPlan = buildChatRuntimePlan({
      offering: supported,
      protocol: "openai_chat_completions",
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        maxInputTokensOverride: 900000,
      },
      generationLayers: { agentPolicy: { stream_usage: true } },
    });
    expect(supportedPlan.constructorOptions.streamUsage).toBe(true);

    const unsupported = structuredClone(supported);
    unsupported.capabilities.agent.stream_usage = false;
    const unsupportedPlan = buildChatRuntimePlan({
      offering: unsupported,
      protocol: "openai_chat_completions",
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        maxInputTokensOverride: 900000,
      },
      generationLayers: { tenantDeploymentOverride: { stream_usage: true } },
    });
    expect(unsupportedPlan.constructorOptions).not.toHaveProperty("streamUsage");
    expect(unsupportedPlan.diagnostics).toEqual([
      expect.objectContaining({ code: "unsupported_capability", field: "stream_usage" }),
    ]);
  });

  test("Anthropic 未验证的采样/推理映射不会透传", () => {
    const plan = buildChatRuntimePlan({
      offering: offering("zhipu/glm-5.2"),
      protocol: "anthropic_messages",
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        maxInputTokensOverride: 900000,
      },
      generationLayers: { agentPolicy: { temperature: 0.8, reasoning_effort: "high" } },
    });
    expect(plan.adapter).toBe("ChatAnthropic");
    expect(plan.constructorOptions).toMatchObject({
      model: "glm-5.2",
      anthropicApiUrl: "https://open.bigmodel.cn/api/anthropic",
    });
    expect(plan.constructorOptions).not.toHaveProperty("temperature");
    expect(plan.constructorOptions).not.toHaveProperty("outputConfig");
    expect(plan.diagnostics.map((item) => item.code)).toEqual([
      "missing_protocol_mapping",
      "missing_protocol_mapping",
    ]);
  });

  test("max_input_tokens unknown 时 fail closed，绝不回退到 context", () => {
    expect(() =>
      resolveMaxInputTokens(offering("openai/gpt-5.5"), {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toThrow(/MAX_INPUT_TOKENS_UNKNOWN/);
  });

  test("Embedding 构造映射 dimensions/batchSize 并校验上限", () => {
    const embedding = offering("zhipu/embedding-3");
    const plan = buildEmbeddingRuntimePlan({
      offering: embedding,
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      },
      dimension: 512,
      batchSize: 32,
    });
    expect(plan).toEqual({
      adapter: "OpenAIEmbeddings",
      constructorOptions: {
        model: "embedding-3",
        apiKey: "runtime-only-placeholder",
        configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
        dimensions: 512,
        batchSize: 32,
      },
    });
    expect(() =>
      buildEmbeddingRuntimePlan({
        offering: embedding,
        deployment: { apiKey: "x", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
        batchSize: 65,
      }),
    ).toThrow(/超过上限/);
    expect(() =>
      buildEmbeddingRuntimePlan({
        offering: embedding,
        deployment: { apiKey: "x", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
        dimension: 0,
      }),
    ).toThrow(/必须为正整数/);
  });

  test("非法 max_output_tokens 不会进入构造器", () => {
    const plan = buildChatRuntimePlan({
      offering: offering("zhipu/glm-5.2"),
      protocol: "openai_chat_completions",
      deployment: {
        apiKey: "runtime-only-placeholder",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        maxInputTokensOverride: 900000,
      },
      generationLayers: { tenantDeploymentOverride: { max_output_tokens: 0 } },
    });
    expect(plan.constructorOptions).not.toHaveProperty("maxTokens");
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: "out_of_range", field: "max_output_tokens" }),
    ]);
  });

  test("私有模型 ID 必须显式 override 到公开 offering", () => {
    expect(() =>
      selectDeploymentOffering({
        offerings: catalog.offerings,
        providerId: "zhipu",
        apiModelId: "tenant-private-model",
      }),
    ).toThrow(/必须显式提供 publicOfferingOverride/);
    expect(
      selectDeploymentOffering({
        offerings: catalog.offerings,
        providerId: "zhipu",
        apiModelId: "tenant-private-model",
        publicOfferingOverride: "zhipu/glm-5.2",
      }).canonical_id,
    ).toBe("zhipu/glm-5.2");
  });

  test("运行时适配器不按模型名称硬编码", async () => {
    const source = await readFile(join(REPOSITORY_ROOT, "src", "runtime.ts"), "utf8");
    expect(source).not.toMatch(/gpt-5\.5|glm-5\.2|glm-4\.6v|embedding-3/);
  });
});
