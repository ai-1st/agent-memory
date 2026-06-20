/** Recaller factory. */

import type { LlmClient } from "../llm/types";
import type { Store } from "../store";
import { HybridRecaller } from "./recaller";
import type { Recaller } from "./types";

export { HybridRecaller } from "./recaller";
export type { Recaller, RecallResult } from "./types";

export function buildRecaller(store: Store, llm: LlmClient): Recaller {
  return new HybridRecaller(store, llm);
}
