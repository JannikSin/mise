# Mise dialect training

Fine-tuning corpus + generator for the local Mise assistant (see the Crystal
vault note `Life/Mise-Local-Model-Feasibility`). Goal: a LoRA adapter that
makes an open model (target: gpt-oss-120b class) natively speak "Mise
dialect" — the app's schemas, recipe JSON shape, tool conventions, and house
rules — instead of being re-taught in every system prompt. The model
NAVIGATES and FILLS data in the app (read plans, edit recipe JSON, call
tools); it never edits the codebase.

## Privacy rule (hard)

This directory (public repo) contains ONLY:
- generator code,
- hand-written schema cards grounded in `docs/SCHEMAS.md`,
- examples derived from the PUBLIC seed recipes (`seed-data/generated/`).

Real usage data (actual chats, receipts, Mom's/Laurie's profiles, anything
from mise-data) is training gold but lives in `mise-data/training/` (private)
and gets merged at training time on the Mac, never committed here.

## Curriculum — what the model is trained on

| Track | Skill | Source | Status |
|---|---|---|---|
| T1 schema cards | What plans/pantry/shopping/recipes ARE; field semantics (pinned, out, buffer, estCalories, locked) | hand-written from docs/SCHEMAS.md | `schema-cards.jsonl` (curated) |
| T2 extraction | Answer questions from recipe/plan JSON without inventing values | generated from seed recipes | `generate-dataset.mjs` |
| T3 recipe editing | Rescale servings, return full corrected JSON, never drop fields | generated (math is programmatically exact) | `generate-dataset.mjs` |
| T4 classification | Diet pattern per the app's own dietOf rules | generated (replicates app/lib/plan.js) | `generate-dataset.mjs` |
| T5 tool calling | WHEN to call which tool, exact arg shape (`tools.json` contract) | generated traces | `generate-dataset.mjs` |
| T6 honesty | Refuse to invent macros; say "needs re-estimation" after ingredient swaps; defer nutrition verdicts to the greger tool | hand-written + generated | `schema-cards.jsonl` + generator |
| T7 real usage | Actual assistant chats + corrections once the stack is live | mise-data (private) | capture loop, phase 2 |
| V1 receipts (vision) | Receipt photo → structured line items | capture loop: every receipt-scan APPROVAL in the app saves (image, corrected JSON) to mise-data/training/receipts/ | phase 2, needs worker change |
| V2 pantry shelf (vision) | Fridge/shelf photo → item list + freshness guesses | same loop on SCAN SHELF approvals | phase 2 |
| V3 expiry dates (vision) | Printed date crops → ISO date | photograph 50-100 real package dates | phase 2 |

The vision tracks fine-tune the vision model (Qwen3-VL class) separately via
mlx-vlm LoRA; 100-300 approved receipt pairs is a realistic first corpus and
the approval loop generates it as a side effect of normal use.

## Format

Chat JSONL, one example per line: `{"messages": [{"role": "system"|"user"|"assistant", "content": "..."}]}`
— the format `mlx_lm.lora --data training/data` consumes directly.
Tool calls are a single fenced JSON object `{"tool": "<name>", "args": {...}}`
per the contract in `tools.json`; at inference the serving layer enforces the
same shape with constrained decoding, so training and runtime agree.

## Run

```
node training/generate-dataset.mjs   # writes data/train.jsonl + data/valid.jsonl
```

Deterministic: same seeds in, same JSONL out (split by id hash, ~10% valid).

## Training (on the Mac Studio, later)

```
pip install mlx-lm
mlx_lm.lora --model <hf-model> --train --data training/data \
  --num-layers 16 --batch-size 1 --iters 600 --grad-checkpoint
mlx_lm.fuse ...   # optional: bake adapter for Ollama serving
```

Evaluate BEFORE/AFTER on `data/valid.jsonl` (exact-match for JSON tasks,
judge-scored for prose). An adapter ships only if it beats base on valid and
loses nothing on general tool-calling sanity checks.
