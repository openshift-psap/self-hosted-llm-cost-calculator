# AGENTS.md

Working guide for AI agents (and humans) modifying this repository. The
user-facing README describes the calculator; this file records how the model
works, where every number comes from, and the decisions that are deliberate —
do not "fix" them without understanding why they exist.

## What this is

A single-file static web app (`index.html`, no build step) comparing the cost
of self-hosting open-weight LLMs against closed frontier APIs. Deployed via
GitHub Pages on push to `main`. Live:
https://openshift-psap.github.io/self-hosted-llm-cost-calculator/

## Commands

```sh
npm ci                                  # install test-only dependencies (Node 22+)
npm test                                # offline financial/DOM + refresh tests
npx playwright install chromium         # browser setup; --with-deps on fresh Linux
npm run test:browser                     # real Chromium and Chart.js, mocked APIs
node scripts/refresh-pricing.mjs --check   # frontier pricing snapshot freshness
node scripts/refresh-presets.mjs --check   # scenario preset snapshot freshness
node scripts/refresh-pricing.mjs --write   # regenerate pricing from OpenRouter
node scripts/refresh-presets.mjs --write   # regenerate presets from InferenceX
node scripts/test-calculations.mjs        # calculation + jsdom interaction suite

# Inline JS syntax check (the app is one <script> block in index.html):
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];fs.writeFileSync('/tmp/opencode/inline.js',m.at(-1)[1]);"
node --check /tmp/opencode/inline.js
```

Both snapshot `--check` commands, `npm test`, and `npm run test:browser` must
pass before every deploy, including documentation-only changes. The Pages
workflow enforces them and also validates pull requests. Only `index.html` is
published. They are part of the commit-push-deploy skill preflight.
Snapshots are baked into `index.html`
between marker comments because the source APIs do not all send CORS headers.

## The cost model (current semantics — several earlier designs were replaced)

### Capacity = measured total goodput. No derivation.

```
cost/M at 100% = Annual TCO / (total_goodput_tps × seconds_per_year / 1e6)
```

`total_goodput` is the fleet's measured total token throughput (input + output,
cache hits included) under the workload's latency SLOs — exactly InferenceX's
`total_tput_tps`. History: we previously derived capacity as
`min(output_goodput/output_frac, input_goodput/input_frac)`. That was verified
to reproduce `total_tput_tps` to within rounding (a run's aggregate mix equals
its `mean_input_tokens/mean_output_tokens`, so both limits collapse to
`input + output`), so the derivation was replaced by the reported number.
**Do not reintroduce a decode/prefill-limit model.** If the user changes the
workload mix, the answer is "re-benchmark", not extrapolation.

### Cache hit rate is a billing-only knob.

It sets the frontier blended-price weights (cached input bills at the cached
rate, not $0) and nothing else. It deliberately does not change self-hosted
capacity. This matches the enablement material's stated design ("the
calculator does not infer a cache-driven speedup").

### Blended frontier price uses full-prompt ISL.

```
blended/M = uncached_input_frac × input_price
          + cached_input_frac   × cached_price
          + output_frac         × output_price
```

Fractions derive from **Avg ISL / Avg OSL** (full prompt, cache hits included)
split by cache hit rate — because APIs bill the whole prompt. (An earlier
version used the goodput ratio as weights; that overstated output weight and
flipped conclusions. Do not go back.)

### Demand model → average utilization only.

Users × sessions/user/day × model calls/session × working days × (ISL + OSL)
→ monthly demand →
`avg utilization = demand / (total_goodput × seconds_per_month)`. Above 100%,
the utilization readout turns red and says demand exceeds capacity; scenario
cost is N/A. The chart's clipped marker is labeled as the capacity limit.
A peak-concurrent calculation existed and was **deliberately removed**
at the user's request — do not re-add it.

