import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildToDirectory } from "../src/build.js";
import { refreshCatalog, type CatalogCache } from "../src/consumer.js";
import { readJson, sha256 } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { probeCatalog } from "../src/probe.js";
import type { AggregatedCatalog } from "../src/types.js";

let temporaryRoot: string | undefined;
let distDirectory: string;
let baseUrl: string;
let server: ReturnType<typeof createServer> | undefined;
const requestCounts = new Map<string, number>();

function cacheControl(path: string): string {
  if (path === "manifest.json") {
    return "no-cache, max-age=0, must-revalidate";
  }
  return path.startsWith("versioned/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300, must-revalidate";
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname).replace(/^\//, "");
  requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
  const candidate = resolve(distDirectory, normalize(pathname));
  if (relative(distDirectory, candidate).startsWith("..")) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(candidate)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readFile(candidate);
    const etag = `"${sha256(bytes)}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag, "cache-control": cacheControl(pathname) }).end();
      return;
    }
    const headers: Record<string, string | number> = {
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.byteLength,
      "cache-control": cacheControl(pathname),
      etag,
    };
    if (pathname.endsWith(".gz")) {
      headers["content-encoding"] = "gzip";
    } else if (pathname.endsWith(".br")) {
      headers["content-encoding"] = "br";
    }
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404).end();
  }
}

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
  const createdServer = createServer((request, response) => {
    void serve(request, response);
  });
  server = createdServer;
  await new Promise<void>((resolvePromise) =>
    createdServer.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = createdServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server missing address");
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  if (server?.listening) {
    const activeServer = server;
    await new Promise<void>((resolvePromise, reject) =>
      activeServer.close((error) => (error === undefined ? resolvePromise() : reject(error))),
    );
  }
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
    });
    expect(result).toMatchObject({
      catalogVersion: "2026.08.0",
      logicalFiles: 4,
      providerShards: 2,
      searchItems: 4,
    });
  });

  test("版本未变化时只重新请求小型 manifest，不重复下载 catalog", async () => {
    const snapshot = await readJson<AggregatedCatalog>(join(distDirectory, "catalog.json"));
    const cache = new MemoryCache();
    const before = requestCounts.get("catalog.json") ?? 0;
    const first = await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "1.0.0",
    });
    const afterFirst = requestCounts.get("catalog.json") ?? 0;
    const second = await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "1.0.0",
    });
    const afterSecond = requestCounts.get("catalog.json") ?? 0;
    expect(first.source).toBe("download");
    expect(second).toMatchObject({ source: "cache", catalogDownloaded: false });
    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst);
  });

  test("目录不可用时优先缓存，无缓存则使用内置快照", async () => {
    const snapshot = await readJson<AggregatedCatalog>(join(distDirectory, "catalog.json"));
    const cache = new MemoryCache();
    await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "1.0.0",
    });
    const unavailableFetch: typeof fetch = () => Promise.reject(new Error("network unavailable"));
    const cached = await refreshCatalog({
      baseUrl,
      cache,
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "1.0.0",
      fetchImplementation: unavailableFetch,
    });
    expect(cached).toMatchObject({ source: "cache", catalogDownloaded: false });
    const builtin = await refreshCatalog({
      baseUrl,
      cache: new MemoryCache(),
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "1.0.0",
      fetchImplementation: unavailableFetch,
    });
    expect(builtin).toMatchObject({ source: "builtin_snapshot", catalogDownloaded: false });
  });

  test("消费端 Schema 版本不足时不下载新目录并回退内置快照", async () => {
    const snapshot = await readJson<AggregatedCatalog>(join(distDirectory, "catalog.json"));
    const before = requestCounts.get("catalog.json") ?? 0;
    const result = await refreshCatalog({
      baseUrl,
      cache: new MemoryCache(),
      builtinSnapshot: snapshot,
      repositoryRoot: REPOSITORY_ROOT,
      supportedSchemaVersion: "0.9.0",
    });
    expect(result).toMatchObject({
      source: "builtin_snapshot",
      catalogDownloaded: false,
      diagnostic: expect.stringContaining("低于目录要求"),
    });
    expect(requestCounts.get("catalog.json") ?? 0).toBe(before);
  });
});
