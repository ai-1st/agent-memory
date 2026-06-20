/**
 * Deterministic rule-based extraction.
 *
 * Two roles:
 *   1. The offline pipeline (MEMORY_PIPELINE=rule) uses it directly, so CI sees
 *      real typed memories without a network call.
 *   2. It is the *shadow* the mock LLM returns for the "extract" purpose, so the
 *      offline contract suite drives the exact same reconcile/recall code paths
 *      as production.
 *
 * It recognises the high-value categories the spec calls out: employment,
 * location/moves, pets (incl. implicit), diet, allergies, preferences/opinions,
 * names, family, hobbies. Precision-leaning: a missed fact is recoverable next
 * turn (or by the live LLM extractor); a wrong fact pollutes recall. Each
 * memory carries `entities` so the graph layer can link co-referent memories.
 */

import type { ExtractedMemory } from "./types";

const ENT = String.raw`([A-Za-z][\w&.'\- ]*?[A-Za-z])`;
const clean = (s: string): string => s.replace(/^[\s.,!?;:—–-]+|[\s.,!?;:—–-]+$/g, "");
// Strip trailing temporal/filler tails from a captured place name, e.g.
// "New York City next month" -> "New York City".
const TAIL_RE =
  /\s+(next|last|this)\s+(week|month|year|weekend)$|\s+(soon|now|today|tomorrow|yesterday|recently|already)$/i;
const cleanPlace = (s: string): string => {
  let v = clean(s);
  let prev: string;
  do {
    prev = v;
    v = v.replace(TAIL_RE, "").trim();
  } while (v !== prev);
  return v;
};
const lc = (s: string): string => s.toLowerCase();

const employmentRe = new RegExp(
  String.raw`\bI(?:'m| am)?\s+(?:now\s+)?(?:work(?:ing)?\s+(?:at|for)|just\s+(?:joined|started(?:\s+(?:at|working\s+at))?)|joined|started\s+(?:a\s+(?:new\s+)?job\s+at|at)|got\s+a\s+job\s+at)\s+` +
    ENT +
    String.raw`(?:\s+as\s+(?:an?\s+)?([\w \-]+?))?(?:[.,!?]|$)`,
  "i",
);
// "left Stripe", "quit Acme" — stop at a clause boundary ("and", punctuation)
// so "left Stripe and joined Notion" extracts company = "Stripe", not the rest.
const leftJobRe = new RegExp(
  String.raw`\bI\s+(?:just\s+)?(?:left|quit|resigned\s+from)\s+` +
    ENT +
    String.raw`(?:\s+and\b|[.,!?]|$)`,
  "i",
);
// "joined Notion", "I just joined Notion as a PM" inside a compound sentence.
const joinedRe = new RegExp(
  String.raw`\b(?:and\s+)?(?:just\s+)?(?:joined|started\s+at)\s+` +
    ENT +
    String.raw`(?:\s+as\s+(?:an?\s+)?([\w \-]+?))?(?:\s+and\b|[.,!?]|$)`,
  "i",
);
const movedRe = new RegExp(
  String.raw`\bI\s+(?:just\s+|recently\s+)?(?:moved|relocat(?:ed|ing))\s+(?:to\s+)?` +
    ENT +
    String.raw`(?:\s+from\s+` +
    ENT +
    String.raw`)?(?:[.,!?]|$)`,
  "i",
);
const relocatingRe = new RegExp(
  String.raw`\b(?:relocat(?:ing|e)|moving)\s+from\s+` +
    ENT +
    String.raw`\s+to\s+` +
    ENT +
    String.raw`(?:[.,!?]|$)`,
  "i",
);
const livesRe = new RegExp(
  String.raw`\bI(?:'m| am)?\s+(?:live|living|based|located)\s+in\s+` +
    ENT +
    String.raw`(?:[.,!?]|$)`,
  "i",
);
const settledRe = new RegExp(
  String.raw`\b(?:settled|moved)\s+(?:in(?:to)?|to)\s+` + ENT + String.raw`(?:[.,!?]|$)`,
  "i",
);

const petNamedRe =
  /\b(?:my|a|our)\s+(dog|cat|puppy|kitten|bird|hamster|rabbit)\s+(?:named|called)\s+([A-Z][\w]+)/;
const petIsRe = /\b([A-Z][\w]+)\s+is\s+(?:my|our|a)\s+(dog|cat|puppy|kitten|corgi|labrador|poodle)/;
const corgiRe =
  /\b(?:dog|pet)\s+named\s+([A-Z][\w]+),?\s+a\s+(corgi|labrador|poodle|terrier|beagle)/i;
