/**
 * Deterministic, offline mock LLM provider.
 *
 * This lets the ENTIRE service — extraction, per-fact reconciliation,
 * contradiction linking, and recall rerank/compaction — run in tests with no
 * network and no API keys. It is intentionally a small, transparent rule engine
 * that emits the SAME Zod-typed objects the live model would, exercising every
 * real code path (parallel reconcile, link creation, link-following recall,
 * budget enforcement, citations).
 *
 * Scope: it understands the categories in our fixtures (employment, location,
 * pets incl. implicit, diet, allergies, names, family, preferences/opinions incl.
 * the oranges->apples contradiction). It is NOT a general NLU — that is the live
 * model's job. The seam (LLMProvider) is identical, so swapping in the live
 * provider changes nothing else.
 *
 * Embeddings: a cheap deterministic hashed bag-of-words vector with cosine
 * behaviour good enough for the fixtures (same concept -> high similarity).
 */

import type { z } from "zod";
import { logInference, recordEmbedding, recordLlm } from "../metrics";
import type { extractionSchema, recallPlanSchema, reconcileSchema } from "../pipeline/schemas";
import type { LLMProvider } from "./provider";

// Synthetic ~4-chars/token estimate so offline metrics still move (the mock does
// no real model work and has no real usage to report).
const synthTokens = (text: string): number => Math.max(1, Math.ceil((text || "").length / 4));

const DIM = 256;

const STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "with",
  "this",
  "that",
  "it",
  "i",
  "you",
  "do",
  "does",
  "my",
  "im",
  "am",
  "so",
  "far",
  "just",
  "really",
]);

/** Crude suffix stemmer so "allergic/allergies", "lives/live", "prefers/prefer"
 *  collapse to a shared stem. Good enough for the offline fixtures; the live
 *  embedding model handles morphology properly. */
function stem(t: string): string {
  let s = t;
  s = s.replace(/(ically|ical|ic)$/, "");
  s = s.replace(/(iness|ness)$/, "");
  s = s.replace(/(ies|ied)$/, "");
  s = s.replace(/(ing|edly|ed|es|s)$/, "");
  s = s.replace(/(e)$/, "");
  if (s.length < 3) return t; // don't over-stem short words
  return s;
}

function tokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function embedOne(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const t of tokens(text)) v[hashStr(t) % DIM] += 1;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

const clean = (s: string): string => s.replace(/^[\s.,!?;:—–-]+|[\s.,!?;:—–-]+$/g, "").trim();

type Fact = z.infer<typeof extractionSchema>["facts"][number];

// --- extraction rules (mirror the live system prompt's intent) -------------

