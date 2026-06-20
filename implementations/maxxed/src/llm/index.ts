/** LLM client factory: live AI SDK client or the offline mock. */

import type { Settings } from "../config";
import { AiSdkClient } from "./client";
import { MockLlmClient } from "./mock";
import type { LlmClient } from "./types";

export type { LlmClient } from "./types";
export { MockLlmClient, mockEmbed } from "./mock";

export function buildLlmClient(settings: Settings): LlmClient {
  if (settings.pipeline === "rule") {
    // Offline: hashed mock embeddings + rule-shadow structured outputs.
    return new MockLlmClient();
  }
  return new AiSdkClient(settings);
}
