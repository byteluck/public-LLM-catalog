export type Unknown = "unknown";
export type TriState = boolean | Unknown;
export type Protocol =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "embeddings";
export type Modality = "text" | "image" | "audio" | "video" | "file" | "vector";
export type ModelKind = "chat" | "embedding";

export interface SourceEvidence {
  source_id: string;
  source_url: string;
  source_type:
    | "official_docs"
    | "official_api"
    | "official_model_card"
    | "official_repository"
    | "upstream_aggregator"
    | "project_audit";
  retrieved_at: string;
  verified_at: string;
  confidence: "high" | "medium" | "low" | Unknown;
  redistribution: "allowed" | "attribution_required" | "restricted" | Unknown;
  notes: string;
}

export interface FieldAnnotation {
  runtime_effective: boolean;
  metadata_only: boolean;
  adapter_mapping: string | null;
  unsupported_reason: string | null;
  source_ids: string[];
}

export interface Lifecycle {
  release_date: string | Unknown;
  last_updated: string | Unknown;
  status: "preview" | "active" | "deprecated" | "retired" | Unknown;
  deprecated_at: string | Unknown;
  replacement: string | Unknown;
}

export interface TokenLimits {
  max_context_tokens: number | Unknown;
  max_input_tokens: number | Unknown;
  max_output_tokens: number | Unknown;
}

export interface AgentCapabilities {
  streaming: TriState;
  stream_usage: TriState;
  system_message: TriState;
  tool_call: TriState;
  tool_choice: TriState;
  parallel_tool_calls: TriState;
  strict_tools: TriState;
  structured_output: TriState;
  json_schema: TriState;
}

export interface ReasoningCapabilities {
  supported: TriState;
  modes: Array<"always_on" | "switchable" | "effort" | "budget_tokens" | Unknown>;
  effort_values: Array<
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | Unknown
  >;
  budget_tokens: TriState;
  interleaved_reasoning: TriState;
  protocol_fields: Partial<Record<Protocol, string | Unknown>>;
}

export interface EmbeddingCapabilities {
  dimension: number | Unknown;
  supported_dimensions: number[] | Unknown;
  max_input_tokens: number | Unknown;
  max_batch_size: number | Unknown;
}

export interface Modalities {
  input_modalities: Modality[];
  output_modalities: Modality[];
}

interface AnnotatedDocument {
  $schema: string;
  schema_version: string;
  evidence: SourceEvidence[];
  field_annotations: Record<string, FieldAnnotation>;
}

export interface CanonicalModel extends AnnotatedDocument {
  canonical_id: string;
  manufacturer_id: string;
  name: string;
  family: string;
  aliases: string[];
  kind: ModelKind;
  lifecycle: Lifecycle;
  limits: TokenLimits;
  modalities: Modalities;
  capabilities: {
    agent: AgentCapabilities;
    reasoning: ReasoningCapabilities;
  };
  embedding: EmbeddingCapabilities | null;
}

export interface PublicBaseUrl {
  protocol: Protocol;
  url: string;
  region: string;
}

export interface Provider extends AnnotatedDocument {
  provider_id: string;
  name: string;
  website: string;
  domestic_access: TriState;
  api_key_required: TriState;
  status: "active" | "migration" | "deprecated" | "retired" | Unknown;
  protocols: Protocol[];
  public_base_urls: PublicBaseUrl[];
}

export interface ParameterRange {
  minimum: number;
  maximum: number;
  minimum_inclusive: boolean;
  maximum_inclusive: boolean;
}

export interface ParameterCapability {
  supported: TriState;
  range: ParameterRange | Unknown;
  official_default: number | Unknown;
  protocol_mapping: Partial<Record<Protocol, string | Unknown>>;
}

export interface Offering extends AnnotatedDocument {
  offering_id: string;
  provider_id: string;
  canonical_id: string;
  api_model_id: string;
  name: string;
  status: "preview" | "active" | "deprecated" | "retired" | Unknown;
  lifecycle: Lifecycle;
  protocols: Protocol[];
  limits: TokenLimits;
  modalities: Modalities;
  capabilities: {
    agent: AgentCapabilities;
    reasoning: ReasoningCapabilities;
  };
  sampling_parameters: {
    temperature: ParameterCapability;
    top_p: ParameterCapability;
    top_k: ParameterCapability;
  };
  embedding: EmbeddingCapabilities | null;
}

export interface AliasEntry {
  alias: string;
  provider_id: string | null;
  target_type: "canonical" | "offering" | "alias";
  target_id: string;
}

export interface AliasSet extends AnnotatedDocument {
  alias_set_id: string;
  entries: AliasEntry[];
}

export interface Release {
  $schema: string;
  schema_version: string;
  catalog_version: string;
  generated_at: string;
  previous_catalog_version: string | null;
  minimum_consumer_schema_version: string;
}

export interface SourceCatalog {
  release: Release;
  models: CanonicalModel[];
  providers: Provider[];
  offerings: Offering[];
  aliases: AliasSet[];
}

export interface AggregatedCatalog {
  schema_version: string;
  catalog_version: string;
  generated_at: string;
  models: CanonicalModel[];
  providers: Provider[];
  offerings: Offering[];
  aliases: AliasSet[];
}

export type ModelsDevLogoStatus = "dedicated" | "mapped" | "fallback";

export interface ModelsDevCandidateProvider {
  provider_id: string;
  name: string;
  logo_path: string;
  logo_source_url: string;
  logo_status: ModelsDevLogoStatus;
  logo_source_provider_id: string;
}

export interface ModelsDevCandidate {
  candidate_id: string;
  provider_id: string;
  api_model_id: string;
  canonical_slug: string;
  name: string;
  models_dev_created_at: string;
  route_kind: "direct" | "free" | "router" | "alias";
  verification_status: "unverified";
  input_modalities: Modality[];
  output_modalities: Modality[];
  context_length: number | Unknown;
  max_output_tokens: number | Unknown;
  supported_parameters: string[];
  source_url: string;
}

export interface ModelsDevCandidates {
  $schema: string;
  schema_version: string;
  source: {
    source_id: string;
    source_url: string;
    retrieved_at: string;
    source_revision: string;
  };
  filter: {
    field: "created";
    since: string;
    comparison: ">=";
    semantics: "models.dev catalog created timestamp; not an official release-date assertion";
  };
  providers: ModelsDevCandidateProvider[];
  models: ModelsDevCandidate[];
}

export interface EncodingDescriptor {
  path: string;
  immutable_path: string;
  size: number;
  sha256: string;
}

export type StaticContentType =
  | "application/json; charset=utf-8"
  | "text/html; charset=utf-8"
  | "text/css; charset=utf-8"
  | "text/javascript; charset=utf-8"
  | "image/svg+xml; charset=utf-8";

export interface ManifestFile {
  path: string;
  immutable_path: string;
  size: number;
  sha256: string;
  etag: string;
  cache_control: string;
  immutable_cache_control: string;
  content_type: StaticContentType;
  encodings: {
    gzip: EncodingDescriptor;
    br: EncodingDescriptor;
  };
}

export interface Manifest {
  schema_version: string;
  catalog_version: string;
  generated_at: string;
  previous_catalog_version: string | null;
  minimum_consumer_schema_version: string;
  immutable_base_path: string;
  files: ManifestFile[];
}

export interface ValidationIssue {
  code: string;
  file: string;
  path: string;
  message: string;
}
