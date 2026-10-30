# Self-Hosted LLM Cost Calculator

Interactive tool for comparing the economics of self-hosted open-weight model inference against frontier API providers.

**Live**: [openshift-psap.github.io/self-hosted-llm-cost-calculator](https://openshift-psap.github.io/self-hosted-llm-cost-calculator/)

## What it does

Calculates the blended cost per million tokens for a self-hosted GPU deployment across 1–100% utilization, and plots it against frontier API costs (Claude, GPT, Gemini, DeepSeek, Grok, Kimi) to show breakeven points.

Key features:
- **Live frontier pricing** fetched from the [OpenRouter API](https://openrouter.ai/api/v1/models) — no API key required
- **Built-in pricing snapshot** for offline use and as a fallback when the API is unavailable
- **Scenario presets** — measured operating points from [InferenceX](https://inferencex.semianalysis.com) agentic-traces benchmark runs (model × hardware, with provenance links), quick-select buttons for the top three
- **HuggingFace model search** for labeling the self-hosted model
- **Workload-aware blended cost** — accounts for the ISL:OSL token mix and prompt cache hit rate, which heavily influence frontier API costs for agentic workloads
- **Two-resource capacity model** — decode and prefill goodput are separate capacity limits; sustained throughput is whichever the workload mix binds first
- **Single self-hosted cost** — unlike frontier APIs that charge differently per token type, self-hosted infrastructure has one fixed cost regardless of whether tokens are input, cached, or output

## Cost methodology

### Self-hosted cost per million tokens

Decode and prefill are modeled as separate serving resources (as in a disaggregated stack). Token fractions come from the workload's ISL:OSL mix and cache hit rate.

```
decode_limit   = output_goodput_tps / output_frac
prefill_limit  = prefill_goodput_tps / input_frac
sustained_tps  = min(decode_limit, prefill_limit)

cost/M = Annual TCO / (sustained_tps × seconds_per_year / 1e6)
```

At utilization U%: `cost/M = cost_at_100% / (U / 100)`

The cost is the same for all token types because every token — whether prefill (cached or uncached) or decode — consumes compute from the same fixed hardware pool.

Prefill goodput is the **raw figure benchmarks report**: all input tokens per second, cache hits included (InferenceX `input_tput_tps`, AIPerf `total_isl / duration`, and vLLM-style aggregate input throughput all work). The capacity model divides it by the input fraction, which is equivalent to deriving uncached prefill capacity (`raw × (1 − hit rate)`) and measuring it against the uncached fraction — the hit rate cancels. Cache hit rate therefore affects only the frontier billing blend, not self-hosted capacity: to model a self-hosted caching improvement, benchmark it and update the goodput inputs.

### Frontier blended cost per million tokens

```
blended/M = uncached_input_frac × input_price
          + cached_input_frac   × cached_price
          + output_frac         × output_price
```

Where fractions are derived from the workload's ISL:OSL token mix and the cache hit rate — matching how frontier APIs bill, since cached input tokens are charged at the (cheaper) cached rate rather than being free. This matters because agentic workloads with high cache hit rates (e.g., 87% for multi-turn sessions) dramatically reduce the effective frontier cost — a naive comparison using list prices overstates the frontier cost.

## Default parameters

The defaults model an agentic coding workload served by [llm-d](https://github.com/llm-d/llm-d) on 8 × IBM Cloud 8xH200 nodes (64 H200 GPUs):

| Parameter | Default | Source |
|---|---|---|
| GPU nodes | 8 (8xH200 each) | IBM Cloud |
| Cost/node/month | $11,597.84 | IBM Cloud public pricing |
| Output goodput (decode) | 6,000 tok/s | aiperf benchmark (InferenceX CC-Traces Weka, c=128) |
| Prefill goodput (incl. cached) | 100,000 tok/s | aiperf benchmark — 13,000 uncached tok/s at the 87% cache hit rate, expressed as the raw figure benchmarks report |
| Cache hit rate | 87% | Multi-turn agentic session prefix reuse |
| Avg ISL | 30,000 tokens | Weka trace dataset |
| Avg OSL | 2,000 tokens | Weka trace dataset |

> Note: prefill goodput counts **all** input tokens, cache hits included — the
> same convention as InferenceX `input_tput_tps` and AIPerf's client-side
> input throughput. The capacity model adjusts for caching internally.

## Scenario presets

The sidebar offers preset scenarios built from measured [InferenceX](https://inferencex.semianalysis.com)
agentic-traces benchmark runs on **vLLM-family serving stacks** (vLLM, Dynamo
vLLM, llm-d vLLM, MoRI vLLM) — real single runs with full provenance. Three
featured presets have quick-select buttons; the dropdown lists the full catalog.

Each preset fills the infrastructure, workload-shape, and serving-performance
fields from one benchmark run:

| Field | InferenceX source |
|---|---|
| GPU type, GPUs per node, nodes | run topology + gpu-specs `scaleUpWorldSize` |
| $/node/month | hardware catalog rental `$/GPU-hr × 730 × GPUs/node` — see note below |
| Prefill goodput (incl. cached) | `input_tput_tps` |
| Output goodput | `output_tput_tps` |
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

Demand-estimate inputs (number of users, active hours, duty cycle, working
days) are deliberately **not** touched by presets — they stay at the repo
defaults, since no benchmark can supply them.

The InferenceX API does not send CORS headers, so presets are baked into
`index.html` as a snapshot between `BEGIN/END SCENARIO_PRESETS` markers:

```sh
node scripts/refresh-presets.mjs          # preview
node scripts/refresh-presets.mjs --write  # update index.html
node scripts/refresh-presets.mjs --check  # fail if the snapshot is stale
```

The script picks, per curated model × hardware pair, the latest vLLM-family
run with the highest output throughput among runs meeting a 20 tok/s
interactivity floor. Edit the `CURATED` list in the script to change the
catalog.

## Frontier pricing snapshot

The calculator fetches live prices from OpenRouter on load. The table below is the
offline fallback baked into `index.html`, refreshed on **2026-10-26**. Prices are
USD per 1M tokens.

| Model | Input | Cached input | Output |
|---|---:|---:|---:|
| Claude Opus 5.5 | $4.00 | $0.20 | $20.00 |
| Claude Sonnet 5.5 | $2.00 | $0.10 | $10.00 |
| GPT-6.1 Sol | $2.00 | $0.10 | $10.00 |
| GPT-6.1 Terra | $1.00 | $0.05 | $5.00 |
| Gemini 4 Argon | $2.00 | $0.10 | $10.00 |
| DeepSeek V4.1 Flash 1017 | $0.15 | $0.003 | $0.60 |
| Grok 4.7 | $2.00 | $0.50 | $6.00 |
| Kimi K3.1 Pro | $2.00 | $0.20 | $10.00 |

### Refreshing pricing

The repo includes an agent skill and a small Node.js (18+) script for keeping the
snapshot current. Cached input prices keep 3 decimals (they can be sub-cent,
e.g. DeepSeek at $0.003/M); all other prices round to 2:

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
`.github/workflows/pages.yml`. See
`.claude/skills/commit-push-deploy/SKILL.md` for the commit, push, watch, and
live-site verification workflow.

## Tech stack

Single HTML file, no build step. Uses Chart.js 4.x from CDN, vanilla JavaScript, and browser `fetch()` for API calls (OpenRouter and HuggingFace support CORS; InferenceX does not, so presets are baked as a snapshot). The pricing and preset refresh scripts are maintenance tools only; they are not part of the deployed page.

## License

Apache-2.0
