import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildToDirectory } from "../src/build.js";
import { readJson } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import type { Manifest } from "../src/types.js";

let temporaryRoot: string;
let outputDirectory: string;
let sourceHtml: string;
let sourceCss: string;
let sourceJavaScript: string;
let manifest: Manifest;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "llm-catalog-ui-test-"));
  outputDirectory = join(temporaryRoot, "llm-catalog-dist");
  [sourceHtml, sourceCss, sourceJavaScript] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "web/index.html"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "web/catalog.css"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "web/catalog.js"), "utf8"),
  ]);
  await buildToDirectory(REPOSITORY_ROOT, outputDirectory);
  manifest = await readJson<Manifest>(join(outputDirectory, "manifest.json"));
}, 60_000);

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
}, 60_000);

describe("CDN 静态浏览界面", () => {
  test("首页只引用同源相对资源并声明严格 CSP", () => {
    expect(sourceHtml).toContain('href="./assets/catalog.css"');
    expect(sourceHtml).toContain('src="./assets/catalog.js"');
    expect(sourceHtml).toContain("connect-src 'self'");
    expect(sourceHtml).toContain("models-dev-explorer");
    expect(sourceJavaScript).toContain('fetchVerifiedJson("models-dev-2026.json")');
    expect(sourceJavaScript).toContain("candidateLogo");
    expect(sourceJavaScript).toContain("manufacturerLogo");
    expect(sourceJavaScript).toContain("detail-logo");
    expect(sourceJavaScript).toContain("SUPPORTED_SCHEMA_VERSION");
    expect(sourceJavaScript).toContain("minimum_consumer_schema_version");
    expect(sourceHtml).not.toMatch(/(?:href|src)=["']https?:\/\//u);
    expect(sourceCss).not.toMatch(/url\(["']?https?:\/\//u);
  });

  test("先请求 manifest 和轻量索引，详情才按供应商加载分片", () => {
    const manifestLoad = sourceJavaScript.indexOf("await fetchManifest()");
    const indexLoad = sourceJavaScript.indexOf('fetchVerifiedJson("search-index.json")');
    expect(manifestLoad).toBeGreaterThan(-1);
    expect(indexLoad).toBeGreaterThan(manifestLoad);
    expect(sourceJavaScript).toContain("fetchVerifiedJson(`providers/${providerId}.json`)");
    expect(sourceJavaScript).not.toContain('fetchVerifiedJson("catalog.json")');
    expect(sourceJavaScript).toContain("descriptor.immutable_path");
    expect(sourceJavaScript).toContain('digest("SHA-256"');
  });

  test("所有目录文本都通过 DOM textContent 创建，不使用 HTML 注入", () => {
    expect(sourceJavaScript).not.toContain("innerHTML");
    expect(sourceJavaScript).not.toContain("insertAdjacentHTML");
    expect(sourceJavaScript).toContain("node.textContent = text");
  });

  test("界面不按具体模型名称硬编码", () => {
    for (const modelName of ["GPT-5.5", "GLM-5.2", "GLM-4.6V", "Embedding-3"]) {
      expect(sourceHtml).not.toContain(modelName);
      expect(sourceCss).not.toContain(modelName);
      expect(sourceJavaScript).not.toContain(modelName);
    }
  });

  test("HTML、CSS、JS 均进入 manifest、压缩和不可变版本路径", async () => {
    const expected = new Map([
      ["index.html", "text/html; charset=utf-8"],
      ["assets/catalog.css", "text/css; charset=utf-8"],
      ["assets/catalog.js", "text/javascript; charset=utf-8"],
    ]);
    for (const [path, contentType] of expected) {
      const descriptor = manifest.files.find((file) => file.path === path);
      expect(descriptor).toMatchObject({
        path,
        content_type: contentType,
        immutable_path: `versioned/2026.08.3/${path}`,
      });
      expect(descriptor?.encodings.gzip.path).toBe(`${path}.gz`);
      expect(descriptor?.encodings.br.path).toBe(`${path}.br`);
      expect(await readFile(join(outputDirectory, path))).toEqual(
        await readFile(join(outputDirectory, `versioned/2026.08.3/${path}`)),
      );
    }
    expect(manifest.files.find((file) => file.path === "index.html")?.cache_control).toContain(
      "no-cache",
    );
  });

  test("搜索索引包含展示所需供应商名称但不复制能力和证据正文", async () => {
    const index = await readJson<{ items: Array<Record<string, unknown>> }>(
      join(outputDirectory, "search-index.json"),
    );
    expect(index.items.every((item) => typeof item.provider_name === "string")).toBe(true);
    expect(index.items.every((item) => "verification_status" in item && "manufacturer_logo" in item)).toBe(true);
    expect(index.items.every((item) => !("capabilities" in item) && !("evidence" in item))).toBe(true);
  });

  test("已提升的 2026 模型在主目录索引中绑定同源厂家 logo", async () => {
    const index = await readJson<{
      items: Array<{
        offering_id: string;
        verification_status: string;
        manufacturer_logo: string | null;
      }>;
    }>(join(outputDirectory, "search-index.json"));
    const qwen = index.items.find((item) => item.offering_id === "qwen/qwen3.6-27b-20260422");
    expect(qwen).toMatchObject({
      offering_id: "qwen/qwen3.6-27b-20260422",
      verification_status: "upstream_observation",
      manufacturer_logo: "assets/logos/qwen.svg",
    });
    expect(await readFile(join(outputDirectory, "assets/logos/qwen.svg"), "utf8")).toMatch(/^\s*<svg\b/u);
  });

  test("models.dev 候选快照和厂家 logo 进入同一 manifest", async () => {
    const candidate = manifest.files.find((file) => file.path === "models-dev-2026.json");
    const sourceSnapshot = await readJson<{ models: unknown[]; providers: unknown[] }>(
      join(REPOSITORY_ROOT, "upstream/models-dev-2026.json"),
    );
    expect(candidate?.content_type).toBe("application/json; charset=utf-8");
    expect(manifest.files.filter((file) => file.content_type === "image/svg+xml; charset=utf-8")).toHaveLength(sourceSnapshot.providers.length);
    const snapshot = await readJson<{ models: unknown[]; providers: unknown[] }>(
      join(outputDirectory, "models-dev-2026.json"),
    );
    expect(snapshot.models).toHaveLength(sourceSnapshot.models.length);
    expect(snapshot.providers).toHaveLength(sourceSnapshot.providers.length);
  });
});
