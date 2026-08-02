import { describe, expect, test } from "vitest";

import {
  CATALOG_EMBED_CHANNEL,
  CATALOG_EMBED_PROTOCOL_VERSION,
  createCatalogSelectionMessage,
  resolveCatalogEmbedContext,
} from "../web/catalog-embed.js";

const SESSION_ID = "catalog-session-123456";

describe("目录 iframe 通信协议", () => {
  test("只接受协议版本、父 origin、referrer 和 session 全部匹配的选择模式", () => {
    const href =
      `https://fe-resource.baiteda.com/LLM_catalog/index.html?embed=picker` +
      `&protocol_version=1&parent_origin=${encodeURIComponent("https://ai.baiteda.com")}` +
      `&session_id=${SESSION_ID}`;

    expect(resolveCatalogEmbedContext(href, "https://ai.baiteda.com/model-config")).toEqual({
      parentOrigin: "https://ai.baiteda.com",
      sessionId: SESSION_ID,
    });
    expect(resolveCatalogEmbedContext(href, "https://attacker.example/model-config")).toBeNull();
    expect(resolveCatalogEmbedContext(href.replace("protocol_version=1", "protocol_version=2"))).toBeNull();
    expect(resolveCatalogEmbedContext(href.replace(SESSION_ID, "short"))).toBeNull();
  });

  test("选择消息只投影公开 offering 身份与能力，并保持 unknown", () => {
    const context = { parentOrigin: "https://ai.baiteda.com", sessionId: SESSION_ID };
    const message = createCatalogSelectionMessage(context, {
      descriptor: { path: "providers/example.json", sha256: "a".repeat(64) },
      item: { verification_status: "officially_verified" },
      manifest: {
        schema_version: "2.4.0",
        catalog_version: "2026.08.6",
        generated_at: "2026-08-02T00:00:00Z",
      },
      model: {
        canonical_id: "example/model",
        kind: "chat",
        family: "model",
      },
      provider: { provider_id: "example", name: "Example" },
      offering: {
        offering_id: "example/model",
        api_model_id: "model",
        name: "Example: Model",
        status: "active",
        protocols: ["openai_chat_completions"],
        modalities: { input_modalities: ["text"], output_modalities: ["text"] },
        limits: {
          max_context_tokens: 128000,
          max_input_tokens: "unknown",
          max_output_tokens: 8192,
        },
        capabilities: {
          agent: {
            streaming: true,
            stream_usage: "unknown",
            system_message: true,
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
          },
        },
        embedding: null,
      },
    });

    expect(message).toMatchObject({
      channel: CATALOG_EMBED_CHANNEL,
      protocol_version: CATALOG_EMBED_PROTOCOL_VERSION,
      session_id: SESSION_ID,
      type: "catalog.selection",
      payload: {
        provider_id: "example",
        canonical_id: "example/model",
        offering_id: "example/model",
        capabilities: {
          agent: { tool_call: "unknown" },
          reasoning: { supported: "unknown" },
        },
      },
    });
    const serialized = JSON.stringify(message);
    expect(serialized).not.toMatch(/api[_-]?key|tenant|base[_-]?url|env_endpoints/iu);
  });
});
