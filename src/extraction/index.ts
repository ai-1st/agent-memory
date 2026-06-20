/** Extractor factory — selects the pipeline from settings. */

import type { Settings } from "../config";
import { BaselineExtractor } from "./baseline";
import type { Extractor } from "./types";

export type { Extractor, ExtractedMemory } from "./types";

export function buildExtractor(_settings: Settings): Extractor {
  // The control branch ships only the baseline. Exploration branches register
  // an "llm" extractor (Vercel AI SDK + Opus) and select it via MEMORY_EXTRACTOR.
  return new BaselineExtractor();
}