Demand is independent of output tok/s/user. The former active-hours/duty-cycle
model inferred more demand from faster streaming and was replaced by explicit
session counts. Sessions/user/day defaults to 1 (an assumption); calls/session
defaults to 251.47 (98,827 main + subagent calls / 393 sessions in
`semianalysisai/cc-traces-weka-062126`). The separate 256k reference button uses
173.70 (68,266 / 393 in `cc-traces-weka-062126-256k`). Both are editable; the
reference buttons change only calls/session. These are selected, longer coding
sessions, not measurements of tasks/user/day. A session can contain many tasks.
Do not infer the corpus from model/hardware or change goodput when selecting a
calls/session reference. Cost per consumed token is N/A at zero demand.

Monthly API bills use `blended/M × monthlyDemand / 1e6`, not a hardcoded
utilization. API blended $/M and breakeven utilization stay demand-independent.
Monthly capacity uses `SECS_PER_YEAR / 12`, so consumed-token cost equals the
monthly fleet bill divided by monthly demand when demand can be served.
Zero goodput produces N/A utilization and self-hosted costs, never a free fleet.

### Updating the Weka demand references

The pinned dataset cards above and InferenceX's public dataset API provide
the reference counts:

- `https://inferencex.semianalysis.com/api/v1/datasets/cc-traces-weka-062126`
- `https://inferencex.semianalysis.com/api/v1/datasets/cc-traces-weka-062126-256k`

Use `(summary.mainTurns + summary.subagentTurns) / conversation_count`, or
`summary.meanRequestsPerConversation`; subagent groups are not model calls.
Use the mean for aggregate-volume estimates, not the median. The references
are explicit user choices, not inferred from an infrastructure preset. Updating
them requires keeping the input default, button values, source links, README,
and regression expectations aligned. Sessions/user/day remains a usage
assumption; do not infer it from benchmark duration or replay speed.

### Removed inputs (do not re-add)

"Other $/month", "Pilot months", the peak-concurrent warning, the selected-model
chip, and the separate output/prefill goodput fields were all removed by
explicit user decision. TCO = nodes × $/node/month × 12.

### Display rules

All displayed values cap at 2 decimal places — **except cached input prices,
which keep 3** (they can be sub-cent, e.g. $0.003/M). The chart y-axis
auto-scales: `max(self-hosted curve at 1% util × 1.05, max frontier blended × 1.2)`,
no fixed floor or cap. The x-axis is linear from 1–100% with 10-point ticks.
The y-axis has an opt-in log-scale checkbox (off by default). Log mode pads the
range to whole decades and labels ticks compactly so the low-utilization spike
does not swamp the comparison band; the linear auto-scale rule above remains
the default. Below 640px the chart hides its legend and breakeven percentage
labels (the table retains them) to avoid collisions.

The main column opens with an at-a-glance strip (self-hosted $/M at demand,
cheapest enabled API, monthly fleet vs API bills, utilization) and a generated
verdict sentence. Its wording is derived, never hardcoded: API-cheaper,
self-hosted-cheaper, zero-demand, zero-capacity, overloaded, no-model-selected
and invalid-input states are distinct. The sidebar "Results" panel mirrors the
demand-based numbers and keeps the 100%-utilization floor and derivation below
a divider. Input sections are native `<details>` accordions, open by default.

## Frontier comparison rules

- **Closed APIs only.** Open-weight models (DeepSeek, Kimi, GLM, Qwen, ...)
  are excluded from the API side — self-hosting them is what this calculator
  evaluates. Current list: Anthropic (Opus/Sonnet/Fable/Haiku), OpenAI
  (Sol/Terra/Sol Pro), Google (Argon/Flash), xAI Grok, Amazon Nova Premier,
  Cohere Command A+.
- Model families live in `FAMILIES` in `scripts/refresh-pricing.mjs`. Keep
  patterns narrow and the list **provider-contiguous** (the UI groups by
  provider in list order).
