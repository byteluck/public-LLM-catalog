import { describe, expect, test } from "vitest";

import { loadSourceCatalog } from "../src/load.js";
import { readJson } from "../src/json.js";
import { REPOSITORY_ROOT } from "../src/paths.js";
import { scanForTenantData } from "../src/validate.js";
import type { AggregatedCatalog } from "../src/types.js";

describe("公开目录安全边界", () => {
  test("源目录不含密钥、私有 URL 或租户部署字段", async () => {
    const catalog = await loadSourceCatalog(REPOSITORY_ROOT);
    expect(scanForTenantData(catalog, "catalog")).toEqual([]);
  });

  test("发布目录和内置快照不含租户部署数据", async () => {
    const [published, snapshot] = await Promise.all([
      readJson<AggregatedCatalog>(`${REPOSITORY_ROOT}/dist/catalog.json`),
      readJson<AggregatedCatalog>(`${REPOSITORY_ROOT}/snapshots/catalog.json`),
    ]);
    expect(scanForTenantData(published, "dist/catalog.json")).toEqual([]);
    expect(scanForTenantData(snapshot, "snapshots/catalog.json")).toEqual([]);
  });

  test("检测常见密钥、租户字段与私网地址", () => {
    const issues = scanForTenantData(
      {
        tenantId: 7,
        endpoint: "http://192.168.1.10/v1",
        value: "sk-abcdefghijklmnopqrstuvwxyz",
      },
      "leak.json",
    );
    expect(issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["tenant_data_key", "private_url", "possible_secret"]),
    );
  });

  test("公开 provider URL 与 api_key_required 元数据不被误报", () => {
    expect(
      scanForTenantData({ api_key_required: true, url: "https://open.bigmodel.cn/api/paas/v4" }),
    ).toEqual([]);
  });
});
