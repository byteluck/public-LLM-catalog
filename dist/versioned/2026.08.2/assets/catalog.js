const BASE_URL = new URL("./", window.location.href);
const CACHE_PREFIX = "public-llm-catalog:";
const MANIFEST_CACHE_KEY = `${CACHE_PREFIX}manifest`;
const SUPPORTED_SCHEMA_MAJOR = 2;

const labels = {
  kind: { chat: "Chat", embedding: "Embedding" },
  status: {
    active: "可用",
    preview: "预览",
    deprecated: "已弃用",
    retired: "已退役",
    unknown: "未知",
  },
  modality: {
    text: "文本",
    image: "图像",
    audio: "音频",
    video: "视频",
    file: "文件",
    vector: "向量",
  },
  protocol: {
    openai_chat_completions: "OpenAI Chat Completions",
    openai_responses: "OpenAI Responses",
    anthropic_messages: "Anthropic Messages",
    embeddings: "Embeddings",
  },
  agentCapability: {
    streaming: "流式输出",
    stream_usage: "流式 usage",
    system_message: "System Message",
    tool_call: "工具调用",
    tool_choice: "工具选择",
    parallel_tool_calls: "并行工具调用",
    strict_tools: "严格工具 Schema",
    structured_output: "结构化输出",
    json_schema: "JSON Schema",
  },
  sourceType: {
    official_docs: "官方文档",
    official_api: "官方 API",
    official_model_card: "官方模型卡",
    official_repository: "官方仓库",
    upstream_aggregator: "上游聚合源",
    project_audit: "项目审计",
  },
  confidence: { high: "高", medium: "中", low: "低", unknown: "未知" },
  domesticAccess: { true: "可访问", false: "不可访问", unknown: "未知" },
  modelsDevRoute: { direct: "直连记录", free: "免费路由", router: "路由器", alias: "别名路由" },
};

const state = {
  manifest: null,
  items: [],
  filtered: [],
  providerShards: new Map(),
  providerLoads: new Map(),
  modelsDevCandidates: [],
  modelsDevProviders: new Map(),
  filteredModelsDevCandidates: [],
  offline: false,
};

function byId(id) {
  const value = document.getElementById(id);
  if (value === null) {
    throw new Error(`页面缺少必需元素: #${id}`);
  }
  return value;
}

const elements = {
  releaseState: document.querySelector(".release-state"),
  releaseLabel: byId("release-label"),
  generatedAt: byId("generated-at"),
  metricOfferings: byId("metric-offerings"),
  metricProviders: byId("metric-providers"),
  metricMultimodal: byId("metric-multimodal"),
  metricEmbedding: byId("metric-embedding"),
  filters: byId("catalog-filters"),
  search: byId("search-input"),
  provider: byId("provider-filter"),
  kind: byId("kind-filter"),
  modality: byId("modality-filter"),
  status: byId("status-filter"),
  reset: byId("reset-filters"),
  resultCount: byId("result-count"),
  loading: byId("loading-state"),
  error: byId("error-state"),
  errorMessage: byId("error-message"),
  retry: byId("retry-button"),
  grid: byId("model-grid"),
  empty: byId("empty-state"),
  emptyReset: byId("empty-reset-button"),
  modelsDevSearch: byId("models-dev-search"),
  modelsDevProvider: byId("models-dev-provider-filter"),
  modelsDevResultCount: byId("models-dev-result-count"),
  modelsDevLoading: byId("models-dev-loading"),
  modelsDevError: byId("models-dev-error"),
  modelsDevErrorMessage: byId("models-dev-error-message"),
  modelsDevGrid: byId("models-dev-grid"),
  modelsDevEmpty: byId("models-dev-empty"),
  dialog: byId("model-dialog"),
  dialogClose: byId("dialog-close"),
  dialogContent: byId("dialog-content"),
  live: byId("live-region"),
};

function createElement(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function append(parent, ...children) {
  parent.append(...children.filter((child) => child !== null));
  return parent;
}

function safeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 浏览器禁用存储或空间不足不应阻塞在线目录。
  }
}

function safeRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略不可用的浏览器存储。
  }
}

