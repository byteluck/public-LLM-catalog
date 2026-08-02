import type { Offering, Protocol, TriState } from "./types.js";

export type SamplingParameterName = "temperature" | "top_p" | "top_k";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GenerationSettings {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_output_tokens?: number;
  streaming?: boolean;
  stream_usage?: boolean;
  reasoning_effort?: ReasoningEffort;
}

export interface GenerationLayers {
  systemDefault?: GenerationSettings;
  tenantDeploymentOverride?: GenerationSettings;
  agentPolicy?: GenerationSettings;
}

export interface RuntimeDiagnostic {
  code:
    | "unsupported_parameter"
    | "unknown_parameter_support"
    | "missing_protocol_mapping"
    | "out_of_range"
    | "unsupported_capability"
    | "unknown_capability"
    | "unsupported_reasoning_effort";
  field: string;
  message: string;
}

export interface FilteredParameters {
  logical: GenerationSettings;
  protocol: Record<string, boolean | number | string>;
  diagnostics: RuntimeDiagnostic[];
}

export interface TenantDeploymentRuntime {
  apiKey: string;
  baseUrl: string;
  apiModelId?: string;
  maxInputTokensOverride?: number;
}

export interface ChatRuntimePlan {
  adapter: "ChatOpenAI" | "ChatAnthropic";
  constructorOptions: Record<string, unknown>;
  callOptions: Record<string, unknown>;
  deepAgentProfile: { maxInputTokens: number };
  diagnostics: RuntimeDiagnostic[];
}

export interface EmbeddingRuntimePlan {
  adapter: "OpenAIEmbeddings";
  constructorOptions: Record<string, unknown>;
}

export function mergeGenerationSettings(layers: GenerationLayers): GenerationSettings {
  return {
    ...layers.systemDefault,
    ...layers.tenantDeploymentOverride,
    ...layers.agentPolicy,
  };
}

function triStateDiagnostic(
  value: TriState,
  field: string,
  unsupportedMessage: string,
): RuntimeDiagnostic | null {
  if (value === true) {
    return null;
  }
  if (value === false) {
    return {
      code: "unsupported_capability",
      field,
      message: unsupportedMessage,
    };
  }
  return {
    code: "unknown_capability",
    field,
    message: `${field} 的供应商支持状态为 unknown，已按安全默认值省略`,
  };
}

function inRange(
  value: number,
  range: {
    minimum: number;
    maximum: number;
    minimum_inclusive: boolean;
    maximum_inclusive: boolean;
  },
): boolean {
  const aboveMinimum = range.minimum_inclusive ? value >= range.minimum : value > range.minimum;
  const belowMaximum = range.maximum_inclusive ? value <= range.maximum : value < range.maximum;
  return aboveMinimum && belowMaximum;
}

