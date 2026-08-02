import { constants as zlibConstants, brotliCompressSync, gzipSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { readJson, sha256, stableJson } from "./json.js";
import { assertValidSourceCatalog, createValidators, formatValidationIssues, validateWith } from "./validate.js";
import type {
  AggregatedCatalog,
  AliasSet,
  ModelsDevCandidates,
  Manifest,
  ManifestFile,
  Offering,
  Provider,
  SourceCatalog,
  StaticContentType,
} from "./types.js";

const CURRENT_CACHE_CONTROL = "public, max-age=300, must-revalidate";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8" as const;
const SVG_CONTENT_TYPE = "image/svg+xml; charset=utf-8" as const;

interface LogicalFile {
  contents: string;
  contentType: StaticContentType;
  cacheControl?: string;
}

interface SearchIndexItem {
  canonical_id: string;
  offering_id: string;
  provider_id: string;
  provider_name: string;
  api_model_id: string;
  name: string;
  family: string;
  aliases: string[];
  kind: "chat" | "embedding";
  status: string;
  input_modalities: string[];
  output_modalities: string[];
}

function sortBy<T>(values: T[], selector: (value: T) => string): T[] {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right), "en"));
}

export function aggregateCatalog(source: SourceCatalog): AggregatedCatalog {
  return {
    schema_version: source.release.schema_version,
    catalog_version: source.release.catalog_version,
    generated_at: source.release.generated_at,
    models: sortBy(source.models, (model) => model.canonical_id),
    providers: sortBy(source.providers, (provider) => provider.provider_id),
    offerings: sortBy(source.offerings, (offering) => offering.offering_id),
    aliases: sortBy(source.aliases, (aliasSet) => aliasSet.alias_set_id),
  };
}

function providerShard(
  source: SourceCatalog,
  provider: Provider,
): Record<string, unknown> {
  const offerings = sortBy(
    source.offerings.filter((offering) => offering.provider_id === provider.provider_id),
    (offering) => offering.offering_id,
  );
  const canonicalIds = new Set(offerings.map((offering) => offering.canonical_id));
  const aliases = source.aliases
    .map((aliasSet): AliasSet => ({
      ...aliasSet,
      entries: aliasSet.entries.filter(
        (entry) => entry.provider_id === null || entry.provider_id === provider.provider_id,
      ),
    }))
    .filter((aliasSet) => aliasSet.entries.length > 0);
  return {
    schema_version: source.release.schema_version,
    catalog_version: source.release.catalog_version,
    generated_at: source.release.generated_at,
    provider,
    models: sortBy(
      source.models.filter((model) => canonicalIds.has(model.canonical_id)),
      (model) => model.canonical_id,
    ),
    offerings,
    aliases,
  };
}

function aliasNames(aliasSets: AliasSet[], offering: Offering): string[] {
  return aliasSets
    .flatMap((set) => set.entries)
    .filter(
      (entry) =>
        (entry.provider_id === null || entry.provider_id === offering.provider_id) &&
        ((entry.target_type === "offering" && entry.target_id === offering.offering_id) ||
          (entry.target_type === "canonical" && entry.target_id === offering.canonical_id)),
    )
    .map((entry) => entry.alias)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function searchIndex(source: SourceCatalog): Record<string, unknown> {
  const models = new Map(source.models.map((model) => [model.canonical_id, model]));
  const providers = new Map(source.providers.map((provider) => [provider.provider_id, provider]));
  const items = source.offerings.map((offering): SearchIndexItem => {
    const model = models.get(offering.canonical_id);
    if (model === undefined) {
      throw new Error(`构建搜索索引时 canonical model 不存在: ${offering.canonical_id}`);
    }
    const provider = providers.get(offering.provider_id);
    if (provider === undefined) {
      throw new Error(`构建搜索索引时 provider 不存在: ${offering.provider_id}`);
    }
    return {
      canonical_id: model.canonical_id,
      offering_id: offering.offering_id,
      provider_id: offering.provider_id,
      provider_name: provider.name,
      api_model_id: offering.api_model_id,
      name: offering.name,
      family: model.family,
      aliases: [...new Set([...model.aliases, ...aliasNames(source.aliases, offering)])].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
      kind: model.kind,
      status: offering.status,
      input_modalities: offering.modalities.input_modalities,
      output_modalities: offering.modalities.output_modalities,
    };
  });
  return {
    schema_version: source.release.schema_version,
    catalog_version: source.release.catalog_version,
    generated_at: source.release.generated_at,
    items: sortBy(items, (item) => `${item.name.toLowerCase()}\u0000${item.offering_id}`),
  };
}

function safeOutputDirectory(directory: string, repositoryRoot: string): void {
  const target = resolve(directory);
  const root = resolve(repositoryRoot);
  if (
    target === root ||
    target === resolve(homedir()) ||
    target === parse(target).root ||
    target === resolve(tmpdir()) ||
    target.length < 8
  ) {
    throw new Error(`拒绝覆盖不安全的输出目录: ${target}`);
  }
}

function assertSafeSvg(contents: string, path: string): void {
  if (!/^\s*<svg\b[\s\S]*<\/svg>\s*$/u.test(contents)) {
    throw new Error(`logo 不是完整 SVG 文档: ${path}`);
  }
  if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']https?:/iu.test(contents)) {
    throw new Error(`logo 包含不允许的活动内容或外部引用: ${path}`);
  }
}

