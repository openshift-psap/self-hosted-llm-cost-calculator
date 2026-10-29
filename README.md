# Self-Hosted LLM Cost Calculator

Interactive tool for comparing the economics of self-hosted open-weight model inference against frontier API providers.

**Live**: [openshift-psap.github.io/self-hosted-llm-cost-calculator](https://openshift-psap.github.io/self-hosted-llm-cost-calculator/)

## What it does

Calculates the blended cost per million tokens for a self-hosted GPU deployment across 1–100% utilization, and plots it against frontier API costs (Claude, GPT, Gemini, DeepSeek, Grok, Kimi) to show breakeven points.

Key features:
- **Live frontier pricing** fetched from the [OpenRouter API](https://openrouter.ai/api/v1/models) — no API key required
- **Built-in pricing snapshot** for offline use and as a fallback when the API is unavailable
- **HuggingFace model search** for labeling the self-hosted model
- **Workload-aware blended cost** — accounts for the ISL:OSL token mix and prompt cache hit rate, which heavily influence frontier API costs for agentic workloads
- **Two-resource capacity model** — decode and uncached-prefill goodput are separate capacity limits; sustained throughput is whichever the workload mix binds first, so cache hit rate affects servable capacity, not just API billing
- **Single self-hosted cost** — unlike frontier APIs that charge differently per token type, self-hosted infrastructure has one fixed cost regardless of whether tokens are input, cached, or output

## Cost methodology

### Self-hosted cost per million tokens

Decode and uncached prefill are modeled as separate serving resources (as in a disaggregated stack). Cached prefix reads are treated as near-free: the serving engine skips them, so they consume neither prefill nor decode budget. Token fractions come from the workload's ISL:OSL mix and cache hit rate.

```
decode_limit   = output_goodput_tps / output_frac
prefill_limit  = uncached_prefill_goodput_tps / uncached_input_frac
sustained_tps  = min(decode_limit, prefill_limit)

cost/M = Annual TCO / (sustained_tps × seconds_per_year / 1e6)
```

At utilization U%: `cost/M = cost_at_100% / (U / 100)`

The cost is the same for all token types because every token — whether prefill (cached or uncached) or decode — consumes compute from the same fixed hardware pool.

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
| Uncached prefill goodput | 13,000 tok/s | aiperf benchmark — server-computed prefill tokens; cached prefix reads excluded |
| Cache hit rate | 87% | Multi-turn agentic session prefix reuse |
| Avg ISL | 30,000 tokens | Weka trace dataset |
| Avg OSL | 2,000 tokens | Weka trace dataset |

> Note: the prefill goodput figure is assumed to count only tokens the serving
> engine actually computed (cached prefixes skipped). If your benchmark reports
> input throughput as all input tokens delivered (AIPerf's client-side
> `total_isl / duration` does), derive the uncached figure first — e.g.
> `raw_input_tps × (1 − cache_hit_rate)` — before entering it.

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

Single HTML file, no build step. Uses Chart.js 4.x from CDN, vanilla JavaScript, and browser `fetch()` for API calls (both OpenRouter and HuggingFace support CORS). The pricing refresh script is a maintenance tool only; it is not part of the deployed page.

## License

Apache-2.0
