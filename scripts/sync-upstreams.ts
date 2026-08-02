import { join } from "node:path";

import { readJson } from "../src/json.js";
import { loadSourceCatalog } from "../src/load.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { syncUpstreamCandidates, type UpstreamConfig } from "../src/upstream.js";

const [config, catalog] = await Promise.all([
  readJson<UpstreamConfig>(join(REPOSITORY_ROOT, "catalog", "upstreams.json")),
  loadSourceCatalog(REPOSITORY_ROOT),
]);
const review = await syncUpstreamCandidates({
  config,
  catalog,
  outputDirectory: join(REPOSITORY_ROOT, "upstream", "candidates"),
});
console.log(
  review.review_required
    ? `上游候选已更新，${review.items.length} 项冲突/降级/删除需要人工审核；权威目录未改动。`
    : "上游候选已更新，无需人工处理的冲突；权威目录未改动。",
);
