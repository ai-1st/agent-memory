/**
 * Synchronous ingestion pipeline (POST /turns) — the opinionated core.
 *
 * Everything below happens BEFORE the HTTP response returns. There is no
 * background/sleep/consolidation phase.
 *
 *   1. Persist the raw turn verbatim (already done by the caller) — source of
 *      truth we can cite.
 *   2. Extract context-enriched, self-contained facts (generateObject + Zod).
 *   3. For EACH fact, IN PARALLEL:
 *        a. embed it and semantic-search the store for similar existing facts;
 *        b. ask the LLM (generateObject) for a structured list of operations
 *           (ADD/UPDATE/REINFORCE/CONTRADICT/NOOP) given the fact + neighbours;
 *        c. apply those operations.
 *   4. Contradictions are LINKED (two-way), never deleted.
 *
 * Note on within-turn ordering: facts from the same turn are reconciled against
 * the store state as of turn-start. To avoid two facts in one turn racing on the
 * same slot, we apply operations serially after computing them in parallel; the
 * heavy LLM/embedding work is the part that runs concurrently.
 */

import type { LLMProvider } from "../llm/provider";
import type { Store } from "../store";
import { EXTRACT_SYSTEM, RECONCILE_SYSTEM, extractPrompt, reconcilePrompt } from "./prompts";
import { type ExtractedFact, type ReconcileOp, extractionSchema, reconcileSchema } from "./schemas";

const SIMILAR_LIMIT = 6;

export interface IngestContext {
  userId: string | null;
  sessionId: string;
  turnId: string;
  timestamp: string | null;
}

export interface IngestResult {
  extracted: number;
  operations: ReconcileOp[];
}

interface PlannedFact {
  fact: ExtractedFact;
  embedding: number[];
  ops: ReconcileOp[];
}

export class IngestPipeline {
  constructor(
    private llm: LLMProvider,
    private store: Store,
  ) {}

  /** Build the verbatim text the extractor sees from the raw messages. */
  static turnText(
    messages: Array<{ role: string; content: string; name?: string | null }>,
  ): string {
    return messages
      .map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${m.content}`.trim())
      .join("\n")
      .trim();
  }

  async run(
    messages: Array<{ role: string; content: string; name?: string | null }>,
    ctx: IngestContext,
  ): Promise<IngestResult> {
    const turnText = IngestPipeline.turnText(messages);
    if (!turnText) return { extracted: 0, operations: [] };

    // Stage 2: extract context-enriched facts.
    const extraction = await this.llm.generate({
      schema: extractionSchema,
      system: EXTRACT_SYSTEM,
      prompt: extractPrompt(turnText, ctx.timestamp),
      task: "extract",
    });
    const facts = extraction.facts.filter((f) => f.value.trim().length > 0);
    if (facts.length === 0) return { extracted: 0, operations: [] };

    // Stage 3a/3b: per-fact, in parallel — embed, search, reconcile.
    const embeddings = await this.llm.embed(facts.map((f) => `${f.key}: ${f.value}`));
    const planned: PlannedFact[] = await Promise.all(
      facts.map(async (fact, i) => {
        const embedding = embeddings[i] ?? [];
        const similar = await this.store.similarMemories({
          userId: ctx.userId,
          embedding,
          limit: SIMILAR_LIMIT,
          activeOnly: true,
        });
        const reconcile = await this.llm.generate({
          schema: reconcileSchema,
          system: RECONCILE_SYSTEM,
          prompt: reconcilePrompt(
            fact,
            similar.map((s) => ({
              id: s.id,
              type: s.type,
              key: s.key,
              value: s.value,
              similarity: s.similarity,
            })),
          ),
          task: "reconcile",
        });
        return { fact, embedding, ops: reconcile.operations };
      }),
    );

    // Stage 3c: apply operations serially (writes are cheap; avoids slot races).
    const applied: ReconcileOp[] = [];
    for (const p of planned) {
      for (const op of p.ops) {
        await this.apply(op, p, ctx);
        applied.push(op);
      }
    }

    return { extracted: facts.length, operations: applied };
  }

  private async apply(op: ReconcileOp, p: PlannedFact, ctx: IngestContext): Promise<void> {
    const value = op.value.trim() || p.fact.value;
    const key = op.key.trim() || p.fact.key;
    const type = op.type || p.fact.type;
    const confidence = op.confidence || p.fact.confidence;

    switch (op.op) {
      case "NOOP":
        return;

      case "REINFORCE": {
        for (const id of op.target_ids) await this.store.reinforce(id, confidence);
        if (op.target_ids.length === 0) {
          await this.insert(value, key, type, confidence, p, ctx, null, true);
        }
        return;
      }

      case "UPDATE": {
        for (const id of op.target_ids) await this.store.supersede(id);
        await this.insert(value, key, type, confidence, p, ctx, op.target_ids[0] ?? null, true);
        return;
      }

      case "CONTRADICT": {
        // Keep BOTH sides: new fact active, old facts stay active, two-way link.
        const newId = await this.insert(value, key, type, confidence, p, ctx, null, true);
        for (const id of op.target_ids) {
          await this.store.linkMemories(
            newId,
            id,
            "contradiction",
            op.reason || "user reversed or changed this",
          );
        }
        return;
      }

      default: {
        // ADD
        await this.insert(value, key, type, confidence, p, ctx, null, true);
        return;
      }
    }
  }

  private async insert(
    value: string,
    key: string,
    type: string,
    confidence: number,
    p: PlannedFact,
    ctx: IngestContext,
    supersedes: string | null,
    active: boolean,
  ): Promise<string> {
    // Re-embed only if the stored value differs from the extracted phrasing.
    let embedding = p.embedding;
    if (value !== p.fact.value) {
      const [emb] = await this.llm.embed([`${key}: ${value}`]);
      embedding = emb ?? p.embedding;
    }
    return this.store.insertMemory({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      sourceTurn: ctx.turnId,
      type,
      key,
      value,
      confidence,
      embedding,
      supersedes,
      active,
    });
  }
}
