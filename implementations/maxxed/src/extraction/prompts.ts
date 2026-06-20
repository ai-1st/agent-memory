/** Prompt builders for the LLM extraction + reconciliation steps. */

export const EXTRACT_SYSTEM = `You extract durable, structured memories about a USER from a single conversation turn.
Rules:
- Only capture facts ABOUT THE USER (their life, preferences, opinions, events). Ignore the assistant's words and generic chit-chat.
- Prefer few high-precision memories over many speculative ones. A wrong memory is worse than a missed one.
- Capture implicit facts: "walking Biscuit this morning" => the user has a pet named Biscuit. "Biscuit and I went hiking" => the user enjoys hiking.
- Capture corrections explicitly ("actually I meant X").
- type: fact | preference | opinion | event.
- key: a canonical, stable slug for the slot so the SAME concept dedups across turns. Use a shared vocabulary: "employment", "location", "name", "diet", "pet:<name>", "allergy:<thing>", "family:<relation>", "hobby:<name>", "preference:<topic>", "opinion:<topic>".
- mutable: true if the slot holds ONE current value (employment, location, diet) so a new value supersedes the old. false if multiple values coexist (allergies, pets, hobbies).
- entities: lowercase canonical tokens for graph linking (names, places, orgs, breeds), e.g. ["biscuit","corgi"].
- value: a terse human-readable statement, e.g. "Notion as a PM", "New York City", "allergic to shellfish".
- confidence: a number between 0 and 1 (NOT a percentage).
Output STRICT JSON matching the schema and nothing else (no prose, no markdown fences). Every memory MUST include all fields: type, key, value, confidence, mutable, snippet, entities. Use exactly one of the lowercase type values: fact, preference, opinion, event. If there are no entities, use an empty array []. If a source phrase isn't obvious, set snippet to the value.
Example of one well-formed memory:
{"type":"fact","key":"employment","value":"Notion as a PM","confidence":0.9,"mutable":true,"snippet":"I just joined Notion as a PM","entities":["notion","pm"]}
Return {"memories": []} if the turn contains no durable user facts.`;

export function buildExtractPrompt(userText: string): string {
  return `Extract memories from this turn.\n\n<USER_TEXT>\n${userText}\n</USER_TEXT>`;
}

export const RECONCILE_SYSTEM = `You decide how a newly-extracted candidate memory relates to the user's EXISTING memories for the same slot.
Choose exactly one decision:
- ADD: genuinely new information, no existing memory conflicts. (target_id = null)
- UPDATE: the candidate refines/details the SAME current fact (e.g. adds a role to an employer). Keep the same memory, update its value. (target_id = the existing memory)
- SUPERSEDE: the candidate CONTRADICTS or CORRECTS an existing memory (job change, move, opinion flip). The old memory must be kept as history but marked inactive. (target_id = the existing memory being replaced)
- NOOP: the candidate is a duplicate or adds nothing. (target_id = the duplicate, or null)
Be decisive about contradictions: "I work at Stripe" then "I joined Notion" => SUPERSEDE. Opinions that flip ("I love X" => "X is annoying") => SUPERSEDE while history preserves the arc.`;

export function buildReconcilePrompt(payload: {
  candidate: { type: string; key: string; value: string; mutable: boolean };
  existing: Array<{ id: string; key: string; value: string; updated_at: string }>;
}): string {
  return `Decide the relationship between the candidate and the existing memories.\n<JSON>\n${JSON.stringify(
    payload,
  )}\n</JSON>`;
}
