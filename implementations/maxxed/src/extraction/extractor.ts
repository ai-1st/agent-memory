/**
 * The extract -> reconcile loop (the POST /turns core), à la mem0 / LangMem.
 *
 * For each turn:
 *   1. EXTRACT candidate memories from the user's messages (LLM generateObject,
 *      or the rule shadow offline).
 *   2. For each candidate, RETRIEVE the existing memories in the same slot and
 *      ask the LLM for a structured DECISION: ADD / UPDATE / SUPERSEDE / NOOP.
 *   3. APPLY the decision against the store with full fact-evolution semantics
 *      (supersede keeps history; the audit ledger records every decision).
 *   4. LINK the new memory into the entity graph (shared-entity edges) so
 *      multi-hop recall can do one-hop expansion.
 *
 * Embeddings for each written memory are computed here so recall's vector search
 * has dense vectors immediately (synchronous correctness).
 */

import type { LlmClient } from "../llm/types";
import type { Message } from "../models";
import type { Store } from "../store";
import type { MemoryWrite } from "../store/types";
import {
  EXTRACT_SYSTEM,
  RECONCILE_SYSTEM,
  buildExtractPrompt,
  buildReconcilePrompt,
} from "./prompts";
import { ruleExtract } from "./rules";
import {
  type CandidateMemory,
  type ReconcileDecision,
  extractionResultSchema,
  reconcileDecisionSchema,
} from "./schemas";
import type { ExtractContext } from "./types";

const IMPORTANCE_BY_TYPE: Record<string, number> = {
  fact: 0.8,
  preference: 0.6,
  opinion: 0.5,
  event: 0.4,
};

export interface AppliedMemory {
  id: string;
  decision: string;
  key: string;
  value: string;
  entities: string[];
}

export class Extractor {
  name = "llm-reconcile";

  constructor(
    private store: Store,
    private llm: LlmClient,
  ) {}

  /** Pull just the user text out of a turn (assistant/tool text is a precision trap). */
  private userText(messages: Message[]): string {
    return messages
      .filter((m) => (m.role ?? "").toLowerCase() === "user")
      .map((m) => (m.content ?? "").trim())
      .filter(Boolean)
      .join("\n");
  }

  /** Step 1: LLM (or rule-shadow) candidate extraction. */
  private async extractCandidates(userText: string): Promise<CandidateMemory[]> {
    if (!userText.trim()) return [];
    try {
      const res = await this.llm.generateObject({
        schema: extractionResultSchema,
        system: EXTRACT_SYSTEM,
        prompt: buildExtractPrompt(userText),
        purpose: "extract",
      });
      return res.memories;
    } catch (err) {
      // Graceful degradation: if the LLM call fails, fall back to rules so the
      // write still produces structured memories rather than nothing.
      console.warn("extract: LLM failed, using rule fallback:", (err as Error).message);
      return ruleExtract(userText).map((m) => ({
        type: m.type as CandidateMemory["type"],
        key: m.key,
        value: m.value,
        confidence: m.confidence,
        mutable: m.mutable,
        snippet: m.snippet,
        entities: m.entities ?? [],
      }));
    }
  }

  /** Step 2: structured decision for a single candidate against its slot. */
  private async decide(
    candidate: CandidateMemory,
    existing: Array<{ id: string; key: string; value: string; updated_at: string }>,
  ): Promise<ReconcileDecision> {
    if (existing.length === 0) {
      return { decision: "ADD", target_id: null, reason: "no existing memory in slot" };
    }
    try {
      return await this.llm.generateObject({
        schema: reconcileDecisionSchema,
        system: RECONCILE_SYSTEM,
        prompt: buildReconcilePrompt({
          candidate: {
            type: candidate.type,
            key: candidate.key,
            value: candidate.value,
            mutable: candidate.mutable,
          },
          existing,
        }),
        purpose: "reconcile",
      });
    } catch (err) {
      console.warn("reconcile: LLM failed, defaulting:", (err as Error).message);
      // Deterministic fallback mirrors the mock heuristic.
      const same = existing.find(
        (e) => e.value.toLowerCase().trim() === candidate.value.toLowerCase().trim(),
      );
      if (same) return { decision: "NOOP", target_id: same.id, reason: "duplicate" };
      if (candidate.mutable) {
        return { decision: "SUPERSEDE", target_id: existing[0].id, reason: "mutable slot changed" };
      }
      return { decision: "ADD", target_id: null, reason: "additive" };
    }
  }

  /** Full pipeline for one turn. Returns the memories that landed. */
  async extract(messages: Message[], ctx: ExtractContext): Promise<AppliedMemory[]> {
    const userText = this.userText(messages);
    const candidates = await this.extractCandidates(userText);
    if (candidates.length === 0) return [];

    // Embed all candidate values in one batch (one network round-trip).
    const embeddings = await this.llm.embedMany(
      candidates.map((c) => `${c.key}: ${c.value}`),
      "embed_memory",
    );

    const applied: AppliedMemory[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const embedding = embeddings[i] ?? null;
      const existingRows = await this.store.memoriesForKey(ctx.userId, c.key);
      const existing = existingRows.map((r) => ({
        id: r.id,
        key: r.key,
        value: r.value,
        updated_at: r.updated_at,
      }));
      const decision = await this.decide(c, existing);
      const landed = await this.apply(c, embedding, decision, ctx);
      if (landed) applied.push(landed);
    }

    // Step 4: link co-referent memories (shared entity) into the graph.
    await this.linkMemories(applied, ctx.userId);
    return applied;
  }