const walkingRe = /\bwalking\s+(?:my\s+)?(?:dog\s+|cat\s+)?([A-Z][\w]+)/;
const dietRe = /\bI(?:'m| am)?\s+(?:a\s+)?(vegetarian|vegan|pescatarian)\b/i;
const allergyRe = new RegExp(String.raw`\ballergic\s+to\s+` + ENT + String.raw`(?:[.,!?]|$)`, "i");
const nameRe = /\b(?:my name is|i'm|i am)\s+([A-Z][a-z]+)\b/;
const familyRe =
  /\bmy\s+(wife|husband|partner|son|daughter|mother|father|brother|sister|kid|child)\b(?:\s+(?:is\s+|named\s+|called\s+)([A-Z][\w]+))?/i;
const preferenceRe = new RegExp(
  String.raw`\bI\s+(love|really like|like|enjoy|prefer|hate|dislike|can't stand|don't like)\s+` +
    ENT +
    String.raw`(?:[.,!?]|$)`,
  "i",
);
const hobbyRe =
  /\b(?:went|going|enjoy|love)\s+(hiking|running|cycling|swimming|climbing|painting|cooking|reading|gaming)\b/i;

function mem(
  m: Partial<ExtractedMemory> & Pick<ExtractedMemory, "type" | "key" | "value">,
): ExtractedMemory {
  return { confidence: 0.7, snippet: "", mutable: true, entities: [], ...m };
}

function entityTokens(...parts: string[]): string[] {
  const out = new Set<string>();
  for (const p of parts) {
    for (const t of p.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (t.length > 1) out.add(t);
    }
  }
  return [...out];
}

const RULES: Array<(s: string) => ExtractedMemory[]> = [
  (s) => {
    const out: ExtractedMemory[] = [];
    const m = employmentRe.exec(s);
    if (m) {
      const company = clean(m[1] ?? "");
      const role = m[2] ? clean(m[2]) : "";
      if (company) {
        out.push(
          mem({
            type: "fact",
            key: "employment",
            value: role ? `${company} as a ${role}` : company,
            confidence: 0.85,
            snippet: s,
            entities: entityTokens(company, role),
          }),
        );
      }
    }
    // "...and joined Notion as a PM" — a compound-sentence employer change.
    const j = joinedRe.exec(s);
    if (j && out.length === 0) {
      const company = clean(j[1] ?? "");
      const role = j[2] ? clean(j[2]) : "";
      if (company && company.toLowerCase() !== "in" && company.toLowerCase() !== "the") {
        out.push(
          mem({
            type: "fact",
            key: "employment",
            value: role ? `${company} as a ${role}` : company,
            confidence: 0.85,
            snippet: s,
            entities: entityTokens(company, role),
          }),
        );
      }
    }
    return out;
  },
  (s) => {
    const m = leftJobRe.exec(s);
    if (!m) return [];
    const company = clean(m[1] ?? "");
    if (!company) return [];
    // A "left X" statement is a supersession signal for employment, recorded as
    // an event for the timeline. The employer slot itself is updated by the
    // "joined Y" extraction (or the LLM reconciler).
    return [
      mem({
        type: "event",
        key: `left_job:${lc(company)}`,
        value: `left ${company}`,
        confidence: 0.8,
        snippet: s,
        mutable: false,
        entities: entityTokens(company),
      }),
    ];
  },
  (s) => {
    const reloc = relocatingRe.exec(s);
    if (reloc) {
      const to = cleanPlace(reloc[2] ?? "");
      return to
        ? [
            mem({
              type: "fact",
              key: "location",
              value: to,
              confidence: 0.85,
              snippet: s,
              entities: entityTokens(to),
            }),
          ]
        : [];
    }
    const moved = movedRe.exec(s);
    if (moved) {
      const loc = cleanPlace(moved[1] ?? "");
      return loc
        ? [
            mem({
              type: "fact",
              key: "location",
              value: loc,
              confidence: 0.85,
              snippet: s,
              entities: entityTokens(loc),
            }),
          ]
        : [];
    }
    const settled = settledRe.exec(s);
    if (settled) {
      const loc = cleanPlace(settled[1] ?? "");
      if (loc && loc.length <= 40) {
        return [
          mem({
            type: "fact",
            key: "location",
            value: loc,
            confidence: 0.8,
            snippet: s,
            entities: entityTokens(loc),
          }),
        ];
      }
    }
    const lives = livesRe.exec(s);
    if (lives) {
      const loc = cleanPlace(lives[1] ?? "");
      return loc
        ? [
            mem({
              type: "fact",
              key: "location",
              value: loc,
              confidence: 0.8,
              snippet: s,
              entities: entityTokens(loc),
            }),
          ]
        : [];
    }
    return [];
  },
  (s) => {
    const corgi = corgiRe.exec(s);
    if (corgi) {
      const name = corgi[1] ?? "";
      const breed = (corgi[2] ?? "").toLowerCase();
      return [
        mem({
          type: "fact",
          key: `pet:${lc(name)}`,
          value: `has a ${breed} named ${name}`,
          confidence: 0.9,
          snippet: s,
          mutable: false,
          entities: entityTokens(name, breed, "dog", "pet"),
        }),
      ];
    }
    const named = petNamedRe.exec(s);
    if (named) {
      const species = lc(named[1] ?? "");
      const name = named[2] ?? "";
      return [
        mem({
          type: "fact",
          key: `pet:${lc(name)}`,
          value: `has a ${species} named ${name}`,
          confidence: 0.85,
          snippet: s,
          mutable: false,
          entities: entityTokens(name, species, "pet"),
        }),
      ];
    }
    const petIs = petIsRe.exec(s);
    if (petIs) {
      const name = petIs[1] ?? "";
      const species = lc(petIs[2] ?? "");
      return [
        mem({
          type: "fact",
          key: `pet:${lc(name)}`,
          value: `has a ${species} named ${name}`,
          confidence: 0.8,
          snippet: s,
          mutable: false,
          entities: entityTokens(name, species, "pet"),
        }),
      ];
    }
    const walking = walkingRe.exec(s);
    if (walking) {
      const name = walking[1] ?? "";
      return [
        mem({
          type: "fact",
          key: `pet:${lc(name)}`,
          value: `has a pet named ${name}`,
          confidence: 0.55,
          snippet: s,
          mutable: false,
          entities: entityTokens(name, "pet"),
        }),
      ];
    }
    return [];
  },
  (s) => {
    const m = dietRe.exec(s);
    if (!m) return [];
    return [
      mem({
        type: "preference",
        key: "diet",
        value: lc(m[1] ?? ""),
        confidence: 0.85,
        snippet: s,
        entities: entityTokens(m[1] ?? ""),
      }),
    ];
  },
  (s) => {
    const m = allergyRe.exec(s);
    if (!m) return [];
    const what = clean(m[1] ?? "").toLowerCase();
    if (!what) return [];
    return [
      mem({
        type: "fact",
        key: `allergy:${what}`,
        value: `allergic to ${what}`,
        confidence: 0.85,
        snippet: s,
        mutable: false,
        entities: entityTokens(what),
      }),
    ];
  },
  (s) => {
    const m = nameRe.exec(s);
    if (!m) return [];
    const who = m[1] ?? "";
    // Guard against "I'm working", "I am vegetarian", etc. (those are other rules).
    if (["working", "based", "living", "located", "vegetarian", "vegan"].includes(lc(who))) {
      return [];
    }
    return [
      mem({
        type: "fact",
        key: "name",
        value: who,
        confidence: 0.85,
        snippet: s,
        entities: entityTokens(who),
      }),
    ];
  },
  (s) => {
    const m = familyRe.exec(s);
    if (!m) return [];
    const relation = lc(m[1] ?? "");
    const who = m[2];
    const value = who ? `${relation} named ${who}` : `has a ${relation}`;
    return [
      mem({
        type: "fact",
        key: `family:${relation}`,
        value,
        confidence: 0.7,
        snippet: s,
        mutable: Boolean(who),
        entities: entityTokens(relation, who ?? ""),
      }),
    ];
  },
  (s) => {
    const m = preferenceRe.exec(s);
    if (!m) return [];
    const verb = lc(m[1] ?? "");
    // Strip trailing temporal/intensifier tails so "TypeScript now" -> "TypeScript"
    // and the opinion lands in the same slot as the earlier stance.
    const topic = cleanPlace(clean(m[2] ?? "").replace(/\s+(now|anymore|lately|these days)$/i, ""));
    if (!topic || topic.length > 60) return [];
    const negative = ["hate", "dislike", "can't stand", "don't like"].includes(verb);
    const topicKey = topic.toLowerCase().replace(/\s+/g, "_");
    return [
      mem({
        // Strong sentiment about a topic reads as an opinion; mild as preference.
        type: negative || verb === "love" ? "opinion" : "preference",
        key: `preference:${topicKey}`,
        value: `${verb} ${topic}`,
        confidence: 0.65,
        snippet: s,
        entities: entityTokens(topic),
      }),
    ];
  },
  (s) => {
    const m = hobbyRe.exec(s);
    if (!m) return [];
    const hobby = lc(m[1] ?? "");
    return [
      mem({
        type: "preference",
        key: `hobby:${hobby}`,
        value: `enjoys ${hobby}`,
        confidence: 0.6,
        snippet: s,
        mutable: false,
        entities: entityTokens(hobby),
      }),
    ];
  },
];

function dedupe(mems: ExtractedMemory[]): ExtractedMemory[] {
  const seen = new Set<string>();
  const out: ExtractedMemory[] = [];
  for (const m of mems) {
    const sig = `${m.key} ${m.value.toLowerCase()}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(m);
  }
  return out;
}

/** Extract typed memories from a single block of (user) text. */
export function ruleExtract(text: string): ExtractedMemory[] {
  const out: ExtractedMemory[] = [];
  const t = (text ?? "").trim();
  if (!t) return out;
  for (const sentence of t.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s) continue;
    for (const fn of RULES) out.push(...fn(s));
  }
  return dedupe(out);
}