export function filterGenerationSettings(
  offering: Offering,
  protocol: Protocol,
  layers: GenerationLayers,
): FilteredParameters {
  if (!offering.protocols.includes(protocol)) {
    throw new Error(`offering ${offering.offering_id} 不支持协议 ${protocol}`);
  }
  const merged = mergeGenerationSettings(layers);
  const logical: GenerationSettings = {};
  const protocolParameters: Record<string, boolean | number | string> = {};
  const diagnostics: RuntimeDiagnostic[] = [];

  for (const name of ["temperature", "top_p", "top_k"] as const) {
    const value = merged[name];
    if (value === undefined) {
      continue;
    }
    const capability = offering.sampling_parameters[name];
    if (capability.supported !== true) {
      diagnostics.push({
        code: capability.supported === false ? "unsupported_parameter" : "unknown_parameter_support",
        field: name,
        message:
          capability.supported === false
            ? `${name} 已由供应商明确标记为不支持，未发送`
            : `${name} 支持状态为 unknown，按安全默认值未发送`,
      });
      continue;
    }
    if (capability.range !== "unknown" && !inRange(value, capability.range)) {
      diagnostics.push({
        code: "out_of_range",
        field: name,
        message: `${name}=${value} 超出供应商声明范围，未发送`,
      });
      continue;
    }
    const mapping = capability.protocol_mapping[protocol];
    if (mapping === undefined || mapping === "unknown") {
      diagnostics.push({
        code: "missing_protocol_mapping",
        field: name,
        message: `${name} 缺少 ${protocol} 协议映射，未发送`,
      });
      continue;
    }
    logical[name] = value;
    protocolParameters[mapping] = value;
  }

  if (merged.max_output_tokens !== undefined) {
    const limit = offering.limits.max_output_tokens;
    if (
      !Number.isInteger(merged.max_output_tokens) ||
      merged.max_output_tokens <= 0 ||
      (typeof limit === "number" && merged.max_output_tokens > limit)
    ) {
      diagnostics.push({
        code: "out_of_range",
        field: "max_output_tokens",
        message: `max_output_tokens=${merged.max_output_tokens} 不是正整数或超过 offering 上限 ${limit}，未发送`,
      });
    } else {
      logical.max_output_tokens = merged.max_output_tokens;
      protocolParameters.max_tokens = merged.max_output_tokens;
    }
  }

  for (const [setting, capabilityName, protocolName] of [
    ["streaming", "streaming", "stream"],
    ["stream_usage", "stream_usage", "stream_options.include_usage"],
  ] as const) {
    const value = merged[setting];
    if (value === undefined) {
      continue;
    }
    const diagnostic = triStateDiagnostic(
      offering.capabilities.agent[capabilityName],
      setting,
      `${setting} 已由供应商明确标记为不支持，未发送`,
    );
    if (diagnostic !== null) {
      diagnostics.push(diagnostic);
      continue;
    }
    logical[setting] = value;
    protocolParameters[protocolName] = value;
  }

  if (merged.reasoning_effort !== undefined) {
    if (offering.capabilities.reasoning.supported !== true) {
      diagnostics.push({
        code:
          offering.capabilities.reasoning.supported === false
            ? "unsupported_capability"
            : "unknown_capability",
        field: "reasoning_effort",
        message: "reasoning 支持状态不是 true，reasoning_effort 未发送",
      });
    } else if (!offering.capabilities.reasoning.effort_values.includes(merged.reasoning_effort)) {
      diagnostics.push({
        code: "unsupported_reasoning_effort",
        field: "reasoning_effort",
        message: `reasoning_effort=${merged.reasoning_effort} 不在 offering 可选值中，未发送`,
      });
    } else {
      const mapping = offering.capabilities.reasoning.protocol_fields[protocol];
      if (mapping === undefined || mapping === "unknown") {
        diagnostics.push({
          code: "missing_protocol_mapping",
          field: "reasoning_effort",
          message: `reasoning_effort 缺少 ${protocol} 协议映射，未发送`,
        });
      } else {
        logical.reasoning_effort = merged.reasoning_effort;
        protocolParameters[mapping] = merged.reasoning_effort;
      }
    }
  }

  return { logical, protocol: protocolParameters, diagnostics };
}

export function resolveMaxInputTokens(
  offering: Offering,
  deployment: TenantDeploymentRuntime,
): number {
  const value = deployment.maxInputTokensOverride ?? offering.limits.max_input_tokens;
  if (value === "unknown") {
    throw new Error(
      `MAX_INPUT_TOKENS_UNKNOWN: ${offering.offering_id} 缺少可靠 max_input_tokens；不得用 max_context_tokens 代替`,
    );
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`MAX_INPUT_TOKENS_INVALID: ${value}`);
  }
  return value;
}

function mappedConstructorSampling(
  filtered: FilteredParameters,
  adapter: "ChatOpenAI" | "ChatAnthropic",
  offering: Offering,
  protocol: Protocol,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const modelKwargs: Record<string, number> = {};
  for (const [name, constructorName, standardProtocolName] of [
    ["temperature", "temperature", "temperature"],
    ["top_p", "topP", "top_p"],
    ["top_k", "topK", "top_k"],
  ] as const) {
    const value = filtered.logical[name];
    if (value === undefined) {
      continue;
    }
    const mapping = offering.sampling_parameters[name].protocol_mapping[protocol];
    if (mapping === undefined || mapping === "unknown") {
      throw new Error(`INTERNAL_MAPPING_ERROR: ${name} 已过滤通过但没有协议映射`);
    }
    if (mapping === standardProtocolName && (name !== "top_k" || adapter === "ChatAnthropic")) {
      result[constructorName] = value;
    } else {
      modelKwargs[mapping] = value;
    }
  }
  if (Object.keys(modelKwargs).length > 0) {
    result.modelKwargs = modelKwargs;
  }
  return result;
}