function assertManifest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.schema_version !== "string" ||
    typeof value.catalog_version !== "string" ||
    typeof value.generated_at !== "string" ||
    !Array.isArray(value.files)
  ) {
    throw new Error("manifest 结构无效");
  }
  for (const file of value.files) {
    if (
      file === null ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      typeof file.size !== "number" ||
      typeof file.sha256 !== "string"
    ) {
      throw new Error("manifest 文件描述无效");
    }
  }
  const schemaMajor = Number(value.schema_version.split(".")[0]);
  if (!Number.isInteger(schemaMajor) || schemaMajor < 1) {
    throw new Error(`manifest schema_version 无效: ${value.schema_version}`);
  }
  if (schemaMajor > SUPPORTED_SCHEMA_MAJOR) {
    throw new Error(
      `当前浏览界面最高支持 Schema ${SUPPORTED_SCHEMA_MAJOR}.x，目录为 ${value.schema_version}`,
    );
  }
  return value;
}

async function fetchManifest() {
  try {
    const response = await fetch(new URL("manifest.json", BASE_URL), {
      cache: "no-cache",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`manifest 请求失败（HTTP ${response.status}）`);
    }
    const value = assertManifest(await response.json());
    safeSet(MANIFEST_CACHE_KEY, JSON.stringify(value));
    state.offline = false;
    return value;
  } catch (error) {
    const cached = safeGet(MANIFEST_CACHE_KEY);
    if (cached === null) {
      throw error;
    }
    try {
      state.offline = true;
      return assertManifest(JSON.parse(cached));
    } catch {
      safeRemove(MANIFEST_CACHE_KEY);
      throw error;
    }
  }
}

