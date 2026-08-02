# 国内可访问的公开大模型能力目录

本仓库维护供应商中立、版本化、机器可读的公开模型能力事实，并生成可直接发布到国内对象存储/CDN 的静态 JSON。运行时不依赖数据库，也不直接访问 GitHub、models.dev、LiteLLM 或国外厂商站点。

> 当前为首个目录版本。参见[架构说明](docs/architecture.md)、[Schema 语义](docs/schema-reference.md)、[候选来源矩阵](docs/source-matrix.md)、[国内部署](docs/deployment-cn.md)、[现有项目审计与集成边界](docs/audit-and-integration.md)和[维护流程](docs/operations.md)。

## 快速开始

```bash
npm ci
npm run validate
npm run build
npm test
```

消费端从 `dist/manifest.json` 开始：目录版本未变化时不下载完整目录；不可用时回退到 `snapshots/catalog.json`。

## 数据边界

- `catalog/models/`：canonical model，描述模型本身的能力事实。
- `catalog/providers/` 与 `catalog/offerings/`：供应商公开 API 标识、协议、限制和状态。
- `catalog/aliases/`：公开别名映射；私有模型标识应由租户部署 override 映射。
- API Key、私有 Base URL、环境、权重和负载均衡等 tenant deployment 数据禁止进入本仓库。
- `temperature`、`top_p`、`top_k` 只记录供应商 offering 是否支持、范围、官方默认值和协议映射，不保存业务默认运行值。

## 常用命令

```bash
npm run validate          # Schema、引用、证据、唯一性、别名和安全校验
npm run build             # 确定性生成 dist/ 与内置快照
npm run check:determinism # 连续构建并比较全部字节和哈希
npm run probe -- <URL>    # 探测国内静态目录（也可用环境变量）
npm run publish -- --help # 生成/执行对象存储同步计划
npm run check             # lint、typecheck、测试、校验和确定性构建
```

## 初始覆盖

当前覆盖 FDE 默认值和契约测试出现的四类配置：GPT-5.5（聊天）、GLM-5.2（推理/工具）、GLM-4.6V（多模态）和 Embedding-3。不能从官方来源可靠确认的字段均保留为 `unknown`；这四个示例不构成推荐或可用性承诺。