export function buildChatRuntimePlan(input: {
  offering: Offering;
  protocol: Exclude<Protocol, "embeddings">;
  deployment: TenantDeploymentRuntime;
  generationLayers: GenerationLayers;
}): ChatRuntimePlan {
  const { offering, protocol, deployment, generationLayers } = input;
  const filtered = filterGenerationSettings(offering, protocol, generationLayers);
  const model = deployment.apiModelId ?? offering.api_model_id;
  const maxInputTokens = resolveMaxInputTokens(offering, deployment);
  const constructorOptions: Record<string, unknown> = {
    model,
    apiKey: deployment.apiKey,
    ...mappedConstructorSampling(
      filtered,
      protocol === "anthropic_messages" ? "ChatAnthropic" : "ChatOpenAI",
      offering,
      protocol,
    ),
  };
  if (filtered.logical.max_output_tokens !== undefined) {
    constructorOptions.maxTokens = filtered.logical.max_output_tokens;
  }
  if (filtered.logical.streaming !== undefined) {
    constructorOptions.streaming = filtered.logical.streaming;
  }
  if (filtered.logical.stream_usage !== undefined) {
    constructorOptions.streamUsage = filtered.logical.stream_usage;
  }

  if (protocol === "anthropic_messages") {
    constructorOptions.anthropicApiUrl = deployment.baseUrl;
    if (filtered.logical.reasoning_effort !== undefined) {
      constructorOptions.outputConfig = { effort: filtered.logical.reasoning_effort };
    }
    return {
      adapter: "ChatAnthropic",
      constructorOptions,
      callOptions: {},
      deepAgentProfile: { maxInputTokens },
      diagnostics: filtered.diagnostics,
    };
  }

  constructorOptions.configuration = { baseURL: deployment.baseUrl };
  constructorOptions.useResponsesApi = protocol === "openai_responses";
  if (offering.capabilities.agent.strict_tools === true) {
    constructorOptions.supportsStrictToolCalling = true;
  }
  if (filtered.logical.reasoning_effort !== undefined) {
    constructorOptions.reasoning = { effort: filtered.logical.reasoning_effort };
  }
  return {
    adapter: "ChatOpenAI",
    constructorOptions,
    callOptions: {},
    deepAgentProfile: { maxInputTokens },
    diagnostics: filtered.diagnostics,
  };
}

export function buildEmbeddingRuntimePlan(input: {
  offering: Offering;
  deployment: TenantDeploymentRuntime;
  dimension?: number;
  batchSize?: number;
}): EmbeddingRuntimePlan {
  const { offering, deployment, dimension, batchSize } = input;
  if (!offering.protocols.includes("embeddings") || offering.embedding === null) {
    throw new Error(`offering ${offering.offering_id} 不是 Embedding offering`);
  }
  if (dimension !== undefined && (!Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error(`Embedding dimension ${dimension} 必须为正整数`);
  }
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize <= 0)) {
    throw new Error(`Embedding batchSize ${batchSize} 必须为正整数`);
  }
  if (
    dimension !== undefined &&
    offering.embedding.supported_dimensions !== "unknown" &&
    !offering.embedding.supported_dimensions.includes(dimension)
  ) {
    throw new Error(`Embedding dimension ${dimension} 不受 ${offering.offering_id} 支持`);
  }
  if (
    batchSize !== undefined &&
    typeof offering.embedding.max_batch_size === "number" &&
    batchSize > offering.embedding.max_batch_size
  ) {
    throw new Error(`Embedding batchSize ${batchSize} 超过上限 ${offering.embedding.max_batch_size}`);
  }
  return {
    adapter: "OpenAIEmbeddings",
    constructorOptions: {
      model: deployment.apiModelId ?? offering.api_model_id,
      apiKey: deployment.apiKey,
      configuration: { baseURL: deployment.baseUrl },
      ...(dimension === undefined ? {} : { dimensions: dimension }),
      ...(batchSize === undefined ? {} : { batchSize }),
    },
  };
}

export function selectDeploymentOffering(input: {
  offerings: Offering[];
  providerId: string;
  apiModelId: string;
  publicOfferingOverride?: string;
}): Offering {
  const exact = input.offerings.find(
    (offering) =>
      offering.provider_id === input.providerId && offering.api_model_id === input.apiModelId,
  );
  if (exact !== undefined) {
    return exact;
  }
  if (input.publicOfferingOverride === undefined) {
    throw new Error(
      `私有模型标识 ${input.providerId}/${input.apiModelId} 未命中公开 offering，必须显式提供 publicOfferingOverride`,
    );
  }
  const overridden = input.offerings.find(
    (offering) => offering.offering_id === input.publicOfferingOverride,
  );
  if (overridden === undefined) {
    throw new Error(`publicOfferingOverride 不存在: ${input.publicOfferingOverride}`);
  }
  return overridden;
}
