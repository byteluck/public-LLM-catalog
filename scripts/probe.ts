import { REPOSITORY_ROOT } from "../src/paths.js";
import { probeCatalog } from "../src/probe.js";

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const configured = process.env.CATALOG_PROBE_BASE_URLS?.split(",")
  .map((value) => value.trim())
  .filter((value) => value !== "");
const urls = positional.length > 0 ? positional : (configured ?? []);
if (urls.length === 0) {
  throw new Error("请传入至少一个国内静态地址，或设置 CATALOG_PROBE_BASE_URLS");
}
for (const baseUrl of urls) {
  const result = await probeCatalog({
    baseUrl,
    repositoryRoot: REPOSITORY_ROOT,
    allowHttp: process.argv.includes("--allow-http"),
  });
  console.log(JSON.stringify(result));
}
