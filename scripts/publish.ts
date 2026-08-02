import { join } from "node:path";

import {
  createPublishPlan,
  executeFilesystemPlan,
  executeS3CompatiblePlan,
  type ObjectStoreProvider,
} from "../src/publish.js";
import { REPOSITORY_ROOT } from "../src/paths.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv.includes("--help")) {
  console.log(`用法:
  npm run publish -- --provider oss|cos|tos|s3 --endpoint https://... --bucket BUCKET [--prefix catalog] [--execute]
  npm run publish -- --provider filesystem --destination /path/to/root [--prefix catalog] [--execute]

默认仅输出经过哈希校验的计划；--execute 才会写入。OSS/COS/TOS 使用其 S3 兼容 endpoint，凭据只从 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY 等环境变量读取。`);
  process.exit(0);
}

const provider = (option("--provider") ?? "filesystem") as ObjectStoreProvider;
if (!(["oss", "cos", "tos", "s3", "filesystem"] as string[]).includes(provider)) {
  throw new Error(`不支持的 provider: ${provider}`);
}
const plan = await createPublishPlan({
  distDirectory: join(REPOSITORY_ROOT, "dist"),
  provider,
  prefix: option("--prefix") ?? "",
});

if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify(plan, null, 2));
} else if (provider === "filesystem") {
  const destination = option("--destination");
  if (destination === undefined) {
    throw new Error("filesystem 发布需要 --destination");
  }
  await executeFilesystemPlan(plan, destination);
  console.log(`已按 manifest 顺序发布 ${plan.objects.length} 个文件；manifest 最后写入。`);
} else {
  const endpoint = option("--endpoint");
  const bucket = option("--bucket");
  if (endpoint === undefined || bucket === undefined) {
    throw new Error("对象存储发布需要 --endpoint 与 --bucket");
  }
  await executeS3CompatiblePlan({ plan, endpoint, bucket });
  console.log(`已按 manifest 顺序发布 ${plan.objects.length} 个对象；manifest 最后写入。`);
}
