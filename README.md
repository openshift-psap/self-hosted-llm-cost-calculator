# Self-Hosted vs Frontier API LLM Cost Calculator

Interactive tool for comparing the economics of self-hosted open-weight model inference against frontier API providers.

**Live**: [openshift-psap.github.io/self-hosted-llm-cost-calculator](https://openshift-psap.github.io/self-hosted-llm-cost-calculator/)

## What it does

Calculates the blended cost per million tokens for a self-hosted GPU deployment across 1–100% utilization, and plots it against closed frontier API costs (Claude, GPT, Gemini, Grok, Amazon Nova, Cohere) to show breakeven points.

Key features:
- **Live frontier pricing** fetched from the [OpenRouter API](https://openrouter.ai/api/v1/models) — no API key required
- **Built-in pricing snapshot** for offline use and as a fallback when the API is unavailable
- **Scenario presets** — measured operating points from [InferenceX](https://inferencex.semianalysis.com) agentic-traces benchmark runs (model × hardware, with provenance links), quick-select buttons for the top three
- **At-a-glance verdict** — the self-hosted $/M at your demand, the cheapest enabled API, monthly fleet vs API bills, utilization, and a plain-language conclusion are summarized above the chart
- **Pricing beside the results** — frontier API pricing sits in a right-hand rail next to the chart on desktop, so you never scroll the input sidebar to check a price
- **Optional log-scale chart** — spreads the long low-utilization tail and the $0.1–$2 comparison band across decades; linear remains the default
- **HuggingFace model search** for labeling the self-hosted model
- **Workload-aware blended cost** — accounts for the ISL:OSL token mix and prompt cache hit rate, which heavily influence frontier API costs for agentic workloads
- **Measured capacity** — uses the fleet's measured total goodput directly, without extrapolating prefill/decode performance
- **Single self-hosted cost** — unlike frontier APIs that charge differently per token type, self-hosted infrastructure has one fixed cost regardless of whether tokens are input, cached, or output

## Cost methodology

### Self-hosted cost per million tokens

Capacity is the fleet's **measured total token throughput** — input + output tokens combined, cache hits included — under the workload's latency SLOs. This is exactly what benchmarks report (InferenceX `total_tput_tps`, AIPerf `total_token_throughput`), so there is no derivation: the number you measured is the number the calculator uses.

```
cost/M = Annual TCO / (total_goodput_tps × seconds_per_year / 1e6)
```

At utilization U%: `cost/M = cost_at_100% / (U / 100)`

The cost is the same for all token types because every token — whether prefill (cached or uncached) or decode — consumes compute from the same fixed hardware pool.

Goodput is workload-specific: it was measured serving a particular mix (ISL:OSL, cache behavior) at a particular latency target. If you change the workload, re-benchmark rather than extrapolate — the calculator deliberately does not infer capacity changes from mix edits. Cache hit rate affects only the frontier billing blend, not self-hosted capacity.

### Frontier blended cost per million tokens

```
blended/M = uncached_input_frac × input_price
          + cached_input_frac   × cached_price
          + output_frac         × output_price
```

Where fractions are derived from the workload's ISL:OSL token mix and the cache hit rate — matching how frontier APIs bill, since cached input tokens are charged at the (cheaper) cached rate rather than being free. This matters because agentic workloads with high cache hit rates (e.g., 87% for multi-turn sessions) dramatically reduce the effective frontier cost — a naive comparison using list prices overstates the frontier cost.

The monthly API bill uses this blended price at the estimated monthly demand;
the blended $/M price itself does not change with demand.

### Demand estimate

```
calls/user/day = sessions/user/day × average model calls/session
monthly demand = users × working days × calls/user/day × (Avg ISL + Avg OSL)
average utilization = monthly demand / (total goodput × seconds/month)
```

Demand no longer depends on generation speed. A session may contain multiple
tasks; model calls include both the main agent and its subagents. Full prompt
tokens, including cached input, are counted on every call.

Sessions/user/day defaults to **1**, an editable usage assumption, not a trace
measurement. Calls/session defaults to **251.47**, the mean of 98,827 model
calls across 393 sessions in the
[June 21 full-context Weka corpus](https://huggingface.co/datasets/semianalysisai/cc-traces-weka-062126).
A quick-select button also supplies **173.70**, the mean of 68,266 calls across
393 sessions in the
[256k-capped corpus](https://huggingface.co/datasets/semianalysisai/cc-traces-weka-062126-256k).
Both values are editable and include subagent calls. These filtered coding
traces favour longer sessions; they do not establish tasks or sessions per
user per day. Use the corpus matching your workload, or your own measurements.
Choosing a calls/session reference changes only that demand input, not the
benchmark's ISL/OSL, cache rate, or goodput.

Average utilization covers the entire calendar month, including idle hours;
it is not a peak-capacity guarantee. Cost per consumed token is N/A at zero
demand, although the fixed fleet bill remains payable.

Monthly capacity uses exactly one twelfth of the 365.25-day annual capacity.
When demand exceeds capacity, the utilization readout says so and the scenario
cost is **N/A — insufficient capacity**. A chart marker at 100% then identifies
the capacity limit, not a feasible scenario. With zero goodput, utilization and
self-hosted $/M are N/A; API bills still reflect the offered demand.

Inputs are validated for finite values and permitted ranges before results are
shown. Invalid or empty numeric fields must be corrected; they are not silently
treated as zero. Benchmark measurements need not match input spinner step sizes.

## Default parameters

The defaults model an agentic coding workload served by [llm-d](https://github.com/llm-d/llm-d) on 8 × IBM Cloud 8xH200 nodes (64 H200 GPUs):

| Parameter | Default | Source |
|---|---|---|
| GPU nodes | 8 (8xH200 each) | IBM Cloud |
| Cost/node/month | $11,597.84 | IBM Cloud public pricing |
| Total goodput | 96,000 tok/s | aiperf benchmark (InferenceX CC-Traces Weka, c=128): 6,000 output tok/s at the workload's 15:1 mix |
| Cache hit rate | 87% | Multi-turn agentic session prefix reuse |
| Avg ISL | 30,000 tokens | Weka trace dataset |
| Avg OSL | 2,000 tokens | Weka trace dataset |

> Note: total goodput counts **all** tokens — input (cache hits included) plus
> output — the same convention as InferenceX `total_tput_tps` and AIPerf's
> total token throughput.

## Scenario presets

The sidebar offers preset scenarios built from measured [InferenceX](https://inferencex.semianalysis.com)
agentic-traces benchmark runs on vLLM- and SGLang-family serving stacks — real
single runs with full provenance. Preset names carry the workload shape
(ISL:OSL mix and measured cache hit rate); the serving framework is not shown
in the UI (it remains in the baked data and the linked run). Featured presets
get quick-select buttons (up to three); the dropdown lists the full catalog.

Each preset fills the infrastructure, workload-shape, and serving-performance
fields from one benchmark run:

| Field | InferenceX source |
|---|---|
| GPU type, GPUs per node, nodes | run topology + gpu-specs `scaleUpWorldSize` |
| $/node/month | hardware catalog rental `$/GPU-hr × 730 × GPUs/node` — see note below |
| Total goodput | `total_tput_tps` (measured, input + output) |
| Cache hit rate | `server_gpu_cache_hit_rate` (measured, same run) |
| Avg ISL / OSL | `mean_input_tokens` / `mean_output_tokens_actual` (full prompt) |
| Output tok/s per user | `median_intvty` |
| Concurrency | run `conc` |

> **Node cost source:** the rental $/GPU-hour rates come from the InferenceX
> hardware catalog (`GET /api/v1/views/options`, `costPerHour.r` — the rental
> "external" cost basis), browsable at
> [inferencex.semianalysis.com/chips](https://inferencex.semianalysis.com/chips).
> For example, H200 at $2.90/GPU-hr rental × 730 h × 8 GPUs/node = $16,936 per
> node-month. The derivation is shown in each preset's provenance caption.

Demand-estimate inputs (number of users, sessions/user/day, calls/session,
working days) are deliberately **not** touched by benchmark presets — they
retain the user's current values. Corpus call counts are selected separately
from infrastructure presets; presets do not establish daily user activity.
Editing a benchmark field switches the scenario to Custom and clears its
measured-run attribution. Editing demand inputs retains the preset attribution.

The InferenceX API does not send CORS headers, so presets are baked into
`index.html` as a snapshot between `BEGIN/END SCENARIO_PRESETS` markers:

```sh
node scripts/refresh-presets.mjs          # preview
node scripts/refresh-presets.mjs --write  # update index.html
node scripts/refresh-presets.mjs --check  # fail if the snapshot is stale
```

The script picks, per curated model × hardware pair, an operating point from
that configuration's Pareto curve: the **highest-throughput frontier point
whose median per-user interactivity still meets a 35 tok/s target** (the same
default InferenceX's own calculator uses). Runs at higher concurrency trade
per-user streaming speed for total throughput; the target keeps presets on
the efficient frontier at a usable interactivity. Edit `CURATED` to change
the catalog or `INTERACTIVITY_TARGET` to change the operating point.
If no eligible frontier point meets the target, the most interactive point is
selected. Missing, theoretical-only, or out-of-range cache measurements are
excluded. Node sizes come from the chip catalog, or an explicit NVL domain in
the hardware label. TPU7x retains an explicit eight-chip accounting unit while
absent from the chip catalog; other unknown topologies fail refresh.

## Frontier pricing snapshot

The calculator renders snapshot prices immediately, then fetches live prices
from OpenRouter with an eight-second timeout. The visible pricing status reports
snapshot fallback and missing cached prices. For a usable live model without a
cached-input price, both the app and refresh script use its input price. Missing
input/output prices retain the model's complete snapshot price triple in the app;
the maintenance script rejects incomplete pricing. User price edits are preserved
when the background request completes.

The table below is the
offline fallback baked into `index.html`, refreshed on **2026-10-31**. Prices are
USD per 1M tokens. Only closed frontier APIs are listed — open-weight models
(DeepSeek, Kimi, GLM, Qwen, ...) are excluded from the comparison, since
self-hosting them is exactly what this calculator evaluates.

| Model | Input | Cached input | Output |
|---|---:|---:|---:|
| Claude Opus 5.5 | $4.00 | $0.20 | $20.00 |
| Claude Sonnet 5.5 | $2.00 | $0.10 | $10.00 |
| Claude Fable 5.1 | $10.00 | $0.25 | $50.00 |
| Claude Haiku 5.5 | $0.10 | $0.01 | $0.50 |
| GPT-6.1 Sol | $2.00 | $0.10 | $10.00 |
| GPT-6.1 Terra | $1.00 | $0.05 | $5.00 |
| GPT-6.1 Sol Pro | $2.00 | $0.10 | $10.00 |
| Gemini 4 Argon | $2.00 | $0.10 | $10.00 |
| Gemini 3.8 Flash | $0.83 | $0.083 | $4.13 |
| Grok 4.7 | $2.00 | $0.50 | $6.00 |
| Nova Premier 1.0 | $2.50 | $0.625 | $12.50 |
| Command A+ | $0.30 | $0.15 | $1.50 |

### Refreshing pricing

The repo includes an agent skill and a small Node.js (22+) script for keeping the
snapshot current. Cached input prices keep 3 decimals (they can be sub-cent);
all other prices round to 2:

```sh
node scripts/refresh-pricing.mjs          # preview
node scripts/refresh-pricing.mjs --write  # update index.html
node scripts/refresh-pricing.mjs --check  # fail if the snapshot is stale
```

The script picks the newest model in each configured family from OpenRouter, so
version bumps are picked up automatically. See
`.claude/skills/refresh-frontier-pricing/SKILL.md` for the full workflow and how
to add or remove a model family.

### Deploying

Pushing to `main` triggers the GitHub Pages workflow in
`.github/workflows/pages.yml`. Pull requests run the same validation. Deployment
requires successful calculation/DOM tests, refresh-algorithm tests, browser
tests, and both live snapshot checks. Only `index.html` is published. See
`.claude/skills/commit-push-deploy/SKILL.md` for the commit, push, watch, and
live-site verification workflow.

## Tech stack

Single HTML file, no build step. Uses Chart.js 4.x from CDN, vanilla JavaScript, and browser `fetch()` for API calls (OpenRouter and HuggingFace support CORS; InferenceX does not, so presets are baked as a snapshot). The pricing and preset refresh scripts are maintenance tools only; they are not part of the deployed page.

Numerical results remain usable if the Chart.js CDN is unavailable. The app's
Print button and native browser printing both regenerate a current report.

## Testing

Development checks require Node.js 22+ and test-only dependencies; the deployed
page remains a single static HTML file.

```sh
npm ci
npm test                             # offline node:test + jsdom suites
npx playwright install chromium     # add --with-deps on a fresh Linux host
npm run test:browser                 # real Chromium, local Chart.js, mocked APIs
npm run check:snapshots              # live OpenRouter and InferenceX checks
```

`node scripts/test-calculations.mjs` remains available after `npm ci`. It uses
an actual parsed DOM and fresh app instances, independent financial reference
values, exact Weka references, all preset field mappings, validation boundaries,
pricing controls, network failure paths, and native-print events. Its chart stub
does not draw; the browser suite exercises the real chart and annotations,
keyboard controls, mobile layout, PDF printing, API timeouts, and CDN failure.
`scripts/test-refresh.mjs` tests selection, topology and pricing policies against
deterministic fixtures without network access.

For an installed local Chrome, use
`CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser`.
Locale-independent assertions are also checked in CI with `LANG=de_DE.UTF-8`.

## License

Apache-2.0
