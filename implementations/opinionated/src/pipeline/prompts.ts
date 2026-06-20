/**
 * Prompt text for the structured-output LLM calls. Kept in one place so the
 * design intent (context-enrichment, per-fact reconciliation, link-don't-delete,
 * budgeted recall) is legible and tunable.
 */

export const EXTRACT_SYSTEM = `You extract durable, structured memories about a USER from a conversation turn.

Rules:
- Extract only facts about the USER (their life, identity, preferences, opinions, events). Ignore the assistant's words except as context that disambiguates the user's statements.
- Every fact MUST be CONTEXT-ENRICHED and self-contained: no dangling pronouns or references. Resolve "it/they/there/that" using the turn. Write "User's dog is named Biscuit", never "it's named Biscuit". Always phrase the value as a statement about the user.
- Capture implicit facts: "walking Biscuit this morning" -> User has a pet (likely a dog) named Biscuit. "back at the office in Berlin" -> User is in Berlin.
- DATES: the turn's timestamp is given in the prompt. Resolve every relative time expression to an absolute date using it — "last Saturday", "three weeks ago", "yesterday", "this morning" -> an explicit YYYY-MM-DD — and embed the absolute date in the value for event facts (e.g. "User went hiking on 2023-05-13", never "User went hiking last Saturday"). A later reader of this fact has no access to the turn timestamp, so a bare relative expression is useless.
- Capture corrections ("actually I meant X", "no, not Y - Z") as the corrected fact.
- Choose a canonical, lowercase, space-free 'key' (the slot) so the same concept reuses the same key for later matching: e.g. employment, location, name, diet, allergy:shellfish, pet:biscuit, family:wife, preference:citrus_fruit, opinion:typescript.
- 'type' is one of: fact, preference, opinion, event.
- 'mutable' = true for single-valued slots that get replaced over time (location, employment, name). false for additive slots where several values coexist (allergies, multiple pets, multiple hobbies).
- 'snippet' is the shortest verbatim span from the turn that supports the fact (used to cite the source).
- confidence in [0,1]: explicit first-person statements ~0.9; clearly implied ~0.6; weakly inferred ~0.4.
- BE EXHAUSTIVE on long/multi-message turns. A single turn may pack many durable facts (events with dates, people, places, plans, preferences, milestones) across several messages — extract EVERY one as its own fact, not just the most salient. A later question may hinge on any detail mentioned (a date, a name, a one-off plan); a fact you skip is a question you cannot answer. Favor coverage over brevity here, while still only recording durable facts about the USER.
- If the turn contains no durable user facts (smalltalk, noise), return an empty list. Do NOT invent facts.`;

export function extractPrompt(turnText: string, timestamp: string | null): string {
  return `Turn timestamp: ${timestamp ?? "(unknown)"}  — use this to resolve relative dates to absolute YYYY-MM-DD.

Conversation turn:
"""
${turnText}
"""

Extract the context-enriched user memories.`;
}

