import { buildRepository } from "../src/build.js";
import { REPOSITORY_ROOT } from "../src/paths.js";

const manifest = await buildRepository(REPOSITORY_ROOT);
console.log(`已确定性生成 catalog ${manifest.catalog_version}（${manifest.files.length} 个逻辑文件）。`);
