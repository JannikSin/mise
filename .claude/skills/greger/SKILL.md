---
name: greger
description: Consult Dr. Michael Greger's evidence-based nutrition framework (How Not to Die, How Not to Diet, How Not to Age) for any health question or a choice between two foods/recipes/approaches during Mise work. Trigger on "ask greger", "what would greger say", any "is this healthy" / "is X or Y better" question, or any recipe-audit / week-generation decision that trades off two food options.
---

# Greger

Dispatches the `greger` persona agent (`.claude/agents/greger.md`) for nutrition questions:
recipe audits against the Daily Dozen, week-level nutrient coverage, or "which of these two
foods/recipes is the better call" tradeoffs.

## How to invoke

Use the Agent tool, `subagent_type: "greger"`. It's a fresh-context agent (not a fork): give
it everything it needs in the prompt, it has no memory of this conversation.

## Context to pass

Always include:
1. **The exact question** being asked (score this recipe / compare A vs B / audit this week).
2. **Full JSON** of every recipe or food in question: don't summarize, paste the actual
   recipe object(s) so the agent can compute `foodGroups` itself, not trust a paraphrase.
3. **David's targets**, read from `seed-data/generated/fitness/targets.json` (protein 210g/day,
   floor 185g; calories 3400, floor 3200) so the agent optimizes composition within the real
   target instead of guessing or inventing one.
4. If scoring against the Daily Dozen, also point it at `docs/SCHEMAS.md` for the current
   `foodGroups` shape so its output matches the schema exactly.

## Vault-gate reminder

Before dispatching, check whether this session already ran
`python C:\Users\DATar\.claude\vault_lock.py verify` and got OK. If yes, include the line
"VAULT STATUS: verified" in the agent prompt; otherwise include "VAULT STATUS: locked".
Never pass vault content into the prompt, and never verify the lock on the agent's behalf.
Vault-derived content must never be copied into any file in this repo; the agent knows this
but it's worth restating if you're asking it to write to a recipe's `lessons[]` field.

## Output

The agent gives a direct call first (A-vs-B questions) or a `foodGroups` object plus one-line
summary (recipe scoring), matching CLAUDE.md Part 4 house style: one call, one-sentence reason,
then nuance. Relay its answer as-is; don't re-summarize away the directness.
