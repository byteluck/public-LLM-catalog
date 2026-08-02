import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { stableJson } from "../src/json.js";
import { loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import {
  assessCandidateChange,
  assessCrossSourceConflicts,
  normalizeCandidateSnapshot,
  syncUpstreamCandidates,
  type CandidateSnapshot,
  type UpstreamConfig,
  type UpstreamSourceConfig,
} from "../src/upstream.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const source: UpstreamSourceConfig = {
  source_id: "test-upstream",
  url: "https://example.invalid/models.json",
  format: "models_dev",
  enabled: true,
  api_key_env: null,
  max_bytes: 1024 * 1024,
};

describe("上游候选隔离", () => {
  test("只提取目标模型的候选字段，不把上游格式当作权威格式", () => {
    const snapshot = normalizeCandidateSnapshot({
      schemaVersion: "1.0.0",
      source,
      targets: ["glm-5.2"],
      payload: {
        zhipu: {
          models: {
            "glm-5.2": {
              limit: { context: 1000000, output: 131072 },
              supports_function_calling: true,
            },
            unrelated: { limit: { context: 1 } },
          },
        },
      },
    });
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]).toMatchObject({
      api_model_id: "glm-5.2",
      limits: { max_context_tokens: 1000000, max_output_tokens: 131072 },
      capabilities: { tool_call: true },
    });
  });

  test("冲突、能力降级、限额下降与删除都要求人工审核，且不改权威目录", async () => {
    const catalog = await loadSourceCatalog(REPOSITORY_ROOT);
    const before = stableJson(catalog);
    const previous: CandidateSnapshot = {
      schema_version: "1.0.0",
      source_id: "test-upstream",
      source_url: source.url,
      normalized_sha256: "previous",
      models: [
        {
          upstream_key: "provider/glm-5.2",
          api_model_id: "glm-5.2",
          limits: { max_context_tokens: 1000000 },
          capabilities: { tool_call: true },
        },
        {
          upstream_key: "provider/deleted",
          api_model_id: "embedding-3",
          limits: {},
          capabilities: {},
        },
      ],
    };
    const candidate: CandidateSnapshot = {
      ...previous,
      normalized_sha256: "candidate",
      models: [
        {
          upstream_key: "provider/glm-5.2",
          api_model_id: "glm-5.2",
          limits: { max_context_tokens: 128000 },
          capabilities: { tool_call: false },
        },
      ],
    };
    const types = assessCandidateChange({ previous, candidate, catalog }).map((item) => item.type);
    expect(types).toEqual(
      expect.arrayContaining(["conflict", "deletion", "capability_degradation", "limit_decrease"]),
    );
    expect(stableJson(catalog)).toBe(before);
  });

  test("不同上游之间的冲突和能力字段消失都要求人工审核", async () => {
    const catalog = await loadSourceCatalog(REPOSITORY_ROOT);
    const previous: CandidateSnapshot = {
      schema_version: "1.0.0",
      source_id: "first",
      source_url: source.url,
      normalized_sha256: "first",
      models: [
        {
          upstream_key: "provider/model",
          api_model_id: "private-test-model",
          limits: { max_context_tokens: 1000 },
          capabilities: { tool_call: true },
        },
      ],
    };
    const missingCapability: CandidateSnapshot = {
      ...previous,
      source_id: "second",
      normalized_sha256: "second",
      models: [
        {
          upstream_key: "provider/model",
          api_model_id: "private-test-model",
          limits: { max_context_tokens: 2000 },
          capabilities: {},
        },
      ],
    };
    expect(
      assessCandidateChange({
        previous,
        candidate: missingCapability,
        catalog,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "capability_degradation",
        field: "capabilities.tool_call",
        candidate: null,
      }),
    ]);
    expect(assessCrossSourceConflicts([previous, missingCapability])).toEqual([
      expect.objectContaining({
        type: "conflict",
        field: "limits.max_context_tokens",
        source_id: "second",
      }),
    ]);
  });

  test("上游 HTTP 异常不会覆盖已有候选或已发布目录", async () => {
    const publishedPaths = [
      join(REPOSITORY_ROOT, "dist", "manifest.json"),
      join(REPOSITORY_ROOT, "dist", "catalog.json"),
    ];
    const publishedBefore = await Promise.all(publishedPaths.map((path) => readFile(path)));
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"unavailable"}');
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server missing address");
    }
    const temporary = await mkdtemp(join(tmpdir(), "llm-catalog-upstream-test-"));
    temporaryDirectories.push(temporary);
    const output = join(temporary, "upstream", "candidates");
    await mkdir(output, { recursive: true });
    const existingPath = join(output, "test-upstream.json");
    await writeFile(existingPath, "existing-candidate\n");
    const config: UpstreamConfig = {
      $schema: "https://llm-catalog.example.cn/schemas/upstream-config.schema.json",
      schema_version: "1.0.0",
      targets: ["glm-5.2"],
      sources: [{ ...source, url: `http://127.0.0.1:${address.port}/models` }],
    };
    try {
      await expect(
        syncUpstreamCandidates({
          config,
          catalog: await loadSourceCatalog(REPOSITORY_ROOT),
          outputDirectory: output,
        }),
      ).rejects.toThrow(/HTTP 503/);
      expect(await readFile(existingPath, "utf8")).toBe("existing-candidate\n");
      const publishedAfter = await Promise.all(publishedPaths.map((path) => readFile(path)));
      expect(publishedAfter).toEqual(publishedBefore);
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
      );
    }
  });
});
