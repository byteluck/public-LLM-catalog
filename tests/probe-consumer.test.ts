import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildToDirectory } from "../src/build.js";
import { refreshCatalog, type CatalogCache } from "../src/consumer.js";
import { readJson, sha256 } from "../src/json.js";
import { loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { probeCatalog } from "../src/probe.js";
import type { AggregatedCatalog } from "../src/types.js";

let temporaryRoot: string | undefined;
let distDirectory: string;
const baseUrl = "https://catalog.example/";
const requestCounts = new Map<string, number>();

function cacheControl(path: string): string {
  if (path === "manifest.json") {
    return "no-cache, max-age=0, must-revalidate";
  }
  return path.startsWith("versioned/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300, must-revalidate";
}

function contentType(path: string): string {
  if (path.endsWith(".html") || path.includes(".html.")) {
    return "text/html; charset=utf-8";
  }
  if (path.endsWith(".css") || path.includes(".css.")) {
    return "text/css; charset=utf-8";
  }
  if (path.endsWith(".js") || path.includes(".js.")) {
    return "text/javascript; charset=utf-8";
  }
  if (path.endsWith(".svg") || path.includes(".svg.")) {
    return "image/svg+xml; charset=utf-8";
  }
  return "application/json; charset=utf-8";
}

const fetchDist: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const requestUrl = request?.url ?? String(input);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const requestHeaders = new Headers(request?.headers);
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
  }
  const requestedPath = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\//, "");
  const pathname = requestedPath === "" ? "index.html" : requestedPath;
  requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
  const candidate = resolve(distDirectory, normalize(pathname));
  if (relative(distDirectory, candidate).startsWith("..")) {
    return new Response(null, { status: 403 });
  }
  try {
    if (!(await stat(candidate)).isFile()) {
      return new Response(null, { status: 404 });
    }
    const bytes = await readFile(candidate);
    const etag = `"${sha256(bytes)}"`;
    if (requestHeaders.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": cacheControl(pathname) },
      });
    }
    const headers: Record<string, string> = {
      "content-type": contentType(pathname),
      "content-length": String(bytes.byteLength),
      "cache-control": cacheControl(pathname),
      etag,
    };
    if (pathname.endsWith(".gz")) {
      headers["content-encoding"] = "gzip";
    } else if (pathname.endsWith(".br")) {
      headers["content-encoding"] = "br";
    }
    return new Response(method === "HEAD" ? null : new Uint8Array(bytes), { headers });
  } catch {
    return new Response(null, { status: 404 });
  }
};

class MemoryCache implements CatalogCache {
  value: {
    version: string;
    catalog: AggregatedCatalog;
    manifestEtag?: string;
  } | null = null;

  async read(): Promise<{
    version: string;
    catalog: AggregatedCatalog;
    manifestEtag?: string;
  } | null> {
    return this.value;
  }

  async write(value: {
    version: string;
    catalog: AggregatedCatalog;
    manifestEtag?: string;
  }): Promise<void> {
    this.value = value;
  }
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "llm-catalog-probe-test-"));
  temporaryRoot = root;
  distDirectory = join(root, "llm-catalog-dist");
  await buildToDirectory(REPOSITORY_ROOT, distDirectory);
});

afterAll(async () => {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

describe("国内静态地址与消费缓存", () => {
  test("打开 manifest、搜索、分片、版本路径、ETag、Cache-Control 与压缩对象", async () => {
    const result = await probeCatalog({
      baseUrl,
      repositoryRoot: REPOSITORY_ROOT,
      allowHttp: true,
      parentOrigin: new URL(baseUrl).origin,
      fetchImplementation: fetchDist,
    });
    const candidateSnapshot = await readJson<{ models: unknown[]; providers: unknown[] }>(
      join(REPOSITORY_ROOT, "upstream/models-dev-2026.json"),
    );
    const catalog = await loadSourceCatalog(REPOSITORY_ROOT);
    expect(result).toMatchObject({
      catalogVersion: "2026.08.6",
      embeddable: true,
      homepage: true,
      logicalFiles: 8 + catalog.providers.length + candidateSnapshot.providers.length,
      providerShards: catalog.providers.length,
      searchItems: catalog.offerings.length,
      siteFiles: 4,
      modelsDevItems: candidateSnapshot.models.length,
      reviewedOfferings: 79,
      logoAssets: candidateSnapshot.providers.length,
    });
  });

  test("版本未变化时只重新请求小型 manifest，不重复下载 catalog", async () => {
    const snapshot = await readJson<AggregatedCatalog>(join(distDirectory, "catalog.json"));
    const cache = new MemoryCache();
    const catalogPath = "versioned/2026.08.6/catalog.json";
    const before = requestCounts.get(catalogPath) ?? 0;
    const currentPathBefore = requestCounts.get("catalog.json") ?? 0;
    const first = await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "2.4.0",
      fetchImplementation: fetchDist,
    });
    const afterFirst = requestCounts.get(catalogPath) ?? 0;
    const second = await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "2.4.0",
      fetchImplementation: fetchDist,
    });
    const afterSecond = requestCounts.get(catalogPath) ?? 0;
    expect(first.source).toBe("download");
    expect(second).toMatchObject({ source: "cache", catalogDownloaded: false });
    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst);
    expect(requestCounts.get("catalog.json") ?? 0).toBe(currentPathBefore);
  });

  test("目录不可用时优先缓存，无缓存则使用内置快照", async () => {
    const snapshot = await readJson<AggregatedCatalog>(join(distDirectory, "catalog.json"));
    const cache = new MemoryCache();
    await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "2.4.0",
      fetchImplementation: fetchDist,
    });
    const unavailableFetch: typeof fetch = () => Promise.reject(new Error("network unavailable"));
    const cached = await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "2.4.0",
      fetchImplementation: unavailableFetch,
    });
    expect(cached).toMatchObject({ source: "cache", catalogDownloaded: false });
    const builtin = await refreshCatalog({
      baseUrl,
      cache: new MemoryCache(),
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "2.0.0",
      fetchImplementation: unavailableFetch,
    });
    expect(builtin).toMatchObject({ source: "builtin_snapshot", catalogDownloaded: false });
  });

  test("消费端 Schema 版本不足时不下载新目录并回退内置快照", async () => {
    const snapshot = await readJson<AggregatedCatalog>(join(distDirectory, "catalog.json"));
    const before = requestCounts.get("versioned/2026.08.6/catalog.json") ?? 0;
    const result = await refreshCatalog({
      baseUrl,
      cache: new MemoryCache(),
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "1.0.0",
      fetchImplementation: fetchDist,
    });
    expect(result).toMatchObject({
      source: "builtin_snapshot",
      catalogDownloaded: false,
      diagnostic: expect.stringContaining("低于目录要求"),
    });
    expect(requestCounts.get("versioned/2026.08.6/catalog.json") ?? 0).toBe(before);
  });
});