function extractFacts(turnText: string): Fact[] {
  const out: Fact[] = [];
  // only mine user lines
  const userLines = turnText
    .split("\n")
    .filter((l) => /^user/i.test(l.trim()))
    .map((l) => l.replace(/^user[^:]*:/i, "").trim())
    .join(" ");
  const text = userLines || turnText;

  const push = (f: Partial<Fact> & Pick<Fact, "type" | "key" | "value">, snippet: string) =>
    out.push({ confidence: 0.85, snippet, mutable: true, ...f });

  // employment
  const emp =
    /\bI(?:'m| am)?\s+(?:now\s+)?(?:work(?:ing)?\s+(?:at|for)|just\s+(?:joined|started(?:\s+(?:at|working\s+at))?)|joined|started\s+(?:a\s+(?:new\s+)?job\s+at|at)|got\s+a\s+job\s+at)\s+([A-Za-z][\w&.'\- ]*?[A-Za-z])(?:\s+as\s+(?:an?\s+)?([\w \-]+?))?(?:[.,!?]|$)/i.exec(
      text,
    );
  if (emp) {
    const company = clean(emp[1] ?? "");
    const role = emp[2] ? clean(emp[2]) : "";
    if (company) {
      const value = role ? `User works at ${company} as a ${role}` : `User works at ${company}`;
      push({ type: "fact", key: "employment", value, confidence: 0.9 }, text);
    }
  }

  // location (moved / lives)
  const moved =
    /\bI\s+(?:just\s+|recently\s+)?moved\s+to\s+([A-Za-z][\w.'\- ]*?[A-Za-z])(?:\s+from\s+([A-Za-z][\w.'\- ]*?[A-Za-z]))?(?:[.,!?]|$)/i.exec(
      text,
    );
  if (moved) {
    const loc = clean(moved[1] ?? "");
    if (loc)
      push({ type: "fact", key: "location", value: `User lives in ${loc}`, confidence: 0.9 }, text);
  } else {
    const lives =
      /\bI(?:'m| am)?\s+(?:live|living|based|located)\s+in\s+([A-Za-z][\w.'\- ]*?[A-Za-z])(?:[.,!?]|$)/i.exec(
        text,
      );
    if (lives) {
      const loc = clean(lives[1] ?? "");
      if (loc)
        push(
          { type: "fact", key: "location", value: `User lives in ${loc}`, confidence: 0.85 },
          text,
        );
    }
  }

  // pets (explicit + implicit)
  const petNamed =
    /\b(?:my|a|our)\s+(dog|cat|puppy|kitten|bird|hamster|rabbit)\s+(?:named|called)\s+([A-Z][\w]+)/.exec(
      text,
    );
  if (petNamed) {
    const species = (petNamed[1] ?? "").toLowerCase();
    const name = petNamed[2] ?? "";
    push(
      {
        type: "fact",
        key: `pet:${name.toLowerCase()}`,
        value: `User has a ${species} named ${name}`,
        confidence: 0.9,
        mutable: false,
      },
      text,
    );
  } else {
    const walking = /\bwalking\s+(?:my\s+)?(?:dog\s+|cat\s+)?([A-Z][\w]+)/.exec(text);
    if (walking) {
      const name = walking[1] ?? "";
      push(
        {
          type: "fact",
          key: `pet:${name.toLowerCase()}`,
          value: `User has a pet named ${name} (likely a dog)`,
          confidence: 0.6,
          mutable: false,
        },
        text,
      );
    }
  }

  // diet
  const diet = /\bI(?:'m| am)?\s+(?:a\s+)?(vegetarian|vegan|pescatarian)\b/i.exec(text);
  if (diet)
    push(
      {
        type: "preference",
        key: "diet",
        value: `User is ${(diet[1] ?? "").toLowerCase()}`,
        confidence: 0.9,
      },
      text,
    );

  // allergy (additive)
  const allergy = /\ballergic\s+to\s+([A-Za-z][\w.'\- ]*?[A-Za-z])(?:[.,!?]|$)/i.exec(text);
  if (allergy) {
    const what = clean(allergy[1] ?? "").toLowerCase();
    if (what)
      push(
        {
          type: "fact",
          key: `allergy:${what}`,
          value: `User is allergic to ${what}`,
          confidence: 0.9,
          mutable: false,
        },
        text,
      );
  }

  // name
  const nm = /\bmy name is\s+([A-Z][\w]+)/.exec(text);
  if (nm)
    push({ type: "fact", key: "name", value: `User's name is ${nm[1]}`, confidence: 0.95 }, text);

  // family
  const fam =
    /\bmy\s+(wife|husband|partner|son|daughter|mother|father|brother|sister|kid|child)\b(?:\s+(?:is\s+|named\s+|called\s+)([A-Z][\w]+))?/i.exec(
      text,
    );
  if (fam) {
    const relation = (fam[1] ?? "").toLowerCase();
    const who = fam[2];
    const value = who ? `User's ${relation} is named ${who}` : `User has a ${relation}`;
    push(
      { type: "fact", key: `family:${relation}`, value, confidence: 0.8, mutable: Boolean(who) },
      text,
    );
  }

  // preferences / opinions (love/like/hate/prefer)
  const pref =
    /\bI\s+(love|really like|like|enjoy|prefer|hate|dislike|can't stand|don't like|used to like)\s+([A-Za-z][\w.'\- ]*?[A-Za-z])(?:[.,!?]|$| now| better| more)/i.exec(
      text,
    );
  if (pref) {
    const verb = (pref[1] ?? "").toLowerCase();
    const topic = clean(pref[2] ?? "");
    if (topic && topic.length <= 60) {
      // canonical key: group citrus etc. loosely by topic word
      const topicKey = topic.toLowerCase().replace(/\s+/g, "_");
      const isOpinion = /typescript|python|javascript|react|framework|language/i.test(topic);
      push(
        {
          type: isOpinion ? "opinion" : "preference",
          key: `${isOpinion ? "opinion" : "preference"}:${topicKey}`,
          value: `User ${verb} ${topic}`,
          confidence: 0.7,
          mutable: true,
        },
        text,
      );
    }
  }

  return out;
}

// --- reconciliation rules ---------------------------------------------------

type Existing = { id: string; type: string; key: string; value: string; similarity: number };

function reconcileFact(fact: Fact, existing: Existing[]): z.infer<typeof reconcileSchema> {
  const base = {
    value: fact.value,
    key: fact.key,
    type: fact.type,
    confidence: fact.confidence,
    mutable: fact.mutable,
    target_ids: [] as string[],
    reason: "",
  };

  // exact same key match
  const sameKey = existing.filter((e) => e.key === fact.key);
  if (sameKey.length > 0) {
    const same = sameKey.find((e) => norm(e.value) === norm(fact.value));
    if (same) {
      return {
        operations: [{ op: "REINFORCE", ...base, target_ids: [same.id], reason: "restated" }],
      };
    }
    // preference/opinion reversal -> CONTRADICT (keep both, link)
    if (fact.type === "preference" || fact.type === "opinion") {
      return {
        operations: [
          {
            op: "CONTRADICT",
            ...base,
            target_ids: sameKey.map((e) => e.id),
            reason: "preference/opinion changed",
          },
        ],
      };
    }
    // single-valued fact moved on -> UPDATE
    if (fact.mutable) {
      return {
        operations: [
          { op: "UPDATE", ...base, target_ids: sameKey.map((e) => e.id), reason: "value changed" },
        ],
      };
    }
  }

  // additive or new
  // Cross-key contradiction for the preference family (e.g. likes oranges vs
  // prefers apples). Two routes:
  //  (a) explicit reversal marker in the NEW fact ("prefer/now/instead/used to")
  //      -> link to the nearest existing preference in the same broad domain;
  //  (b) shared-topic opposite sentiment (likes X vs dislikes X).
  if (fact.type === "preference" || fact.type === "opinion") {
    const reversal = /\b(prefer|now|instead|used to|these days|switched|over)\b/i.test(fact.value);
    const prefs = existing.filter((e) => e.type === "preference" || e.type === "opinion");

    // (a) reversal marker: pick the closest prior preference in the same domain.
    if (reversal && prefs.length > 0) {
      const domainPeers = prefs.filter((e) => sameDomain(e.value, fact.value));
      const pool = domainPeers.length > 0 ? domainPeers : prefs;
      const best = pool.slice().sort((x, y) => y.similarity - x.similarity)[0];
      if (best && (domainPeers.length > 0 || best.similarity >= 0.3)) {
        return {
          operations: [
            { op: "CONTRADICT", ...base, target_ids: [best.id], reason: "preference reversal" },
          ],
        };
      }
    }

    // (b) same topic, opposite sentiment.
    const semantic = prefs.find(
      (e) => e.similarity >= 0.45 && oppositeSentiment(e.value, fact.value),
    );
    if (semantic) {
      return {
        operations: [
          { op: "CONTRADICT", ...base, target_ids: [semantic.id], reason: "preference reversal" },
        ],
      };
    }
  }

  return { operations: [{ op: "ADD", ...base, reason: "new fact" }] };
}

// Tiny domain lexicon so the mock can tell "oranges" and "apples" are the same
// kind of preference (food/fruit) without sharing a token. The live model does
// this with real semantics; this is just enough for the offline fixtures.
const DOMAINS: Record<string, RegExp> = {
  fruit:
    /\b(orange|oranges|apple|apples|banana|bananas|pear|pears|grape|grapes|mango|mangoes|berry|berries)\b/i,
  beverage: /\b(coffee|tea|espresso|latte|matcha)\b/i,
  language: /\b(typescript|javascript|python|rust|go|java|ruby)\b/i,
};

function sameDomain(a: string, b: string): boolean {
  for (const re of Object.values(DOMAINS)) {
    if (re.test(a) && re.test(b)) return true;
  }
  return false;
}

function oppositeSentiment(a: string, b: string): boolean {
  const neg = /\b(hate|dislike|can't stand|don't like|prefer|used to)\b/i;
  const pos = /\b(love|like|enjoy)\b/i;
  // share a topic noun but differ in like/prefer wording, OR one says "used to"
  const aTok = new Set(tokens(a));
  const overlap = tokens(b).some((t) => aTok.has(t) && t.length > 3);
  const sentimentDiff = neg.test(a) !== neg.test(b) || /used to/i.test(a) || /prefer/i.test(b);
  return overlap && sentimentDiff;
}

const norm = (s: string): string => tokens(s).join(" ");

// --- recall (rerank + compaction) ------------------------------------------

interface ParsedCandidate {
  id: string;
  type: string | null;
  text: string;
  date: string | null;
  contradicts: Array<{ value: string; note: string }>;
  isTurn: boolean;
  sim: number | null;
}

function parseCandidates(block: string): ParsedCandidate[] {
  const out: ParsedCandidate[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\S+)\s+::\s+(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1];
    let rest = m[2];
    const contradicts: Array<{ value: string; note: string }> = [];
    const cMatch = rest.match(/\[CONTRADICTS (.+)\]\s*$/);
    if (cMatch) {
      for (const part of cMatch[1].split(";")) {
        const pm = /"([^"]*)"(?:\s*[—–-]\s*(.*))?/.exec(part.trim());
        if (pm) contradicts.push({ value: pm[1], note: (pm[2] ?? "").trim() });
      }
      rest = rest.replace(/\s*\[CONTRADICTS .+\]\s*$/, "");
    }
    const typeM = /^\[([a-z]+)\]\s*/.exec(rest);
    const type = typeM ? typeM[1] : null;
    if (typeM) rest = rest.slice(typeM[0].length);
    const simM = /^\[sim=([\d.]+)\]\s*/.exec(rest);
    const sim = simM ? Number(simM[1]) : null;
    if (simM) rest = rest.slice(simM[0].length);
    const dateM = /^\[(\d{4}-\d{2}-\d{2})\]\s*/.exec(rest);
    const date = dateM ? dateM[1] : null;
    if (dateM) rest = rest.slice(dateM[0].length);
    out.push({
      id,
      type,
      text: rest.trim(),
      date,
      contradicts,
      isTurn: id.startsWith("turn_"),
      sim,
    });
  }
  return out;
}

