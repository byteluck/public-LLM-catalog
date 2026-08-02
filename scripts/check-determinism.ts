import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToDirectory, fileTreeDigest } from "../src/build.js";
import { REPOSITORY_ROOT } from "../src/paths.js";

const temporaryRoot = await mkdtemp(join(tmpdir(), "llm-catalog-determinism-"));
const first = join(temporaryRoot, "llm-catalog-first");
const second = join(temporaryRoot, "llm-catalog-second");

try {
  await buildToDirectory(REPOSITORY_ROOT, first);
  await buildToDirectory(REPOSITORY_ROOT, second);
  const [firstDigest, secondDigest] = await Promise.all([fileTreeDigest(first), fileTreeDigest(second)]);
  const firstEntries = [...firstDigest.entries()];
  const secondEntries = [...secondDigest.entries()];
  if (JSON.stringify(firstEntries) !== JSON.stringify(secondEntries)) {
    const paths = new Set([...firstDigest.keys(), ...secondDigest.keys()]);
    const differences = [...paths]
      .filter((path) => firstDigest.get(path) !== secondDigest.get(path))
      .map((path) => `${path}: ${firstDigest.get(path) ?? "missing"} != ${secondDigest.get(path) ?? "missing"}`);
    throw new Error(`构建不确定：\n${differences.join("\n")}`);
  }
  console.log(`确定性构建通过：${firstEntries.length} 个文件逐字节哈希一致。`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
