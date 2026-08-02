import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { readJson, sha256 } from "./json.js";
import type { Manifest, ManifestFile } from "./types.js";

export type ObjectStoreProvider = "oss" | "cos" | "tos" | "s3" | "filesystem";

export interface PublishObject {
  source: string;
  key: string;
  contentType: string;
  cacheControl: string;
  contentEncoding?: "gzip" | "br";
  sha256: string;
}

export interface PublishPlan {
  provider: ObjectStoreProvider;
  objects: PublishObject[];
}

function normalizedPrefix(prefix: string): string {
  const value = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (value.split("/").includes("..")) {
    throw new Error("发布 prefix 不得包含 ..");
  }
  return value;
}

function keyFor(prefix: string, path: string): string {
  return prefix === "" ? path : posix.join(prefix, path);
}

function objectsForManifestFile(
  root: string,
  prefix: string,
  file: ManifestFile,
): PublishObject[] {
  return [
    {
      source: join(root, file.path),
      key: keyFor(prefix, file.path),
      contentType: file.content_type,
      cacheControl: file.cache_control,
      sha256: file.sha256,
    },
    {
      source: join(root, file.encodings.gzip.path),
      key: keyFor(prefix, file.encodings.gzip.path),
      contentType: file.content_type,
      cacheControl: file.cache_control,
      contentEncoding: "gzip",
      sha256: file.encodings.gzip.sha256,
    },
    {
      source: join(root, file.encodings.br.path),
      key: keyFor(prefix, file.encodings.br.path),
      contentType: file.content_type,
      cacheControl: file.cache_control,
      contentEncoding: "br",
      sha256: file.encodings.br.sha256,
    },
    {
      source: join(root, file.immutable_path),
      key: keyFor(prefix, file.immutable_path),
      contentType: file.content_type,
      cacheControl: file.immutable_cache_control,
      sha256: file.sha256,
    },
    {
      source: join(root, file.encodings.gzip.immutable_path),
      key: keyFor(prefix, file.encodings.gzip.immutable_path),
      contentType: file.content_type,
      cacheControl: file.immutable_cache_control,
      contentEncoding: "gzip",
      sha256: file.encodings.gzip.sha256,
    },
    {
      source: join(root, file.encodings.br.immutable_path),
      key: keyFor(prefix, file.encodings.br.immutable_path),
      contentType: file.content_type,
      cacheControl: file.immutable_cache_control,
      contentEncoding: "br",
      sha256: file.encodings.br.sha256,
    },
  ];
}

export async function createPublishPlan(input: {
  distDirectory: string;
  provider: ObjectStoreProvider;
  prefix: string;
}): Promise<PublishPlan> {
  const distDirectory = resolve(input.distDirectory);
  const prefix = normalizedPrefix(input.prefix);
  const manifestPath = join(distDirectory, "manifest.json");
  const manifest = await readJson<Manifest>(manifestPath);
  const objects = manifest.files.flatMap((file) =>
    objectsForManifestFile(distDirectory, prefix, file),
  );
  const manifestBytes = await readFile(manifestPath);
  objects.push({
    source: manifestPath,
    key: keyFor(prefix, `${manifest.immutable_base_path}manifest.json`),
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=31536000, immutable",
    sha256: sha256(manifestBytes),
  });
  objects.push({
    source: manifestPath,
    key: keyFor(prefix, "manifest.json"),
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-cache, max-age=0, must-revalidate",
    sha256: sha256(manifestBytes),
  });

  for (const object of objects) {
    const info = await stat(object.source);
    if (!info.isFile()) {
      throw new Error(`发布源不是文件: ${object.source}`);
    }
    const actual = sha256(await readFile(object.source));
    if (actual !== object.sha256) {
      throw new Error(`发布前哈希校验失败: ${object.source}`);
    }
  }
  const manifestObject = objects.pop();
  if (manifestObject === undefined) {
    throw new Error("发布计划缺少 manifest");
  }
  objects.sort((left, right) => {
    const leftVersioned = left.key.includes("/versioned/") || left.key.startsWith("versioned/");
    const rightVersioned = right.key.includes("/versioned/") || right.key.startsWith("versioned/");
    if (leftVersioned !== rightVersioned) {
      return leftVersioned ? -1 : 1;
    }
    return left.key.localeCompare(right.key, "en");
  });
  objects.push(manifestObject);
  return { provider: input.provider, objects };
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} 退出码 ${code ?? "signal"}`));
      }
    });
  });
}

export async function executeS3CompatiblePlan(input: {
  plan: PublishPlan;
  endpoint: string;
  bucket: string;
}): Promise<void> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:") {
    throw new Error("对象存储 endpoint 必须使用 HTTPS");
  }
  if (input.bucket.trim() === "") {
    throw new Error("bucket 不能为空");
  }
  for (const object of input.plan.objects) {
    const args = [
      "--endpoint-url",
      endpoint.toString(),
      "s3api",
      "put-object",
      "--bucket",
      input.bucket,
      "--key",
      object.key,
      "--body",
      object.source,
      "--content-type",
      object.contentType,
      "--cache-control",
      object.cacheControl,
      "--metadata",
      `sha256=${object.sha256}`,
    ];
    if (object.contentEncoding !== undefined) {
      args.push("--content-encoding", object.contentEncoding);
    }
    await run("aws", args);
  }
}

export async function executeFilesystemPlan(plan: PublishPlan, destination: string): Promise<void> {
  const targetRoot = resolve(destination);
  if (targetRoot === resolve("/") || targetRoot.length < 8) {
    throw new Error(`拒绝不安全的文件发布目标: ${targetRoot}`);
  }
  for (const object of plan.objects) {
    const target = join(targetRoot, object.key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(object.source, target);
  }
}