function queryTokens(prompt: string): Set<string> {
  const qm = /^Query:\s*(.*)$/m.exec(prompt);
  return new Set(tokens(qm ? qm[1] : ""));
}

function buildRecall(prompt: string): z.infer<typeof recallPlanSchema> {
  const blockM = prompt.match(/Candidates[^\n]*\n([\s\S]*?)\n\nSelect/);
  const block = blockM ? blockM[1] : "";
  const cands = parseCandidates(block);
  const qset = queryTokens(prompt);

  const scored = cands.map((c) => {
    const raw = overlap(qset, c.text);
    let s = raw;
    if (!c.isTurn) s += 0.15; // facts slightly favored
    if (c.contradicts.length > 0) s += 0.3; // ensure contradictions surface
    return { c, s, raw };
  });
  scored.sort((a, b) => b.s - a.s);

  // Noise gate: if the query has real tokens but NOTHING (no fact, no turn) has
  // any lexical overlap, the topic is unknown -> return empty context rather
  // than dumping a generic profile. Multi-hop survives because related facts
  // overlap the query (e.g. "dog/city" hits the pet + location facts).
  const SIM_FLOOR = 0.6; // semantic neighbour must be reasonably close to count
  const anyRelevant = scored.some(
    (x) => x.raw > 0 || x.c.contradicts.length > 0 || (x.c.sim ?? 0) >= SIM_FLOOR,
  );
  if (qset.size > 0 && !anyRelevant) {
    return { selected_ids: [], want_session_facts: false, context: "" };
  }

  const facts = scored.filter((x) => !x.c.isTurn);
  const turns = scored.filter((x) => x.c.isTurn);

  const selected = new Set<string>();
  const factLines: string[] = [];
  for (const { c } of facts) {
    // include all stable facts (multi-hop) - mock always includes facts
    let line = `- ${c.text}`;
    const conf = c.contradicts[0];
    if (conf) {
      const why = conf.note ? ` (${conf.note})` : "";
      line = `- ${c.text} — note: this reverses an earlier statement ("${conf.value}")${why}; the user appears to have changed their view.`;
    }
    factLines.push(line);
    selected.add(c.id);
  }

  const turnLines: string[] = [];
  for (const { c, s } of turns) {
    if (s <= 0 && qset.size > 0) continue;
    turnLines.push(`- [${c.date ?? ""}] ${c.text}`);
    selected.add(c.id);
  }

  const parts: string[] = [];
  if (factLines.length > 0) {
    parts.push("## Known facts about this user");
    parts.push(...factLines);
  }
  if (turnLines.length > 0) {
    parts.push("## Relevant from recent conversations");
    parts.push(...turnLines);
  }

  return {
    selected_ids: [...selected],
    want_session_facts: false,
    context: parts.join("\n").trim(),
  };
}

