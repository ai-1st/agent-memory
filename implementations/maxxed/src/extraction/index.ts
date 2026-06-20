/** Extractor factory. */

import type { LlmClient } from "../llm/types";
import type { Store } from "../store";
import { Extractor } from "./extractor";

export { Extractor } from "./extractor";
export type { AppliedMemory } from "./extractor";
export type { ExtractContext, ExtractedMemory } from "./types";

export function buildExtractor(store: Store, llm: LlmClient): Extractor {
  return new Extractor(store, llm);
}