- The frontier list UI is provider-grouped accordion rows: one compact row per
  model (checkbox, swatch, name, price triple, blended $/M); price editing and
  blend math expand on click. Keep it compact.
- Snapshot prices render immediately; live requests time out after eight seconds.
  Keep fallback status visible. Missing live cached pricing uses the live input
  rate, consistently with the refresh script. A model with unusable input/output
  prices retains its complete snapshot triple. Preserve edits and selections
  when live data arrives. Chart unavailability must not prevent numerical output.

## Scenario presets

Sourced from InferenceX (`https://inferencex.semianalysis.com`) agentic-traces
benchmark runs. Public API, no auth, **no CORS** — hence the baked snapshot.

### Selection rule (Pareto-aware)

InferenceX data is a Pareto curve: concurrency trades per-user interactivity
for total throughput. The refresh script:

1. Filters to eligible agentic runs on **vLLM- or SGLang-family** stacks
   (framework family from `/api/v1/views/options`).
2. Computes the Pareto frontier over `(total_tput_tps, median_intvty)`.
3. Picks the **highest-throughput frontier point with median interactivity
   ≥ 35 tok/s** (InferenceX's own calculator default). Falls back to the most
   interactive frontier point if none meets the target. Date is only a
   tiebreak — never prefer a newer, dominated point.

Earlier versions used "latest date, then max throughput above a 20 tok/s
floor" and picked dominated points off the frontier. Do not regress.

### Field mapping

| Calculator input | InferenceX source |
|---|---|
| GPU type | hardware label from `/views/options` |
| GPUs per node, nodes | run topology; node size = gpu-specs `scaleUpWorldSize` (8 SXM, 72 NVL72); sub-rack partitions (e.g. 40 of 72) become one node of that size |
| $/node/month | `costPerHour.r` (rental basis) × 730 × GPUs/node |
| Total goodput | `total_tput_tps` |
| Cache hit rate | `server_gpu_cache_hit_rate` (measured, same run) |
| Avg ISL / OSL | `mean_input_tokens` / `mean_output_tokens_actual` |
| Output tok/s per user | `median_intvty` |
| Concurrency | run `conc` |

Presets set infrastructure, workload-shape, and serving fields — and the model
search box. They **never** touch demand-estimate inputs (users, sessions/day,
calls/session, working days), which retain the user's current values.
Editing benchmark fields switches to Custom and clears measured attribution;
demand edits do not. Missing/null/theoretical-only cache measurements are
ineligible. Cache rates must be finite numbers in [0, 1].

Topology uses catalog `scaleUpWorldSize`, then explicit `NVLnn` hardware labels.
TPU7x has an explicit eight-chip accounting fallback until catalog coverage is
available. Unknown hardware must not silently acquire an eight-GPU node size.

### UI conventions

Preset labels carry the workload shape (`GLM-5.2 · GB200 NVL72 · 135k:1k
ISL:OSL, 76% cache`). **Serving framework names never appear in the UI** (they
remain in the baked data and the linked run). The provenance caption shows
precision, concurrency, tok/s/user, date, run URL, and the node-cost
derivation. Featured presets get quick-select buttons (up to three); the featured set is
chosen deliberately (currently GLM-5.2/B200, Kimi-K3/TPU7x, Muse-Spark-Open/MI355X).

## InferenceX API gotchas

- **`run_url` is not unique.** One GitHub Actions workflow run contains
  multiple benchmark rows (a concurrency sweep). When matching a baked preset
  back to its row, match on the full config (model, hardware, framework,
  precision, conc, date) — matching by URL alone silently grabs the wrong row
  and makes correct data look wrong.
- **`input_tput_tps` is raw** — includes cached tokens (verified:
  `total_prompt_tokens / duration ≈ input_tput_tps`). Use `total_tput_tps`
  for capacity; don't reconstruct it.
- A display model (e.g. `GLM-5.2`) maps to multiple dbKeys (`glm5.2`,
  `glm5.3`); the `/benchmarks?model=` query takes display names.
- The `/benchmarks` model parameter needs exact display names
  (`Qwen-3.5-397B-A17B`, not `Qwen-3.5`).
- Cache hit rate varies sharply with concurrency (KV pressure): e.g. 90% at
  c=2 → 5% at c=16 on 8×H200. Always take hit rate and goodput from the
  **same run**.
- InferenceX evals (`/api/v1/evaluations`) measure serving quality of open
  models under load — they do not score frontier APIs and cannot be used for
  intelligence-class matching (LMArena-style leaderboards are the candidate
  source if that feature is ever built; a design was explored and shelved).

## Testing

After `npm ci`, run `npm test` for deterministic `node:test` suites. The
calculation suite syntax-checks the production inline script and runs it in
jsdom with real DOM parsing/events and fresh app instances. Only network and
chart drawing are stubbed. Independent financial references, boundary cases,
all preset mappings, both exact Weka references, pricing edits, network failures
and print events are covered. Keep assertions locale-independent.

The refresh suite imports guarded CLI helpers directly, with fixtures for
Pareto selection, measured cache validation, topology and price conversion.
Snapshot checks are freshness checks, not independent algorithm verification.

`npm run test:browser` exercises real Chromium and the matching local Chart.js
version with mocked APIs: chart annotations, pricing controls, keyboard access,
mobile header layout, actual PDF generation, timeout and CDN failure. The Node
suite's chart stub does not cover canvas rendering. Browser dependencies are
test-only; there is no application build step.

Important invariants: doubling usage doubles demand and API bills without
changing blended $/M or breakeven utilization; changing streaming speed leaves
demand unchanged; changing capacity alone leaves API bills unchanged; cache
changes affect billing, not demand or measured self-hosted capacity. Presets
must preserve edited demand inputs, not reset them to defaults.

## Validation and presentation invariants

`calculateScenario` is a pure input-to-result function inside the inline app.
Numeric ranges and finite values are validated there, independently of HTML
attributes. Empty fields are invalid, not zero. Physical node/GPU counts and
concurrency are integers; spinner step sizes are not validation constraints.
Invalid scenarios clear numerical results and identify the offending fields.
Zero demand, zero capacity and overloaded demand are distinct states.

Native `beforeprint` regenerates the report, including current validation and
pricing-source status. A printed chart is captured only after synchronous
rendering. Accordion controls must remain keyboard accessible and inputs named.

## Skills

- `.claude/skills/commit-push-deploy/SKILL.md` — preflight, commit, push,
  watch the Pages workflow for the exact pushed SHA, verify the live site.
  Preflight includes both snapshot checks and the offline regression script.
- `.claude/skills/refresh-frontier-pricing/SKILL.md` — how to change the
  frontier model list and refresh pricing.

Stage only intended files by name. Leave unrelated untracked presentations,
enablement material, and notes untouched. A successful Git push is not proof
of a successful deployment: require the matching Pages run to complete with
`success`, then check HTTP 200 and compare live HTML with the committed file.
The public Actions API works when `gh` is not authenticated; Git push may
still work through Git's separate credential configuration.

## Deliberate decisions log

Summarized above, but the short list of things that were tried and reversed —
avoid re-litigating them:

1. Uncached-prefill-goodput input → replaced by raw, then by total goodput.
2. Goodput-ratio blend weights → replaced by ISL:OSL weights.
3. Peak-concurrent calculation → removed.
4. Other $/month and Pilot months inputs → removed.
5. Open-weight models in the API comparison → removed.
6. Static chart y-axis → auto-scaling.
7. Framework names in preset UI → removed.
8. "Latest date first" preset selection → Pareto-frontier selection.
9. Speed-derived demand (active hours × generation duty cycle) → explicit
   sessions/user/day × model calls/session.
