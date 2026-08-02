import { sha256 } from "./json.js";
import type { Manifest } from "./types.js";
import { createValidators, formatValidationIssues, validateWith } from "./validate.js";

export interface ProbeResult {
  baseUrl: string;
  catalogVersion: string;
  homepage: boolean;
  logicalFiles: number;
  providerShards: number;
  searchItems: number;
  siteFiles: number;
}

function urlAt(base: URL, path: string): URL {
  const normalized = base.toString().endsWith("/") ? base : new URL(`${base.toString()}/`);
  return new URL(path, normalized);
}

async function conditionalCacheCheck(url: URL, etag: string): Promise<void> {
  const response = await fetch(url, { headers: { "if-none-match": etag } });
  if (response.status !== 304) {
    throw new Error(`${url} 未对 If-None-Match 返回 304（实际 ${response.status}）`);
  }
}

function requireHeader(response: Response, name: string, url: URL): string {
  const value = response.headers.get(name);
  if (value === null || value === "") {
    throw new Error(`${url} 缺少 ${name} 响应头`);
  }
  return value;
}

async function fetchBytesWithCache(
  url: URL,
  expectedHash: string,
  expectedContentType: string,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`);
  }
  const etag = requireHeader(response, "etag", url);
  requireHeader(response, "cache-control", url);
  const contentType = requireHeader(response, "content-type", url);
  if (contentType.toLowerCase() !== expectedContentType.toLowerCase()) {
    throw new Error(`${url} Content-Type=${contentType}，期望 ${expectedContentType}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`${url} SHA-256 与 manifest 不一致`);
  }
  await conditionalCacheCheck(url, etag);
  return bytes;
}

async function checkEncodedObject(
  url: URL,
  encoding: "gzip" | "br",
  immutable: boolean,
): Promise<void> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`${url} HEAD HTTP ${response.status}`);
  }
  const actualEncoding = requireHeader(response, "content-encoding", url);
  if (actualEncoding !== encoding) {
    throw new Error(`${url} Content-Encoding=${actualEncoding}，期望 ${encoding}`);
  }
  const cacheControl = requireHeader(response, "cache-control", url);
  if (immutable && !cacheControl.includes("immutable")) {
    throw new Error(`${url} 版本路径缺少 immutable Cache-Control`);
  }
}

export async function probeCatalog(input: {
  baseUrl: string;
  repositoryRoot: string;
  allowHttp?: boolean;
}): Promise<ProbeResult> {
  const base = new URL(input.baseUrl);
  if (base.protocol !== "https:" && input.allowHttp !== true) {
    throw new Error("国内发布探测默认要求 HTTPS；本地测试可显式 allowHttp");
  }
  const manifestUrl = urlAt(base, "manifest.json");
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`${manifestUrl} HTTP ${manifestResponse.status}`);
  }
  const manifestEtag = requireHeader(manifestResponse, "etag", manifestUrl);
  const manifestCache = requireHeader(manifestResponse, "cache-control", manifestUrl);
  if (!manifestCache.includes("no-cache") && !manifestCache.includes("max-age=0")) {
    throw new Error("manifest 必须可重新验证，不能使用长缓存");
  }
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  const validators = await createValidators(input.repositoryRoot);
  const manifestIssues = validateWith(validators.manifest, manifest, manifestUrl.toString());
  if (manifestIssues.length > 0) {
    throw new Error(formatValidationIssues(manifestIssues));
  }
  await conditionalCacheCheck(manifestUrl, manifestEtag);

  const homepageFile = manifest.files.find((file) => file.path === "index.html");
  if (homepageFile === undefined) {
    throw new Error("manifest 缺少 index.html，CDN 无法提供目录浏览首页");
  }
  await fetchBytesWithCache(
    urlAt(base, ""),
    homepageFile.sha256,
    homepageFile.content_type,
  );

  const immutableManifestUrl = urlAt(base, `${manifest.immutable_base_path}manifest.json`);
  const immutableManifestResponse = await fetch(immutableManifestUrl);
  if (!immutableManifestResponse.ok) {
    throw new Error(`${immutableManifestUrl} HTTP ${immutableManifestResponse.status}`);
  }
  const immutableManifestCache = requireHeader(
    immutableManifestResponse,
    "cache-control",
    immutableManifestUrl,
  );
  if (!immutableManifestCache.includes("immutable")) {
    throw new Error(`${immutableManifestUrl} 缺少 immutable Cache-Control`);
  }
  const immutableManifestBytes = new Uint8Array(
    await immutableManifestResponse.arrayBuffer(),
  );
  if (sha256(immutableManifestBytes) !== sha256(manifestBytes)) {
    throw new Error(`${immutableManifestUrl} 与当前 manifest 内容不一致`);
  }

  let searchItems = 0;
  let providerShards = 0;
  let siteFiles = 0;
  for (const file of manifest.files) {
    const bytes = await fetchBytesWithCache(
      urlAt(base, file.path),
      file.sha256,
      file.content_type,
    );
    const immutableUrl = urlAt(base, file.immutable_path);
    const immutableResponse = await fetch(immutableUrl);
    if (!immutableResponse.ok) {
      throw new Error(`${immutableUrl} HTTP ${immutableResponse.status}`);
    }
    const immutableCache = requireHeader(immutableResponse, "cache-control", immutableUrl);
    if (!immutableCache.includes("immutable")) {
      throw new Error(`${immutableUrl} 缺少 immutable Cache-Control`);
    }
    if (sha256(new Uint8Array(await immutableResponse.arrayBuffer())) !== file.sha256) {
      throw new Error(`${immutableUrl} SHA-256 与 manifest 不一致`);
    }
    await Promise.all([
      checkEncodedObject(urlAt(base, file.encodings.gzip.path), "gzip", false),
      checkEncodedObject(urlAt(base, file.encodings.br.path), "br", false),
      checkEncodedObject(urlAt(base, file.encodings.gzip.immutable_path), "gzip", true),
      checkEncodedObject(urlAt(base, file.encodings.br.immutable_path), "br", true),
    ]);
    if (file.path === "search-index.json") {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const issues = validateWith(validators.searchIndex, parsed, file.path);
      if (issues.length > 0) {
        throw new Error(formatValidationIssues(issues));
      }
      searchItems = (parsed as { items: unknown[] }).items.length;
    }
    if (file.path.startsWith("providers/")) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const issues = validateWith(validators.providerShard, parsed, file.path);
      if (issues.length > 0) {
        throw new Error(formatValidationIssues(issues));
      }
      providerShards += 1;
    }
    if (file.path === "catalog.json") {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const issues = validateWith(validators.catalog, parsed, file.path);
      if (issues.length > 0) {
        throw new Error(formatValidationIssues(issues));
      }
    }
    if (
      file.path === "index.html" ||
      file.path === "assets/catalog.css" ||
      file.path === "assets/catalog.js"
    ) {
      siteFiles += 1;
    }
  }
  if (searchItems === 0 || providerShards === 0 || siteFiles !== 3) {
    throw new Error("搜索索引、provider 分片或站点文件不完整");
  }
  return {
    baseUrl: base.toString(),
    catalogVersion: manifest.catalog_version,
    homepage: true,
    logicalFiles: manifest.files.length,
    providerShards,
    searchItems,
    siteFiles,
  };
}
