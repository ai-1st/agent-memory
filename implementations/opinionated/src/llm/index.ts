/**
 * LLM provider factory — the single place that decides live vs mock.
 *
 * Tests construct the app with the mock provider so they run fully offline.
 * Production uses the live Anthropic + OpenAI provider via the Vercel AI SDK.
 */

import type { Settings } from "../config";
import { createLiveProvider } from "./live";
import { createMockProvider } from "./mock";
import type { LLMProvider } from "./provider";

export type { LLMProvider } from "./provider";

export function buildProvider(settings: Settings): LLMProvider {
  if (settings.llmMode === "mock") return createMockProvider();
  return createLiveProvider(settings);
}