  private async apply(
    c: CandidateMemory,
    embedding: number[] | null,
    decision: ReconcileDecision,
    ctx: ExtractContext,
  ): Promise<AppliedMemory | null> {
    const write: MemoryWrite = {
      type: c.type,
      key: c.key,
      value: c.value,
      confidence: c.confidence,
      importance: IMPORTANCE_BY_TYPE[c.type] ?? 0.5,
      entities: (c.entities ?? []).map((e) => e.toLowerCase()),
      snippet: c.snippet,
      embedding,
      validFrom: ctx.timestamp,
    };

    switch (decision.decision) {
      case "NOOP": {
        if (decision.target_id) {
          await this.store.bumpMemory(decision.target_id, c.confidence);
          await this.store.recordHistory({
            memory_id: decision.target_id,
            user_id: ctx.userId,
            decision: "NOOP",
            reason: decision.reason,
            value: c.value,
            target_id: decision.target_id,
            source_turn: ctx.turnId,
          });
        }
        return null;
      }
      case "UPDATE": {
        if (decision.target_id) {
          await this.store.updateMemory(decision.target_id, {
            value: c.value,
            confidence: c.confidence,
            embedding,
          });
          await this.store.recordHistory({
            memory_id: decision.target_id,
            user_id: ctx.userId,
            decision: "UPDATE",
            reason: decision.reason,
            value: c.value,
            target_id: decision.target_id,
            source_turn: ctx.turnId,
          });
          return {
            id: decision.target_id,
            decision: "UPDATE",
            key: c.key,
            value: c.value,
            entities: write.entities,
          };
        }
        // No target -> behave as ADD.
        return this.add(write, ctx, null, decision.reason);
      }
      case "SUPERSEDE": {
        if (decision.target_id) {
          await this.store.supersede(decision.target_id, ctx.timestamp ?? new Date().toISOString());
          const id = await this.store.insertMemory(write, ctx, decision.target_id);
          await this.store.recordHistory({
            memory_id: id,
            user_id: ctx.userId,
            decision: "SUPERSEDE",
            reason: decision.reason,
            value: c.value,
            target_id: decision.target_id,
            source_turn: ctx.turnId,
          });
          // Carry forward the contradiction link so history is graph-traversable.
          await this.store.addLink({
            userId: ctx.userId,
            src: id,
            dst: decision.target_id,
            relation: "supersedes",
            weight: 1.0,
          });
          return {
            id,
            decision: "SUPERSEDE",
            key: c.key,
            value: c.value,
            entities: write.entities,
          };
        }
        return this.add(write, ctx, null, decision.reason);
      }
      default:
        return this.add(write, ctx, null, decision.reason);
    }
  }

  private async add(
    write: MemoryWrite,
    ctx: ExtractContext,
    supersedes: string | null,
    reason: string,
  ): Promise<AppliedMemory> {
    const id = await this.store.insertMemory(write, ctx, supersedes);
    await this.store.recordHistory({
      memory_id: id,
      user_id: ctx.userId,
      decision: "ADD",
      reason,
      value: write.value,
      target_id: null,
      source_turn: ctx.turnId,
    });
    return { id, decision: "ADD", key: write.key, value: write.value, entities: write.entities };
  }

  /**
   * Link newly-written memories to existing active memories that share an entity
   * token (one-hop graph for multi-hop recall). E.g. a "pet:biscuit" memory and a
   * "location" memory both tagged with the user become reachable in one hop.
   */
  private async linkMemories(applied: AppliedMemory[], userId: string | null): Promise<void> {
    // Strong edges: shared entity / co-reference.
    const linked = new Set<string>();
    for (const a of applied) {
      if (a.entities.length === 0) continue;
      const related = await this.store.memoriesByEntities(userId, a.entities);
      for (const r of related) {
        if (r.id === a.id) continue;
        await this.store.addLink({
          userId,
          src: a.id,
          dst: r.id,
          relation: "shares_entity",
          weight: 0.6,
        });
        linked.add(`${a.id}:${r.id}`);
      }
    }

    // Weak edges: co-occurrence within the same user's stable profile. These give
    // multi-hop a backbone even when two facts share no surface entity (e.g.
    // "pet:biscuit" and "location:NYC" are both about the same person). Bounded to
    // the handful of identity-bearing facts to keep the graph sparse.
    const profile = userId ? await this.store.listMemories(userId, true) : [];
    const anchors = profile
      .filter((m) => ["employment", "location", "name"].includes(m.key) || m.key.startsWith("pet:"))
      .slice(0, 12);
    for (const a of applied) {
      for (const m of anchors) {
        if (m.id === a.id) continue;
        if (linked.has(`${a.id}:${m.id}`) || linked.has(`${m.id}:${a.id}`)) continue;
        await this.store.addLink({
          userId,
          src: a.id,
          dst: m.id,
          relation: "same_subject",
          weight: 0.3,
        });
      }
    }
  }
}