async function writeBytes(filePath: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

function compressed(buffer: Buffer): { gzip: Buffer; br: Buffer } {
  return {
    gzip: gzipSync(buffer, { level: 9 }),
    br: brotliCompressSync(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.byteLength,
      },
    }),
  };
}

async function writeLogicalFile(
  outputDirectory: string,
  version: string,
  path: string,
  file: LogicalFile,
): Promise<ManifestFile> {
  const { contents } = file;
  const immutablePath = `versioned/${version}/${path}`;
  const buffer = Buffer.from(contents, "utf8");
  const encoded = compressed(buffer);
  const currentGzipPath = `${path}.gz`;
  const immutableGzipPath = `${immutablePath}.gz`;
  const currentBrPath = `${path}.br`;
  const immutableBrPath = `${immutablePath}.br`;
  await Promise.all([
    writeBytes(join(outputDirectory, path), buffer),
    writeBytes(join(outputDirectory, immutablePath), buffer),
    writeBytes(join(outputDirectory, currentGzipPath), encoded.gzip),
    writeBytes(join(outputDirectory, immutableGzipPath), encoded.gzip),
    writeBytes(join(outputDirectory, currentBrPath), encoded.br),
    writeBytes(join(outputDirectory, immutableBrPath), encoded.br),
  ]);
  const digest = sha256(buffer);
  return {
    path,
    immutable_path: immutablePath,
    size: buffer.byteLength,
    sha256: digest,
    etag: `"${digest}"`,
    cache_control: file.cacheControl ?? CURRENT_CACHE_CONTROL,
    immutable_cache_control: IMMUTABLE_CACHE_CONTROL,
    content_type: file.contentType,
    encodings: {
      gzip: {
        path: currentGzipPath,
        immutable_path: immutableGzipPath,
        size: encoded.gzip.byteLength,
        sha256: sha256(encoded.gzip),
      },
      br: {
        path: currentBrPath,
        immutable_path: immutableBrPath,
        size: encoded.br.byteLength,
        sha256: sha256(encoded.br),
      },
    },
  };
}

