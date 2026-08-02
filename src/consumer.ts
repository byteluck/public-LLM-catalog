import { sha256 } from "./json.js";
import type { AggregatedCatalog, Manifest } from "./types.js";
import { createValidators, formatValidationIssues, validateWith } from "./validate.js";

export interface CatalogCache {
  read(): Promise<{
    version: string;
    catalog: AggregatedCatalog;
    manifestEtag?: string;
  } | null>;
  write(value: {
    version: string;
    catalog: AggregatedCatalog;
    manifestEtag?: string;
  }): Promise<void>;
}

export interface RefreshResult {
  catalog: AggregatedCatalog;
  source: "download" | "cache" | "builtin_snapshot";
  catalogDownloaded: boolean;
  diagnostic?: string;
}

function urlAt(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base).toString();
}

function compareSchemaVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const parts = value.split(".").map(Number);
    if (
      parts.length !== 3 ||
      parts.some((part) => !Number.isInteger(part) || part < 0)
    ) {
      throw new Error(`无效 schema version: ${value}`);
    }
    return parts as [number, number, number];
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export async function refreshCatalog(input: {
  baseUrl: string;
  cache: CatalogCache;
  builtinSnapshot: AggregatedCatalog;
  repositoryRoot: string;
  supportedSchemaVersion: string;
  fetchImplementation?: typeof fetch;
}): Promise<RefreshResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const validators = await createValidators(input.repositoryRoot);
  const snapshotIssues = validateWith(
    validators.catalog,
    input.builtinSnapshot,
    "snapshots/catalog.json",
  );
  if (snapshotIssues.length > 0) {
    throw new Error(`内置快照校验失败:\n${formatValidationIssues(snapshotIssues)}`);
  }
  const cached = await input.cache.read();
  try {
    const manifestResponse = await fetchImplementation(urlAt(input.baseUrl, "manifest.json"), {
      headers:
        cached?.manifestEtag === undefined
          ? undefined
          : { "if-none-match": cached.manifestEtag },
    });
    if (manifestResponse.status === 304) {
      if (cached === null) {
        throw new Error("manifest 返回 304，但本地没有目录缓存");
      }
      return { catalog: cached.catalog, source: "cache", catalogDownloaded: false };
    }
    if (!manifestResponse.ok) {
      throw new Error(`manifest HTTP ${manifestResponse.status}`);
    }
    const manifest = (await manifestResponse.json()) as Manifest;
    const manifestIssues = validateWith(validators.manifest, manifest, "manifest.json");
    if (manifestIssues.length > 0) {
      throw new Error(`manifest 校验失败:\n${formatValidationIssues(manifestIssues)}`);
    }
    if (
      compareSchemaVersions(
        input.supportedSchemaVersion,
        manifest.minimum_consumer_schema_version,
      ) < 0
    ) {
      throw new Error(
        `消费端 Schema ${input.supportedSchemaVersion} 低于目录要求 ${manifest.minimum_consumer_schema_version}`,
      );
    }
    const manifestEtag = manifestResponse.headers.get("etag") ?? undefined;
    if (cached?.version === manifest.catalog_version) {
      await input.cache.write({
        version: cached.version,
        catalog: cached.catalog,
        ...(manifestEtag === undefined ? {} : { manifestEtag }),
      });
      return { catalog: cached.catalog, source: "cache", catalogDownloaded: false };
    }
    const catalogFile = manifest.files.find((file) => file.path === "catalog.json");
    if (catalogFile === undefined) {
      throw new Error("manifest 缺少 catalog.json");
    }
    const catalogResponse = await fetchImplementation(urlAt(input.baseUrl, catalogFile.path));
    if (!catalogResponse.ok) {
      throw new Error(`catalog HTTP ${catalogResponse.status}`);
    }
    const bytes = new Uint8Array(await catalogResponse.arrayBuffer());
    if (bytes.byteLength !== catalogFile.size) {
      throw new Error("catalog 字节数与 manifest 不一致");
    }
    if (sha256(bytes) !== catalogFile.sha256) {
      throw new Error("catalog SHA-256 与 manifest 不一致");
    }
    const catalog = JSON.parse(new TextDecoder().decode(bytes)) as AggregatedCatalog;
    const catalogIssues = validateWith(validators.catalog, catalog, catalogFile.path);
    if (catalogIssues.length > 0) {
      throw new Error(`catalog 校验失败:\n${formatValidationIssues(catalogIssues)}`);
    }
    if (
      catalog.catalog_version !== manifest.catalog_version ||
      catalog.schema_version !== manifest.schema_version
    ) {
      throw new Error("catalog 与 manifest 的版本不一致");
    }
    await input.cache.write({
      version: manifest.catalog_version,
      catalog,
      ...(manifestEtag === undefined ? {} : { manifestEtag }),
    });
    return { catalog, source: "download", catalogDownloaded: true };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (cached !== null) {
      return {
        catalog: cached.catalog,
        source: "cache",
        catalogDownloaded: false,
        diagnostic,
      };
    }
    return {
      catalog: input.builtinSnapshot,
      source: "builtin_snapshot",
      catalogDownloaded: false,
      diagnostic,
    };
  }
}
