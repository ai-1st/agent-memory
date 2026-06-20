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

// Chunked extraction (experimental, env-gated MEMORY_CHUNK_EXTRACT=1): for long
// multi-message turns, extract from each focused chunk AND the whole turn, then
// merge + dedup the candidate facts. A focused window surfaces one-off details a
// single 20-message pass drops — the dominant LoCoMo coverage residual. Off by
// default → the build is unchanged. Dedup is also handled downstream by per-fact
// reconcile (REINFORCE), so this only trims exact dupes before the fan-out.
const CHUNK_EXTRACT = /^(1|true|on)$/i.test(process.env.MEMORY_CHUNK_EXTRACT ?? "");
const CHUNK_SIZE = 6; // messages per focused chunk
const CHUNK_MIN_MESSAGES = 8; // only chunk turns larger than this
const DEDUP_COSINE = 0.94; // candidates at least this similar are the same fact

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

  /** One whole-turn extraction pass. */
  private async extractPass(text: string, timestamp: string | null): Promise<ExtractedFact[]> {
    try {
      const res = await this.llm.generate({
        schema: extractionSchema,
        system: EXTRACT_SYSTEM,
        prompt: extractPrompt(text, timestamp),
        task: "extract",
      });
      return res.facts;
    } catch {
      return [];
    }
  }

  /**
   * Extract candidate facts. Always runs the whole-turn pass. When chunked
   * extraction is enabled and the turn is long, ALSO runs a focused pass over
   * each chunk of messages (a small window surfaces one-off details a single
   * long pass drops), then merges + dedups by key+value before the reconcile
   * fan-out.
   */
  private async extractFacts(
    messages: Array<{ role: string; content: string; name?: string | null }>,
    turnText: string,
    timestamp: string | null,
  ): Promise<ExtractedFact[]> {
    const passes: Array<Promise<ExtractedFact[]>> = [this.extractPass(turnText, timestamp)];
    if (CHUNK_EXTRACT && messages.length >= CHUNK_MIN_MESSAGES) {
      for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
        const text = IngestPipeline.turnText(messages.slice(i, i + CHUNK_SIZE));
        if (text) passes.push(this.extractPass(text, timestamp));
      }
    }
    const all = (await Promise.all(passes)).flat().filter((f) => f.value.trim().length > 0);
    const seen = new Set<string>();
    const out: ExtractedFact[] = [];
    for (const f of all) {
      const sig = `${f.key.trim().toLowerCase()}::${f.value.trim().toLowerCase()}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(f);
    }
    return out;
  }

  async run(
    messages: Array<{ role: string; content: string; name?: string | null }>,
    ctx: IngestContext,
  ): Promise<IngestResult> {
    const turnText = IngestPipeline.turnText(messages);
    if (!turnText) return { extracted: 0, operations: [] };

    // Stage 2: extract context-enriched facts (optionally chunked for coverage).
    const rawFacts = await this.extractFacts(messages, turnText, ctx.timestamp);
    if (rawFacts.length === 0) return { extracted: 0, operations: [] };

    // Stage 3a: embed candidates. With chunked extraction the same concept can
    // arrive under slightly different keys from different passes, so we semantic-
    // dedup the candidates here (using the embeddings we already need) BEFORE the
    // reconcile fan-out — otherwise within-turn parallel reconcile would ADD both
    // copies (each sees the slot empty). No-op for the single-pass default.
    const rawEmbeddings = await this.llm.embed(
      rawFacts.map((f) => `${f.key}: ${f.value}`),
      "embed_memory",
    );
    const { facts, embeddings } = dedupeByEmbedding(rawFacts, rawEmbeddings);

    // Stage 3b: per-fact, in parallel — search + reconcile.
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
      const [emb] = await this.llm.embed([`${key}: ${value}`], "embed_memory");
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

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Drop candidate facts whose embedding is near-identical (>= DEDUP_COSINE) to an
 * already-kept candidate — chunked extraction re-emits the same concept under
 * slightly different keys across passes. Keeps the first occurrence and returns
 * facts with their aligned embeddings. A no-op for single-pass extraction.
 */
function dedupeByEmbedding(
  facts: ExtractedFact[],
  embeddings: number[][],
): { facts: ExtractedFact[]; embeddings: number[][] } {
  const keptF: ExtractedFact[] = [];
  const keptE: number[][] = [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (!f) continue;
    const emb = embeddings[i] ?? [];
    let dup = false;
    if (emb.length > 0) {
      for (const e of keptE) {
        if (cosine(emb, e) >= DEDUP_COSINE) {
          dup = true;
          break;
        }
      }
    }
    if (dup) continue;
    keptF.push(f);
    keptE.push(emb);
  }
  return { facts: keptF, embeddings: keptE };
}