export async function buildToDirectory(
  repositoryRoot: string,
  outputDirectory: string,
): Promise<Manifest> {
  safeOutputDirectory(outputDirectory, repositoryRoot);
  const source = await assertValidSourceCatalog(repositoryRoot);
  const validators = await createValidators(repositoryRoot);
  const modelsDevCandidates = await readJson<ModelsDevCandidates>(
    join(repositoryRoot, "upstream", "models-dev-2026.json"),
  );
  const candidateIssues = validateWith(
    validators.modelsDevCandidates,
    modelsDevCandidates,
    "upstream/models-dev-2026.json",
  );
  if (candidateIssues.length > 0) {
    throw new Error(`models.dev 候选快照 Schema 校验失败:\n${formatValidationIssues(candidateIssues)}`);
  }
  const aggregate = aggregateCatalog(source);
  const generatedIssues = validateWith(validators.catalog, aggregate, "dist/catalog.json");
  if (generatedIssues.length > 0) {
    throw new Error(`聚合目录 Schema 校验失败:\n${formatValidationIssues(generatedIssues)}`);
  }

  const logicalFiles = new Map<string, LogicalFile>();
  logicalFiles.set("catalog.json", {
    contents: stableJson(aggregate),
    contentType: JSON_CONTENT_TYPE,
  });
  const generatedSearchIndex = searchIndex(source);
  const searchIssues = validateWith(
    validators.searchIndex,
    generatedSearchIndex,
    "dist/search-index.json",
  );
  if (searchIssues.length > 0) {
    throw new Error(`搜索索引 Schema 校验失败:\n${formatValidationIssues(searchIssues)}`);
  }
  logicalFiles.set("search-index.json", {
    contents: stableJson(generatedSearchIndex),
    contentType: JSON_CONTENT_TYPE,
  });
  logicalFiles.set("models-dev-2026.json", {
    contents: stableJson(modelsDevCandidates),
    contentType: JSON_CONTENT_TYPE,
  });
  for (const provider of sortBy(modelsDevCandidates.providers, (item) => item.provider_id)) {
    if (!/^assets\/logos\/[A-Za-z0-9._-]+\.svg$/u.test(provider.logo_path)) {
      throw new Error(`models.dev logo 路径不安全: ${provider.logo_path}`);
    }
    const sourceLogoPath = join(repositoryRoot, "upstream", "logos", `${provider.provider_id}.svg`);
    const logoContents = await readFile(sourceLogoPath, "utf8");
    assertSafeSvg(logoContents, sourceLogoPath);
    logicalFiles.set(provider.logo_path, {
      contents: logoContents,
      contentType: SVG_CONTENT_TYPE,
    });
  }
  for (const provider of sortBy(source.providers, (item) => item.provider_id)) {
    const shardPath = `providers/${provider.provider_id}.json`;
    const shard = providerShard(source, provider);
    const shardIssues = validateWith(validators.providerShard, shard, `dist/${shardPath}`);
    if (shardIssues.length > 0) {
      throw new Error(`provider 分片 Schema 校验失败:\n${formatValidationIssues(shardIssues)}`);
    }
    logicalFiles.set(shardPath, {
      contents: stableJson(shard),
      contentType: JSON_CONTENT_TYPE,
    });
  }

  const siteFiles: Array<[string, string, StaticContentType, string | undefined]> = [
    ["index.html", "web/index.html", "text/html; charset=utf-8", "no-cache, max-age=0, must-revalidate"],
    ["assets/catalog.css", "web/catalog.css", "text/css; charset=utf-8", undefined],
    ["assets/catalog.js", "web/catalog.js", "text/javascript; charset=utf-8", undefined],
  ];
  for (const [outputPath, sourcePath, contentType, cacheControl] of siteFiles) {
    logicalFiles.set(outputPath, {
      contents: await readFile(join(repositoryRoot, sourcePath), "utf8"),
      contentType,
      ...(cacheControl === undefined ? {} : { cacheControl }),
    });
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const files: ManifestFile[] = [];
  for (const [path, file] of [...logicalFiles.entries()].sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    files.push(await writeLogicalFile(outputDirectory, source.release.catalog_version, path, file));
  }
  const manifest: Manifest = {
    schema_version: source.release.schema_version,
    catalog_version: source.release.catalog_version,
    generated_at: source.release.generated_at,
    previous_catalog_version: source.release.previous_catalog_version,
    minimum_consumer_schema_version: source.release.minimum_consumer_schema_version,
    immutable_base_path: `versioned/${source.release.catalog_version}/`,
    files,
  };
  const manifestIssues = validateWith(validators.manifest, manifest, "dist/manifest.json");
  if (manifestIssues.length > 0) {
    throw new Error(`manifest Schema 校验失败:\n${formatValidationIssues(manifestIssues)}`);
  }
  const manifestContents = stableJson(manifest);
  await Promise.all([
    writeBytes(join(outputDirectory, "manifest.json"), manifestContents),
    writeBytes(
      join(outputDirectory, "versioned", source.release.catalog_version, "manifest.json"),
      manifestContents,
    ),
  ]);
  return manifest;
}

async function replaceDirectory(staging: string, target: string, backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true });
  let hadTarget = false;
  try {
    await stat(target);
    hadTarget = true;
  } catch {
    hadTarget = false;
  }
  if (hadTarget) {
    await rename(target, backup);
  }
  try {
    await rename(staging, target);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget) {
      await rename(backup, target);
    }
    throw error;
  }
}

export async function buildRepository(repositoryRoot: string): Promise<Manifest> {
  const cacheDirectory = join(repositoryRoot, ".cache");
  const staging = join(cacheDirectory, `build-${process.pid}`);
  const backup = join(cacheDirectory, `dist-backup-${process.pid}`);
  await mkdir(cacheDirectory, { recursive: true });
  const manifest = await buildToDirectory(repositoryRoot, staging);
  await replaceDirectory(staging, join(repositoryRoot, "dist"), backup);

  const snapshotsDirectory = join(repositoryRoot, "snapshots");
  const snapshotStaging = join(cacheDirectory, `snapshot-${process.pid}.json`);
  await mkdir(snapshotsDirectory, { recursive: true });
  await copyFile(join(repositoryRoot, "dist", "catalog.json"), snapshotStaging);
  await rename(snapshotStaging, join(snapshotsDirectory, "catalog.json"));
  return manifest;
}

export async function fileTreeDigest(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (current: string): Promise<void> => {
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(current, { withFileTypes: true }),
    );
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const relativePath = relative(directory, path).split(sep).join("/");
        result.set(relativePath, sha256(await readFile(path)));
      }
    }
  };
  await visit(directory);
  return result;
}

export function isManagedBuildDirectory(path: string): boolean {
  const name = basename(path);
  return name === "dist" || name.startsWith("llm-catalog-") || name.startsWith("build-");
}
