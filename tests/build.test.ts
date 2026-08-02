import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildToDirectory, fileTreeDigest } from "../src/build.js";
import { readJson, sha256 } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { createPublishPlan, executeFilesystemPlan } from "../src/publish.js";
import type { Manifest } from "../src/types.js";

let temporaryRoot: string;
let first: string;
let second: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "llm-catalog-build-test-"));
  first = join(temporaryRoot, "llm-catalog-first");
  second = join(temporaryRoot, "llm-catalog-second");
  await buildToDirectory(REPOSITORY_ROOT, first);
  await buildToDirectory(REPOSITORY_ROOT, second);
}, 60_000);

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
}, 60_000);

describe("确定性静态构建", () => {
  test("相同输入生成完全相同的文件树与哈希", async () => {
    expect([...await fileTreeDigest(first)]).toEqual([...await fileTreeDigest(second)]);
  });

  test("manifest 的大小、SHA-256、版本路径与压缩文件均可验证", async () => {
    const manifest = await readJson<Manifest>(join(first, "manifest.json"));
    expect(await readFile(join(first, "versioned/2026.08.5/manifest.json"))).toEqual(
      await readFile(join(first, "manifest.json")),
    );
    expect(manifest.catalog_version).toBe("2026.08.5");
    expect(manifest.previous_catalog_version).toBe("2026.08.4");
    expect(manifest.schema_version).toBe("2.4.0");
    expect(manifest.minimum_consumer_schema_version).toBe("2.4.0");
    expect(manifest.immutable_base_path).toBe("versioned/2026.08.5/");
    for (const file of manifest.files) {
      const source = await readFile(join(first, file.path));
      const immutable = await readFile(join(first, file.immutable_path));
      const gzip = await readFile(join(first, file.encodings.gzip.path));
      const brotli = await readFile(join(first, file.encodings.br.path));
      expect(source.byteLength).toBe(file.size);
      expect(sha256(source)).toBe(file.sha256);
      expect(immutable).toEqual(source);
      expect(sha256(gzip)).toBe(file.encodings.gzip.sha256);
      expect(sha256(brotli)).toBe(file.encodings.br.sha256);
      expect(gunzipSync(gzip)).toEqual(source);
      expect(brotliDecompressSync(brotli)).toEqual(source);
    }
  });

  test("发布计划先上传不可变版本，最后上传 manifest", async () => {
    const plan = await createPublishPlan({
      distDirectory: first,
      provider: "oss",
      prefix: "catalog",
    });
    expect(plan.objects.at(-1)?.key).toBe("catalog/manifest.json");
    expect(plan.objects).toContainEqual(
      expect.objectContaining({
        key: "catalog/versioned/2026.08.5/manifest.json",
        cacheControl: expect.stringContaining("immutable"),
      }),
    );
    expect(plan.objects[0]?.key).toContain("catalog/versioned/2026.08.5/");
    expect(plan.objects.some((item) => item.contentEncoding === "gzip")).toBe(true);
    expect(plan.objects.some((item) => item.contentEncoding === "br")).toBe(true);
    expect(
      plan.objects
        .filter((item) => item.key.includes("/versioned/"))
        .every((item) => item.cacheControl.includes("immutable")),
    ).toBe(true);
  });

  test("filesystem adapter 按计划发布完整静态树", async () => {
    const plan = await createPublishPlan({
      distDirectory: first,
      provider: "filesystem",
      prefix: "catalog",
    });
    const destination = join(temporaryRoot, "published");
    await executeFilesystemPlan(plan, destination);
    expect(await readFile(join(destination, "catalog/manifest.json"))).toEqual(
      await readFile(join(first, "manifest.json")),
    );
    expect(
      await readFile(join(destination, "catalog/versioned/2026.08.5/catalog.json.br")),
    ).toEqual(await readFile(join(first, "versioned/2026.08.5/catalog.json.br")));
  });
});