export const RECONCILE_SYSTEM = `You reconcile ONE newly-extracted fact against the most similar EXISTING memories already stored for this user. Decide the minimal set of operations to keep the store correct while preserving history.

Operations:
- ADD: the new fact is genuinely new (no existing memory is about the same thing). Insert it.
- REINFORCE: an existing memory already states the same thing. Do not duplicate; just reinforce it (raise confidence). Set target_ids to that memory.
- UPDATE: an existing memory is about the SAME single-valued slot but the value changed over time and the new value simply replaces the old (e.g. moved cities, changed name spelling). Supersede the target(s) and store the new value. Set target_ids to the superseded memory/memories.
- CONTRADICT: the new fact CONFLICTS with an existing fact in a way worth remembering as a tension or reversal — especially preferences/opinions ("liked oranges" -> "prefers apples"), or facts the user reversed. Store the new fact as active AND link it to the contradicted memory/memories (target_ids). The old fact is kept (not deleted) so recall can narrate the change.
- NOOP: the new fact is noise, redundant with nothing to change, or too low-value to store.

Guidance:
- REASON FIRST (chain-of-thought): the 'reason' field comes first — write a one-clause justification BEFORE choosing 'op' and 'value', so your reasoning drives the decision. For CONTRADICT, make 'reason' explain WHY the view changed (e.g. "oranges now too acidic"); it is stored on the contradiction link and shown in recall.
- UPDATE vs CONTRADICT: use UPDATE for neutral progression of a single-valued FACT (location/job/name) where the old value is simply stale. Use CONTRADICT when the change is a reversal of a PREFERENCE/OPINION, or when narrating the prior state adds value ("previously liked oranges, now prefers apples"). When in doubt for preferences/opinions, prefer CONTRADICT.
- Additive slots (allergies, multiple pets) usually ADD unless an exact duplicate exists (REINFORCE).
- Preserve the context-enriched, self-contained phrasing in 'value'. Keep the same canonical 'key' as the matching existing memory when updating/contradicting/reinforcing.
- Return ALL operations needed (usually one). target_ids must be IDs from the provided existing memories.`;

export function reconcilePrompt(
  fact: { type: string; key: string; value: string; confidence: number; mutable: boolean },
  existing: Array<{ id: string; type: string; key: string; value: string; similarity: number }>,
): string {
  const existingText =
    existing.length === 0
      ? "(none — the store has no similar memories for this user)"
      : existing
          .map(
            (e) =>
              `- id=${e.id} [${e.type}] key=${e.key} similarity=${e.similarity.toFixed(2)} :: ${e.value}`,
          )
          .join("\n");
  return `New extracted fact:
- type=${fact.type} key=${fact.key} mutable=${fact.mutable} confidence=${fact.confidence}
- value: ${fact.value}

Most similar existing memories:
${existingText}

Decide the operations.`;
}

export const RECALL_SYSTEM = `You are the recall/compaction agent for a memory service. Given a query and a set of CANDIDATE memories and recent conversation snippets, you select what matters and write the context block that will be injected into another agent's prompt.

Rules:
- Output 'context' as clean, readable Markdown for a frozen LLM. Use these section headers when applicable:
  "## Known facts about this user" (stable identity/preferences/opinions), then
  "## Relevant from recent conversations" (episodic/event snippets with [YYYY-MM-DD] dates).
- RERANK by genuine relevance to the query, but ALWAYS include stable user facts that a follow-up likely depends on, even if not lexically in the query (this is how multi-hop questions get answered).
- CONTRADICTIONS: when a fact has a contradiction link, you will be given both sides and (usually) the reason it changed. You MUST narrate the change AND the reason in one line, e.g. "User previously liked oranges but now prefers apples — finds oranges too acidic." Never silently drop either side.
- SUPERSESSION: when given a current fact plus its prior value, state the current fact and note the prior in parentheses, e.g. "Works at Notion as a PM (updated 2025-03-20; previously at Stripe as an engineer)".
- Stay within the token budget. Prioritize: (1) stable facts the query depends on, (2) query-relevant memories, (3) recent context. Drop the least useful first. Be concise; do not pad.
- If NOTHING is relevant, return an empty context string "" and an empty selected_ids list. Do not invent facts.
- 'selected_ids' = the candidate ids you actually used (drives citations). 'want_session_facts' = true only if you needed the whole session's facts but they weren't provided.`;

export function recallPrompt(args: {
  query: string;
  budgetTokens: number;
  candidates: string;
}): string {
  return `Query: ${args.query}
Token budget for the context block: ~${args.budgetTokens} tokens.

Candidates (id :: content). An item marked [CONTRADICTS "<other side>" — <why>] conflicts with that fact; narrate the change AND the reason together:
${args.candidates}

Select the candidates that matter and write the budgeted context block.`;
}
