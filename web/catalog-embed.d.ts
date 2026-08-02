export const CATALOG_EMBED_CHANNEL: "com.baiteda.public-llm-catalog";
export const CATALOG_EMBED_PROTOCOL_VERSION: 1;

export interface CatalogEmbedContext {
  parentOrigin: string;
  sessionId: string;
}

export interface CatalogEmbedMessage {
  channel: typeof CATALOG_EMBED_CHANNEL;
  protocol_version: typeof CATALOG_EMBED_PROTOCOL_VERSION;
  session_id: string;
  type: "catalog.ready" | "catalog.selection" | "catalog.error";
  payload: Record<string, unknown>;
}

export function resolveCatalogEmbedContext(
  locationHref: string,
  referrer?: string,
): CatalogEmbedContext | null;

export function createCatalogReadyMessage(
  context: CatalogEmbedContext,
  manifest: Record<string, unknown>,
  offeringCount: number,
): CatalogEmbedMessage;

export function createCatalogErrorMessage(
  context: CatalogEmbedContext,
  code: string,
  message: string,
): CatalogEmbedMessage;

export function createCatalogSelectionMessage(
  context: CatalogEmbedContext,
  input: Record<string, unknown>,
): CatalogEmbedMessage;