async function digestHex(bytes) {
  if (window.crypto?.subtle === undefined) {
    throw new Error("当前浏览器不支持 Web Crypto，无法校验目录哈希");
  }
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function descriptorFor(path) {
  const descriptor = state.manifest?.files.find((file) => file.path === path);
  if (descriptor === undefined) {
    throw new Error(`manifest 未声明文件: ${path}`);
  }
  return descriptor;
}

function downloadPath(descriptor) {
  const immutableDirectory = `/${state.manifest.immutable_base_path}`;
  return BASE_URL.pathname.endsWith(immutableDirectory)
    ? descriptor.path
    : descriptor.immutable_path;
}

async function verifiedCachedText(descriptor) {
  const key = `${CACHE_PREFIX}data:${descriptor.sha256}`;
  const cached = safeGet(key);
  if (cached === null) {
    return null;
  }
  const bytes = new TextEncoder().encode(cached);
  if (bytes.byteLength !== descriptor.size || await digestHex(bytes) !== descriptor.sha256) {
    safeRemove(key);
    return null;
  }
  return cached;
}

async function fetchVerifiedJson(path) {
  const descriptor = descriptorFor(path);
  const cached = await verifiedCachedText(descriptor);
  if (cached !== null) {
    return JSON.parse(cached);
  }

  let response;
  try {
    response = await fetch(new URL(downloadPath(descriptor), BASE_URL), {
      cache: "default",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`${path} 下载失败：${error instanceof Error ? error.message : "网络异常"}`);
  }
  if (!response.ok) {
    throw new Error(`${path} 请求失败（HTTP ${response.status}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== descriptor.size) {
    throw new Error(`${path} 文件大小与 manifest 不一致`);
  }
  if (await digestHex(bytes) !== descriptor.sha256) {
    throw new Error(`${path} SHA-256 与 manifest 不一致`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  JSON.parse(text);
  safeSet(`${CACHE_PREFIX}data:${descriptor.sha256}`, text);
  return JSON.parse(text);
}

function displayDate(value) {
  if (value === "unknown") {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: value.includes("T") ? "short" : undefined,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function displayValue(value) {
  if (value === "unknown" || value === null || value === undefined) {
    return "未知";
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (Array.isArray(value)) {
    return value.map((item) => displayValue(item)).join("、");
  }
  return String(value);
}

function displayTokens(value) {
  if (value === "unknown") {
    return "未知";
  }
  return new Intl.NumberFormat("zh-CN").format(value);
}

function triState(value) {
  const stateName = value === true ? "true" : value === false ? "false" : "unknown";
  const label = value === true ? "支持" : value === false ? "不支持" : "未知";
  return createElement("span", `tri-badge ${stateName}`, label);
}

function lifecycleState(status) {
  return createElement("span", `state-label ${status}`, labels.status[status] ?? status);
}

function chip(text) {
  return createElement("span", "chip", text);
}

function normalizeSearch(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function providerName(item) {
  return typeof item.provider_name === "string" ? item.provider_name : item.provider_id;
}

function matchesSearch(item, query) {
  if (query === "") {
    return true;
  }
  return [
    item.name,
    item.api_model_id,
    item.canonical_id,
    item.offering_id,
    item.provider_id,
    providerName(item),
    item.family,
    ...item.aliases,
  ].some((value) => normalizeSearch(value).includes(query));
}

function modelsDevProviderName(providerId) {
  return state.modelsDevProviders.get(providerId)?.name ?? providerId;
}

function matchesModelsDevSearch(item, query) {
  if (query === "") {
    return true;
  }
  return [item.name, item.api_model_id, item.canonical_slug, item.provider_id, modelsDevProviderName(item.provider_id), ...item.supported_parameters]
    .some((value) => normalizeSearch(value).includes(query));
}

function candidateLogo(provider) {
  const logo = createElement("img", "candidate-logo");
  logo.src = new URL(provider.logo_path, BASE_URL).toString();
  logo.alt = `${provider.name} logo`;
  logo.loading = "lazy";
  logo.decoding = "async";
  logo.referrerPolicy = "no-referrer";
  return logo;
}

function modelsDevCandidateCard(item) {
  const provider = state.modelsDevProviders.get(item.provider_id);
  const card = createElement("article", "candidate-card");
  const header = createElement("div", "candidate-card-header");
  if (provider !== undefined) {
    append(header, candidateLogo(provider), createElement("span", "candidate-provider", provider.name));
    const logoStatus = provider.logo_status === "dedicated"
      ? "models.dev 专属 logo"
      : provider.logo_status === "mapped"
        ? `映射 logo · ${provider.logo_source_provider_id}`
        : "通用占位 logo";
    header.append(createElement("span", "candidate-logo-status", logoStatus));
  }
  const title = createElement("h3", "candidate-title", item.name);
  const apiId = createElement("code", "api-id", item.api_model_id);
  const chips = createElement("div", "chip-row");
  for (const modality of item.input_modalities) {
    chips.append(chip(`输入 · ${labels.modality[modality] ?? modality}`));
  }
  for (const modality of item.output_modalities) {
    chips.append(chip(`输出 · ${labels.modality[modality] ?? modality}`));
  }
  const facts = createElement("dl", "candidate-facts");
  facts.append(
    fact("models.dev 收录", displayDate(item.models_dev_created_at)),
    fact("路由", labels.modelsDevRoute[item.route_kind] ?? item.route_kind),
    fact("上下文", displayTokens(item.context_length)),
    fact("最大输出", displayTokens(item.max_output_tokens)),
  );
  const footer = createElement("div", "candidate-footer");
  append(
    footer,
    createElement("span", "candidate-unverified", "未官方核验"),
    createElement("span", "candidate-parameter-count", `${item.supported_parameters.length} 个上游参数提示`),
  );
  append(card, header, title, apiId, chips, facts, footer);
  return card;
}

function applyModelsDevFilters() {
  const query = normalizeSearch(elements.modelsDevSearch.value);
  state.filteredModelsDevCandidates = state.modelsDevCandidates.filter(
    (item) =>
      matchesModelsDevSearch(item, query) &&
      (elements.modelsDevProvider.value === "" || item.provider_id === elements.modelsDevProvider.value),
  );
  elements.modelsDevGrid.replaceChildren(...state.filteredModelsDevCandidates.map(modelsDevCandidateCard));
  elements.modelsDevResultCount.textContent = `显示 ${state.filteredModelsDevCandidates.length} / ${state.modelsDevCandidates.length} 个候选`;
  elements.modelsDevEmpty.hidden = state.filteredModelsDevCandidates.length !== 0;
}

function populateModelsDevProviderFilter() {
  const current = elements.modelsDevProvider.value;
  const providers = [...state.modelsDevProviders.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  elements.modelsDevProvider.replaceChildren(new Option("全部厂家", ""));
  for (const provider of providers) {
    elements.modelsDevProvider.append(new Option(provider.name, provider.provider_id));
  }
  elements.modelsDevProvider.value = providers.some((provider) => provider.provider_id === current) ? current : "";
}

async function loadModelsDevCandidates() {
  elements.modelsDevLoading.hidden = false;
  elements.modelsDevError.hidden = true;
  try {
    const snapshot = await fetchVerifiedJson("models-dev-2026.json");
    if (
      snapshot?.filter?.field !== "created" ||
      snapshot?.filter?.since !== "2026-01-01" ||
      !Array.isArray(snapshot.models) ||
      !Array.isArray(snapshot.providers)
    ) {
      throw new Error("models.dev 候选快照筛选条件或结构无效");
    }
    state.modelsDevCandidates = snapshot.models;
    state.modelsDevProviders = new Map(snapshot.providers.map((provider) => [provider.provider_id, provider]));
    populateModelsDevProviderFilter();
    applyModelsDevFilters();
    elements.modelsDevLoading.hidden = true;
  } catch (error) {
    elements.modelsDevLoading.hidden = true;
    elements.modelsDevError.hidden = false;
    elements.modelsDevErrorMessage.textContent = error instanceof Error ? error.message : "候选快照暂时无法读取。";
    elements.modelsDevResultCount.textContent = "候选加载失败";
  }
}

function applyFilters() {
  const query = normalizeSearch(elements.search.value);
  state.filtered = state.items.filter(
    (item) =>
      matchesSearch(item, query) &&
      (elements.provider.value === "" || item.provider_id === elements.provider.value) &&
      (elements.kind.value === "" || item.kind === elements.kind.value) &&
      (elements.modality.value === "" || item.input_modalities.includes(elements.modality.value)) &&
      (elements.status.value === "" || item.status === elements.status.value),
  );
  renderCards();
}

function cardFor(item) {
  const card = createElement("button", "model-card");
  card.type = "button";
  card.setAttribute("aria-label", `查看 ${item.name} 的能力详情`);

  const top = createElement("span", "card-topline");
  append(
    top,
    createElement("span", "", providerName(item)),
    createElement("span", `kind-label ${item.kind}`, labels.kind[item.kind] ?? item.kind),
  );

  const body = createElement("span", "card-body");
  const title = createElement("span", "card-title", item.name);
  const apiId = createElement("span", "api-id", item.api_model_id);
  const modalities = createElement("span", "modality-row");
  for (const modality of item.input_modalities) {
    modalities.append(chip(`输入 · ${labels.modality[modality] ?? modality}`));
  }
  for (const modality of item.output_modalities) {
    modalities.append(chip(`输出 · ${labels.modality[modality] ?? modality}`));
  }
  const footer = createElement("span", "card-footer");
  append(
    footer,
    lifecycleState(item.status),
    createElement("span", "card-arrow", "↗"),
  );
  append(body, title, apiId, modalities, footer);
  append(card, top, body);
  card.addEventListener("click", () => {
    void openDetail(item);
  });
  return card;
}

function renderCards() {
  elements.grid.replaceChildren(...state.filtered.map((item) => cardFor(item)));
  elements.resultCount.textContent = `显示 ${state.filtered.length} / ${state.items.length} 个 API Offering`;
  elements.empty.hidden = state.filtered.length !== 0;
}

function populateProviderFilter() {
  const current = elements.provider.value;
  const providers = [...new Map(state.items.map((item) => [item.provider_id, providerName(item)]))]
    .sort((left, right) => left[1].localeCompare(right[1], "zh-CN"));
  elements.provider.replaceChildren(new Option("全部供应商", ""));
  for (const [providerId, providerName] of providers) {
    elements.provider.append(new Option(providerName, providerId));
  }
  elements.provider.value = providers.some(([providerId]) => providerId === current) ? current : "";
}

function renderMetrics(index) {
  const providerCount = new Set(index.items.map((item) => item.provider_id)).size;
  const multimodalCount = index.items.filter(
    (item) => item.input_modalities.some((modality) => modality !== "text"),
  ).length;
  const embeddingCount = index.items.filter((item) => item.kind === "embedding").length;
  elements.metricOfferings.textContent = String(index.items.length);
  elements.metricProviders.textContent = String(providerCount);
  elements.metricMultimodal.textContent = String(multimodalCount);
  elements.metricEmbedding.textContent = String(embeddingCount);
  elements.generatedAt.textContent = displayDate(index.generated_at);
}

function renderReleaseState() {
  elements.releaseState?.classList.toggle("is-cached", state.offline);
  elements.releaseState?.classList.toggle("is-ready", !state.offline);
  elements.releaseLabel.textContent = state.offline
    ? `缓存版本 ${state.manifest.catalog_version}`
    : `目录版本 ${state.manifest.catalog_version}`;
}

function resetFilters() {
  elements.filters.reset();
  elements.search.value = "";
  elements.provider.value = "";
  elements.kind.value = "";
  elements.modality.value = "";
  elements.status.value = "";
  applyFilters();
}

async function loadCatalog() {
  elements.loading.hidden = false;
  elements.error.hidden = true;
  elements.empty.hidden = true;
  elements.grid.replaceChildren();
  elements.resultCount.textContent = "正在读取索引…";
  try {
    state.manifest = await fetchManifest();
    renderReleaseState();
    const index = await fetchVerifiedJson("search-index.json");
    if (
      !Array.isArray(index.items) ||
      index.catalog_version !== state.manifest.catalog_version ||
      index.schema_version !== state.manifest.schema_version
    ) {
      throw new Error("搜索索引与 manifest 版本不一致");
    }
    state.items = index.items;
    renderMetrics(index);
    populateProviderFilter();
    applyFilters();
    await loadModelsDevCandidates();
    elements.loading.hidden = true;
    const requestedModel = new URL(window.location.href).searchParams.get("model");
    const requestedItem = state.items.find((item) => item.offering_id === requestedModel);
    if (requestedItem !== undefined) {
      await openDetail(requestedItem, false);
    }
  } catch (error) {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    elements.errorMessage.textContent = error instanceof Error ? error.message : "目录暂时无法读取。";
    elements.resultCount.textContent = "加载失败";
  }
}

async function providerShard(providerId) {
  if (state.providerShards.has(providerId)) {
    return state.providerShards.get(providerId);
  }
  if (state.providerLoads.has(providerId)) {
    return state.providerLoads.get(providerId);
  }
  const loading = fetchVerifiedJson(`providers/${providerId}.json`).then((shard) => {
    if (shard.catalog_version !== state.manifest.catalog_version || shard.provider?.provider_id !== providerId) {
      throw new Error("供应商分片身份或版本不匹配");
    }
    state.providerShards.set(providerId, shard);
    state.providerLoads.delete(providerId);
    return shard;
  }).catch((error) => {
    state.providerLoads.delete(providerId);
    throw error;
  });
  state.providerLoads.set(providerId, loading);
  return loading;
}

function fact(label, value) {
  const wrapper = createElement("div", "fact");
  const term = createElement("dt", "", label);
  const description = createElement("dd", "", value);
  append(wrapper, term, description);
  return wrapper;
}

function section(title) {
  const wrapper = createElement("section", "detail-section");
  wrapper.append(createElement("h3", "", title));
  return wrapper;
}

function factGrid(items) {
  const list = createElement("dl", "facts-grid");
  list.append(...items);
  return list;
}

function protocolMapping(value) {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) {
    return "未知";
  }
  return entries
    .map(([protocol, field]) => `${labels.protocol[protocol] ?? protocol} → ${displayValue(field)}`)
    .join("；");
}

function rangeText(range) {
  if (range === "unknown") {
    return "未知";
  }
  const left = range.minimum_inclusive ? "[" : "(";
  const right = range.maximum_inclusive ? "]" : ")";
  return `${left}${range.minimum}, ${range.maximum}${right}`;
}

function renderIdentity(provider, model, offering, item) {
  const fragment = document.createDocumentFragment();
  const kicker = createElement("p", "detail-kicker");
  append(
    kicker,
    createElement("span", `kind-label ${model.kind}`, labels.kind[model.kind] ?? model.kind),
    lifecycleState(offering.status),
    createElement("code", "", provider.name),
  );
  const titleRow = createElement("div", "detail-title-row");
  const heading = createElement("h2", "", offering.name);
  heading.id = "dialog-title";
  const copy = createElement("button", "copy-button", "复制 API ID");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(offering.api_model_id);
      copy.textContent = "已复制";
      elements.live.textContent = `已复制 ${offering.api_model_id}`;
      window.setTimeout(() => {
        copy.textContent = "复制 API ID";
      }, 1500);
    } catch {
      elements.live.textContent = "浏览器未允许复制，请手动选择 API ID。";
    }
  });
  append(titleRow, heading, copy);

  const identity = section("身份与供应商 Offering");
  identity.append(factGrid([
    fact("API Model ID", offering.api_model_id),
    fact("Canonical ID", offering.canonical_id),
    fact("Offering ID", offering.offering_id),
    fact("供应商", `${provider.name} (${provider.provider_id})`),
    fact("模型系列", model.family),
    fact("别名", item.aliases.length > 0 ? item.aliases.join("、") : "无"),
    fact("国内直连", labels.domesticAccess[String(provider.domestic_access)] ?? "未知"),
    fact("API Key", provider.api_key_required ? "需要" : "不需要"),
    fact("供应商状态", labels.status[provider.status] ?? provider.status),
  ]));
  append(fragment, kicker, titleRow, identity);
  return fragment;
}

function renderProtocolsAndLimits(offering) {
  const protocolSection = section("协议、模态与限额");
  const protocolChips = createElement("div", "chip-row");
  protocolChips.append(...offering.protocols.map((value) => chip(labels.protocol[value] ?? value)));
  const modalityChips = createElement("div", "chip-row");
  modalityChips.append(
    ...offering.modalities.input_modalities.map((value) => chip(`输入 · ${labels.modality[value] ?? value}`)),
    ...offering.modalities.output_modalities.map((value) => chip(`输出 · ${labels.modality[value] ?? value}`)),
  );
  protocolSection.append(
    protocolChips,
    modalityChips,
    factGrid([
      fact("最大上下文 tokens", displayTokens(offering.limits.max_context_tokens)),
      fact("最大输入 tokens", displayTokens(offering.limits.max_input_tokens)),
      fact("最大输出 tokens", displayTokens(offering.limits.max_output_tokens)),
    ]),
  );
  return protocolSection;
}

function renderAgentCapabilities(offering) {
  const capabilitySection = section("Agent 能力（三态）");
  const table = createElement("div", "capability-table");
  for (const [key, value] of Object.entries(offering.capabilities.agent)) {
    const row = createElement("div", "capability-row");
    const name = createElement("span");
    append(name, createElement("span", "", labels.agentCapability[key] ?? key), createElement("br"), createElement("code", "", key));
    append(row, name, triState(value));
    table.append(row);
  }
  capabilitySection.append(table);
  return capabilitySection;
}

function renderReasoning(offering) {
  const reasoning = offering.capabilities.reasoning;
  const reasoningSection = section("推理能力");
  const supported = createElement("div", "capability-row");
  append(supported, createElement("span", "", "reasoning"), triState(reasoning.supported));
  const budget = createElement("div", "capability-row");
  append(budget, createElement("span", "", "budget tokens"), triState(reasoning.budget_tokens));
  const interleaved = createElement("div", "capability-row");
  append(interleaved, createElement("span", "", "interleaved reasoning"), triState(reasoning.interleaved_reasoning));
  const badges = createElement("div", "capability-table");
  append(badges, supported, budget, interleaved);
  reasoningSection.append(
    badges,
    factGrid([
      fact("模式", displayValue(reasoning.modes)),
      fact("Effort 可选值", displayValue(reasoning.effort_values)),
      fact("协议字段映射", protocolMapping(reasoning.protocol_fields)),
    ]),
  );
  return reasoningSection;
}

function renderSampling(offering) {
  const samplingSection = section("采样参数支持（不是运行默认配置）");
  const grid = createElement("div", "parameter-grid");
  for (const [name, capability] of Object.entries(offering.sampling_parameters)) {
    const card = createElement("article", "parameter-card");
    const heading = createElement("h4", "", name);
    append(heading, document.createTextNode(" "), triState(capability.supported));
    append(
      card,
      heading,
      createElement("p", "", `范围：${rangeText(capability.range)}`),
      createElement("p", "", `官方默认：${displayValue(capability.official_default)}`),
      createElement("p", "", `协议映射：${protocolMapping(capability.protocol_mapping)}`),
    );
    grid.append(card);
  }
  samplingSection.append(grid);
  return samplingSection;
}

function renderEmbedding(offering) {
  if (offering.embedding === null) {
    return null;
  }
  const embeddingSection = section("Embedding 能力");
  embeddingSection.append(factGrid([
    fact("默认维度", displayValue(offering.embedding.dimension)),
    fact("可选维度", displayValue(offering.embedding.supported_dimensions)),
    fact("最大输入 tokens", displayTokens(offering.embedding.max_input_tokens)),
    fact("最大批量", displayValue(offering.embedding.max_batch_size)),
  ]));
  return embeddingSection;
}

function renderLifecycle(model, offering) {
  const lifecycleSection = section("生命周期");
  lifecycleSection.append(factGrid([
    fact("Canonical 状态", labels.status[model.lifecycle.status] ?? model.lifecycle.status),
    fact("Offering 状态", labels.status[offering.lifecycle.status] ?? offering.lifecycle.status),
    fact("发布日期", displayDate(offering.lifecycle.release_date)),
    fact("最后更新", displayDate(offering.lifecycle.last_updated)),
    fact("弃用时间", displayDate(offering.lifecycle.deprecated_at)),
    fact("替代项", displayValue(offering.lifecycle.replacement)),
  ]));
  return lifecycleSection;
}

function renderRuntimeAnnotations(offering) {
  const annotations = Object.entries(offering.field_annotations);
  const runtime = annotations.filter(([, value]) => value.runtime_effective).length;
  const metadata = annotations.filter(([, value]) => value.metadata_only).length;
  const unsupported = annotations.filter(([, value]) => !value.runtime_effective && !value.metadata_only).length;
  const annotationSection = section("当前项目运行时契约");
  const summary = createElement("div", "annotation-summary");
  summary.append(createElement(
    "p",
    "",
    `${runtime} 组字段已进入运行时，${metadata} 组仅作元数据，${unsupported} 组仍需适配。每个运行时字段都必须有构造器映射和契约测试。`,
  ));
  const details = createElement("details", "annotation-details");
  details.append(createElement("summary", "", "展开字段级映射"));
  const list = createElement("div", "annotation-list");
  for (const [path, annotation] of annotations) {
    const item = createElement("article", "annotation-item");
    const heading = createElement("h4", "", path);
    const stateLabel = annotation.runtime_effective
      ? "已进入运行时"
      : annotation.metadata_only
        ? "仅元数据"
        : "尚未支持";
    append(
      item,
      heading,
      createElement("p", "", stateLabel),
      createElement("p", "", `Adapter：${displayValue(annotation.adapter_mapping)}`),
      annotation.unsupported_reason === null
        ? null
        : createElement("p", "", `说明：${annotation.unsupported_reason}`),
      createElement("p", "", `来源：${annotation.source_ids.join("、")}`),
    );
    list.append(item);
  }
  append(details, list);
  append(annotationSection, summary, details);
  return annotationSection;
}

function uniqueEvidence(...groups) {
  const values = new Map();
  for (const evidence of groups.flat()) {
    values.set(evidence.source_id, evidence);
  }
  return [...values.values()];
}

function renderEvidence(provider, model, offering) {
  const evidenceSection = section("证据来源");
  const list = createElement("div", "evidence-list");
  for (const evidence of uniqueEvidence(provider.evidence, model.evidence, offering.evidence)) {
    const item = createElement("article", "evidence-item");
    item.append(createElement("h4", "", evidence.source_id));
    if (/^https?:\/\//u.test(evidence.source_url)) {
      const link = createElement("a", "", evidence.source_url);
      link.href = evidence.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
    } else {
      item.append(createElement("p", "api-id", evidence.source_url));
    }
    item.append(createElement("p", "", evidence.notes));
    const meta = createElement("div", "evidence-meta");
    append(
      meta,
      chip(labels.sourceType[evidence.source_type] ?? evidence.source_type),
      chip(`置信度 · ${labels.confidence[evidence.confidence] ?? evidence.confidence}`),
      chip(`核验 · ${displayDate(evidence.verified_at)}`),
      chip(`再分发 · ${evidence.redistribution}`),
    );
    item.append(meta);
    list.append(item);
  }
  evidenceSection.append(list);
  return evidenceSection;
}

function updateDetailUrl(offeringId) {
  const url = new URL(window.location.href);
  if (offeringId === null) {
    url.searchParams.delete("model");
  } else {
    url.searchParams.set("model", offeringId);
  }
  window.history.replaceState(null, "", url);
}

function showDetailError(item, error) {
  const title = createElement("h2", "", item.name);
  title.id = "dialog-title";
  const message = createElement(
    "p",
    "",
    error instanceof Error ? error.message : "模型详情暂时无法读取。",
  );
  const retry = createElement("button", "copy-button", "重试加载");
  retry.type = "button";
  retry.addEventListener("click", () => {
    void openDetail(item, false);
  });
  elements.dialogContent.replaceChildren(title, message, retry);
}

async function openDetail(item, updateUrl = true) {
  const loadingTitle = createElement("h2", "visually-hidden", `${item.name} 详情`);
  loadingTitle.id = "dialog-title";
  const loading = createElement("div", "loading-state detail-loading");
  append(loading, createElement("span", "loading-bar"), createElement("p", "", `正在校验 ${providerName(item)} 分片…`));
  elements.dialogContent.replaceChildren(loadingTitle, loading);
  if (!elements.dialog.open) {
    elements.dialog.showModal();
  }
  if (updateUrl) {
    updateDetailUrl(item.offering_id);
  }
  try {
    const shard = await providerShard(item.provider_id);
    const offering = shard.offerings.find((value) => value.offering_id === item.offering_id);
    const model = shard.models.find((value) => value.canonical_id === item.canonical_id);
    if (offering === undefined || model === undefined) {
      throw new Error("供应商分片中缺少对应的 canonical model 或 offering");
    }
    const content = document.createDocumentFragment();
    append(
      content,
      renderIdentity(shard.provider, model, offering, item),
      renderProtocolsAndLimits(offering),
      renderAgentCapabilities(offering),
      renderReasoning(offering),
      renderSampling(offering),
      renderEmbedding(offering),
      renderLifecycle(model, offering),
      renderRuntimeAnnotations(offering),
      renderEvidence(shard.provider, model, offering),
    );
    elements.dialogContent.replaceChildren(content);
  } catch (error) {
    showDetailError(item, error);
  }
}

elements.filters.addEventListener("submit", (event) => {
  event.preventDefault();
});
elements.filters.addEventListener("input", applyFilters);
elements.filters.addEventListener("reset", () => {
  window.setTimeout(applyFilters, 0);
});
elements.reset.addEventListener("click", resetFilters);
elements.emptyReset.addEventListener("click", resetFilters);
elements.modelsDevSearch.addEventListener("input", applyModelsDevFilters);
elements.modelsDevProvider.addEventListener("change", applyModelsDevFilters);
elements.retry.addEventListener("click", () => {
  void loadCatalog();
});
elements.dialogClose.addEventListener("click", () => {
  elements.dialog.close();
});
elements.dialog.addEventListener("close", () => {
  updateDetailUrl(null);
});
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) {
    elements.dialog.close();
  }
});

void loadCatalog();
