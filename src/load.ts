import { join } from "node:path";

import { listFiles } from "./files.js";
import { readJson } from "./json.js";
import type {
  AliasSet,
  CanonicalModel,
  Offering,
  Provider,
  Release,
  SourceCatalog,
} from "./types.js";

async function readCollection<T>(directory: string): Promise<T[]> {
  const files = await listFiles(directory);
  return Promise.all(files.map(async (file) => readJson<T>(file)));
}

export async function loadSourceCatalog(root: string): Promise<SourceCatalog> {
  const catalogRoot = join(root, "catalog");
  const [release, models, providers, offerings, aliases] = await Promise.all([
    readJson<Release>(join(catalogRoot, "release.json")),
    readCollection<CanonicalModel>(join(catalogRoot, "models")),
    readCollection<Provider>(join(catalogRoot, "providers")),
    readCollection<Offering>(join(catalogRoot, "offerings")),
    readCollection<AliasSet>(join(catalogRoot, "aliases")),
  ]);
  return { release, models, providers, offerings, aliases };
}
