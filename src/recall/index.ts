/** Recaller factory — selects the pipeline from settings. */

import type { Settings } from "../config";
import type { Store } from "../store";
import { BaselineRecaller } from "./baseline";
import type { Recaller } from "./types";

export type { Recaller, RecallResult } from "./types";

export function buildRecaller(_settings: Settings, store: Store): Recaller {
  // Future variants (hybrid, embeddings + rerank, graph) register here and are
  // selected by MEMORY_RECALLER on the exploration branches.
  return new BaselineRecaller(store);
}
