# 国内对象存储与 CDN 部署

## 发布前提

发布机需要 Node.js 22、`npm ci` 可用，以及执行对象上传时可用的 AWS CLI。OSS、COS、TOS 通过各自 S3 兼容 endpoint 上传；也可以只读取 `npm run publish` 的 JSON 计划接入企业内部发布器。

发布前必须在干净的 commit 上通过：

```bash
npm ci
npm run check
git diff --check
```

发布脚本默认只打印计划，不写外部状态。加 `--execute` 才上传。Access Key、Secret 和 bucket 名不写入仓库；AWS CLI 仅从环境或 CI Secret 读取凭据。

## 对象存储示例

以下 endpoint 只演示格式，应按账户地域从云厂商官方控制台/文档取得准确值：

```bash
# 阿里云 OSS，例如杭州
npm run publish -- \
  --provider oss \
  --endpoint https://oss-cn-hangzhou.aliyuncs.com \
  --bucket "$CATALOG_BUCKET_NAME" \
  --prefix public-llm-catalog \
  --execute

# 腾讯云 COS，例如上海
npm run publish -- \
  --provider cos \
  --endpoint https://cos.ap-shanghai.myqcloud.com \
  --bucket "$CATALOG_BUCKET_NAME" \
  --prefix public-llm-catalog \
  --execute

# 火山引擎 TOS S3 兼容 endpoint，例如北京
npm run publish -- \
  --provider tos \
  --endpoint https://tos-s3-cn-beijing.volces.com \
  --bucket "$CATALOG_BUCKET_NAME" \
  --prefix public-llm-catalog \
  --execute
```

脚本拒绝非 HTTPS endpoint、空 bucket、不安全 prefix、发布前哈希不符和不安全的本地目标。若企业发布器不兼容 AWS CLI，可运行：

```bash
npm run --silent publish -- --provider oss --prefix public-llm-catalog > publish-plan.json
```

计划中的每项都包含源文件、对象键、Content-Type、Content-Encoding、Cache-Control 和 SHA-256；必须保持原值和顺序。

## 原子发布顺序

发布计划按以下顺序执行：

1. `versioned/{version}/` 不可变对象、该版本 manifest 及 `.gz`、`.br` sidecar。
2. 当前 `catalog.json`、provider 分片和 search index 及其压缩 sidecar。
3. 最后写 `manifest.json`，把它作为版本切换点。

任一前置上传失败时不会替换 manifest，现有消费者仍看到旧版本。相同 `catalog_version` 的不可变路径禁止覆盖内容；若内容变化，必须先升级版本。

## 元数据与 CDN 规则

| 对象 | Cache-Control | Content-Type | Content-Encoding |
| --- | --- | --- | --- |
| `manifest.json` | `no-cache, max-age=0, must-revalidate` | `application/json; charset=utf-8` | 无 |
| 当前逻辑 JSON | `public, max-age=300, must-revalidate` | `application/json; charset=utf-8` | 无 |
| 当前 `.gz` / `.br` | 同当前逻辑 JSON | `application/json; charset=utf-8` | `gzip` / `br` |
| `versioned/{version}/...` | `public, max-age=31536000, immutable` | 同上 | 按 sidecar 设置 |

对象同时写入 `x-amz-meta-sha256`。CDN 应：

- 保留 Origin 的 ETag、Cache-Control、Content-Type 和 Content-Encoding。
- 支持 `If-None-Match` 并返回 304；不要删掉 ETag。
- 不缓存 4xx/5xx 为长 TTL，不把 manifest 配成 immutable。
- 不对已经压缩的 `.gz`/`.br` 再压缩。
- HTTPS 域名、证书和 DNS 均在中国大陆可访问；如面向公众按要求完成备案。
- 如通过内容协商自动选择编码，仍保留显式 sidecar URL供探测，并正确设置 `Vary: Accept-Encoding`。

## 国内网络探测

在国内机房或目标运营商的 runner 上执行：

```bash
npm run probe -- https://cdn.example.cn/public-llm-catalog/
```

也可同时检查多个 CDN：

```bash
CATALOG_PROBE_BASE_URLS='https://cdn-a.example.cn/catalog/,https://cdn-b.example.cn/catalog/' npm run probe
```

探测会校验：

- manifest 可打开、Schema 正确、可重新验证且 `If-None-Match` 得到 304。
- 全量目录、搜索索引和所有 provider 分片可下载，大小/内容 SHA-256 与 manifest 一致。
- 不可变版本路径内容一致并带 `immutable`。
- gzip/brotli sidecar 存在且 Content-Encoding 正确。
- 搜索索引和 provider 分片非空。

`.github/workflows/publish.yml` 把上传和探测拆成两个 job。`probe-cn` 明确要求带 `self-hosted`、`linux`、`cn-network` 标签的中国大陆 runner；不能用境外 GitHub-hosted runner 冒充国内网络验收。

## 消费配置

业务端只配置国内根地址，例如：

```properties
ai.llm.public-model-catalog.base-url=https://cdn.example.cn/public-llm-catalog/
```

不要配置 GitHub、models.dev、LiteLLM 或海外厂商 URL 作为运行时 fallback。刷新过程只先请求 manifest；版本未变不下载 `catalog.json`。网络、Schema 或哈希失败时继续使用最后成功缓存，没有缓存才加载随应用打包的 `snapshots/catalog.json`。

## 凭据与回滚

- CI 只授予目标 prefix 的 PutObject 权限；探测 job 不持有对象存储密钥。
- 日志不得输出环境、Key、签名 URL 或私有 Base URL。
- 回滚时重新发布上一个已验证版本的“当前路径”，最后写回该版本的 manifest；不可删除历史 versioned 对象。
- 删除历史版本是独立、人工批准的保留策略操作，不属于本发布脚本。
