export const CATALOG_EMBED_CHANNEL = "com.baiteda.public-llm-catalog";
export const CATALOG_EMBED_PROTOCOL_VERSION = 1;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const AGENT_CAPABILITY_KEYS = [
  "streaming",
  "stream_usage",
  "system_message",
  "tool_call",
  "tool_choice",
  "parallel_tool_calls",
  "strict_tools",
  "structured_output",
  "json_schema",
];

function httpOrigin(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveCatalogEmbedContext(locationHref, referrer = "") {
  const location = new URL(locationHref);
  if (location.searchParams.get("embed") !== "picker") {
    return null;
  }
  if (location.searchParams.get("protocol_version") !== String(CATALOG_EMBED_PROTOCOL_VERSION)) {
    return null;
  }
  const parentOrigin = httpOrigin(location.searchParams.get("parent_origin"));
  const sessionId = location.searchParams.get("session_id");
  if (parentOrigin === null || sessionId === null || !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  if (referrer !== "") {
    try {
      if (new URL(referrer).origin !== parentOrigin) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return { parentOrigin, sessionId };
}

function envelope(context, type, payload) {
  return {
    channel: CATALOG_EMBED_CHANNEL,
    protocol_version: CATALOG_EMBED_PROTOCOL_VERSION,
    session_id: context.sessionId,
    type,
    payload,
  };
}

export function createCatalogReadyMessage(context, manifest, offeringCount) {
  return envelope(context, "catalog.ready", {
    schema_version: manifest.schema_version,
    catalog_version: manifest.catalog_version,
    generated_at: manifest.generated_at,
    offering_count: offeringCount,
  });
}
export function createCatalogErrorMessage(context, code, message) {
  return envelope(context, "catalog.error", {
    code,
    message,
  });
}

function copyAgentCapabilities(agent) {
  return Object.fromEntries(AGENT_CAPABILITY_KEYS.map((key) => [key, agent[key]]));
}

function copyEmbedding(embedding) {
  if (embedding === null) {
    return null;
  }
  return {
    dimension: embedding.dimension,
    supported_dimensions:
      embedding.supported_dimensions === "unknown"
        ? "unknown"
        : [...embedding.supported_dimensions],
    max_input_tokens: embedding.max_input_tokens,
    max_batch_size: embedding.max_batch_size,
  };
}

export function createCatalogSelectionMessage(context, input) {
  const { descriptor, item, manifest, model, offering, provider } = input;
  return envelope(context, "catalog.selection", {
    schema_version: manifest.schema_version,
    catalog_version: manifest.catalog_version,
    generated_at: manifest.generated_at,
    provider_id: provider.provider_id,
    provider_name: provider.name,
    canonical_id: model.canonical_id,
    offering_id: offering.offering_id,
    api_model_id: offering.api_model_id,
    name: offering.name,
    kind: model.kind,
    family: model.family,
    status: offering.status,
    verification_status: item.verification_status,
    protocols: offering.protocols === "unknown" ? "unknown" : [...offering.protocols],
    input_modalities: [...offering.modalities.input_modalities],
    output_modalities: [...offering.modalities.output_modalities],
    limits: { ...offering.limits },
    capabilities: {
      agent: copyAgentCapabilities(offering.capabilities.agent),
      reasoning: {
        supported: offering.capabilities.reasoning.supported,
        modes: [...offering.capabilities.reasoning.modes],
        effort_values: [...offering.capabilities.reasoning.effort_values],
        budget_tokens: offering.capabilities.reasoning.budget_tokens,
        interleaved_reasoning: offering.capabilities.reasoning.interleaved_reasoning,
      },
    },
    embedding: copyEmbedding(offering.embedding),
    provider_shard: {
      path: descriptor.path,
      sha256: descriptor.sha256,
    },
  });
}
