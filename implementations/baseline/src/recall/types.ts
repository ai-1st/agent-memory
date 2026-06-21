/** Recall interface: assemble budget-bounded prose context + citations. */

import type { Citation } from "../models";

export interface RecallResult {
  context: string;
  citations: Citation[];
}

export interface RecallArgs {
  query: string;
  userId: string | null;
  sessionId: string | null;
  maxTokens: number;
}

export interface Recaller {
  name: string;
  recall(args: RecallArgs): RecallResult;
}