function overlap(qset: Set<string>, text: string): number {
  if (qset.size === 0) return 0.01;
  const tset = new Set(tokens(text));
  let n = 0;
  for (const t of qset) if (tset.has(t)) n++;
  return n / qset.size;
}

// --- provider ---------------------------------------------------------------

export function createMockProvider(): LLMProvider {
  return {
    name: "mock",

    async embed(texts: string[], phase?: string): Promise<number[][]> {
      const t0 = Date.now();
      const tokenCount = texts.reduce((acc, t) => acc + synthTokens(t), 0);
      recordEmbedding(tokenCount);
      logInference({
        kind: "embedding",
        phase: phase ?? "embed",
        model: "mock-embedding",
        inputTokens: tokenCount,
        outputTokens: 0,
        latencyMs: Date.now() - t0,
        request: texts.join("\n"),
        response: "[256-dim vector]",
      });
      return texts.map((t) => embedOne(t));
    },

    async generate<S extends z.ZodTypeAny>(args: {
      schema: S;
      system: string;
      prompt: string;
      task: string;
    }): Promise<z.infer<S>> {
      const t0 = Date.now();
      let obj: unknown;
      switch (args.task) {
        case "extract": {
          const m = args.prompt.match(/"""\n([\s\S]*?)\n"""/);
          obj = { facts: extractFacts(m ? m[1] : args.prompt) };
          break;
        }
        case "reconcile": {
          obj = parseReconcilePrompt(args.prompt);
          break;
        }
        case "recall": {
          obj = buildRecall(args.prompt);
          break;
        }
        default:
          obj = {};
      }
      const parsed = args.schema.parse(obj);
      const inputTokens = synthTokens(`${args.system}\n${args.prompt}`);
      const outputTokens = synthTokens(JSON.stringify(parsed));
      recordLlm(inputTokens, outputTokens);
      logInference({
        kind: "llm",
        phase: args.task,
        model: "mock-llm",
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - t0,
        request: args.prompt,
        response: JSON.stringify(parsed),
      });
      return parsed;
    },
  };
}

function parseReconcilePrompt(prompt: string): z.infer<typeof reconcileSchema> {
  // Parse the new fact
  const typeM = /type=(\S+)\s+key=(\S+)\s+mutable=(\S+)\s+confidence=([\d.]+)/.exec(prompt);
  const valM = /- value:\s*(.*)/.exec(prompt);
  const fact: Fact = {
    type: (typeM?.[1] as Fact["type"]) ?? "fact",
    key: typeM?.[2] ?? "misc",
    mutable: typeM?.[3] === "true",
    confidence: typeM ? Number(typeM[4]) : 0.7,
    value: valM ? valM[1].trim() : "",
    snippet: "",
  };
  // Parse existing memories
  const existing: Existing[] = [];
  const re = /- id=(\S+) \[(\w+)\] key=(\S+) similarity=([\d.]+) :: (.*)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = re.exec(prompt)) !== null) {
    existing.push({
      id: m[1],
      type: m[2],
      key: m[3],
      similarity: Number(m[4]),
      value: m[5].trim(),
    });
  }
  return reconcileFact(fact, existing);
}
