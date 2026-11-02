# Self-Hosted vs Frontier API Cost Comparison

Interactive tool for comparing the economics of self-hosted open-weight model
inference against frontier API providers.

**Live**: [openshift-psap.github.io/self-hosted-llm-cost-calculator](https://openshift-psap.github.io/self-hosted-llm-cost-calculator/)

## Contents

- [What it does](#what-it-does)
- [How the calculation works](#how-the-calculation-works)
- [Worked example](#worked-example)
- [Input validation](#input-validation)
- [Assumptions and limitations](#assumptions-and-limitations)
- [Default parameters](#default-parameters)
- [System design and data provenance](#system-design-and-data-provenance)
- [Scenario presets](#scenario-presets)
- [Frontier pricing snapshot](#frontier-pricing-snapshot)
- [Deploying](#deploying)
- [Tech stack](#tech-stack)
- [Testing](#testing)
- [License](#license)

## What it does

Calculates the blended cost per million tokens for a self-hosted GPU deployment
across 1–100% utilization, and plots it against closed frontier API costs
(Claude, GPT, Gemini, Grok, Amazon Nova, Cohere) to show breakeven points.

Key features:

- **Live frontier pricing** fetched from the [OpenRouter API](https://openrouter.ai/api/v1/models) — no API key required
- **Built-in pricing snapshot** for offline use and as a fallback when the API is unavailable
- **Scenario presets in the header** — measured operating points from [InferenceX](https://inferencex.semianalysis.com) agentic-traces benchmark runs (model × hardware, with provenance links), quick-select buttons for the top three, and the page opens on GLM-5.2 on B200
- **At-a-glance verdict** — the self-hosted $/M at your demand, the cheapest enabled API, monthly fleet vs API bills, utilization, and a plain-language conclusion are summarized above the chart
- **Pricing beside the results** — frontier API pricing sits in a right-hand rail next to the chart on desktop, so you never scroll the input sidebar to check a price
- **Optional log-scale chart** — spreads the long low-utilization tail and the $0.1–$2 comparison band across decades; linear remains the default
- **HuggingFace model search** for labeling the self-hosted model
- **Workload-aware blended cost** — accounts for the ISL:OSL token mix and prompt cache hit rate, which heavily influence frontier API costs for agentic workloads
- **Measured capacity** — uses the fleet's measured total goodput directly, without extrapolating prefill/decode performance
- **Single self-hosted cost** — unlike frontier APIs that charge differently per token type, self-hosted infrastructure has one fixed cost regardless of whether tokens are input, cached, or output

## How the calculation works

Everything runs locally in the browser. The calculator is a pure
input-to-output function: no server, no account, no telemetry. The only
network requests are the optional OpenRouter price refresh and on-demand
HuggingFace model search; preset data is baked into the page.

The calculation proceeds in six steps.

### 1. Fleet size and annual TCO

```
total GPUs   = nodes × GPUs per node
monthly cost = nodes × $/node/month
annual TCO   = monthly cost × 12
```

TCO here is the fully loaded rental cost of the fleet. There is no separate
power, space, networking, storage, or staffing line item, and no residual
hardware value; the node rate is assumed to cover the deployment. See
[Assumptions and limitations](#assumptions-and-limitations).

### 2. Measured capacity and self-hosted $/M

Capacity is the fleet's **measured total token throughput** — input + output
tokens combined, cache hits included — under the workload's latency SLOs. This
is exactly what benchmarks report (InferenceX `total_tput_tps`, AIPerf
`total_token_throughput`), so there is no derivation: the number you measured
is the number the calculator uses.

```
seconds per year   = 365.25 × 24 × 3600 = 31,557,600
annual tokens      = total goodput (tok/s) × seconds per year
cost/M at 100%     = annual TCO / (annual tokens / 1,000,000)
                   = annual TCO × 1,000,000 / annual tokens
```

At utilization `U` percent:

```
cost/M = cost at 100% / (U / 100)
```

The cost is the same for all token types because every token — whether prefill
(cached or uncached) or decode — consumes compute from the same fixed hardware
pool. A single flat $/M is therefore the correct self-hosted figure; splitting
it by token type would double-count capacity.

Goodput is workload-specific: it was measured serving a particular mix
(ISL:OSL, cache behavior) at a particular latency target. If you change the
workload, re-benchmark rather than extrapolate — the calculator deliberately
does not infer capacity changes from mix edits.

### 3. Workload mix and frontier blended $/M

Frontier APIs bill input, cached input, and output at different rates, so the
calculator converts the workload into billing fractions. The full prompt,
including cache hits, is billed on every call, so the fractions derive from
**Avg ISL / Avg OSL**, not from output goodput:

```
tokens per call    = Avg ISL + Avg OSL
input fraction     = Avg ISL / tokens per call
output fraction    = Avg OSL / tokens per call
cache hit fraction = cache hit rate / 100

cached input fraction   = input fraction × cache hit fraction
uncached input fraction = input fraction × (1 − cache hit fraction)
```

Then, per frontier model:

```
blended/M = uncached input fraction × input price
          + cached input fraction   × cached price
          + output fraction         × output price
```

Cached input tokens are charged at the (cheaper) cached rate rather than being
free. This matters because agentic workloads with high cache hit rates
(e.g., 92.8% for the default GLM-5.2 run) dramatically reduce the effective
frontier cost — a naive comparison using list prices overstates the frontier
cost.

The cache hit rate is a **billing-only** knob. It changes the API blend; it
does not change measured self-hosted capacity. The benchmark's goodput already
includes whatever cache behavior was measured.

### 4. Demand and average utilization

Demand is built bottom-up from explicit usage assumptions, not inferred from
streaming speed:

```
calls per user per day = sessions/user/day × model calls/session
tokens per user/month  = calls per user per day × working days/month × tokens per call
monthly demand         = users × tokens per user/month

seconds per month      = seconds per year / 12
monthly capacity       = total goodput × seconds per month
average utilization    = monthly demand / monthly capacity × 100
```

A session may contain multiple tasks; model calls include both the main agent
and its subagents. Full prompt tokens, including cached input, are counted on
every call.

Demand does **not** depend on output tok/s per user. Streaming faster does not
create more work. The concurrency and output-speed inputs are recorded from the
benchmark run for context but do not enter the cost, demand, or capacity
equations.

### 5. Cost at demand, monthly bills, and breakeven

Self-hosted cost per consumed token at the estimated demand is the monthly
fleet bill divided by the tokens actually consumed that month:

```
self-hosted at demand = monthly fleet cost / (monthly demand / 1,000,000)
```

This is mathematically the same as `cost at 100% / utilization`, but computing
it from actual demand makes the "bill ÷ tokens served" meaning explicit. It is
**N/A** when demand is zero or when demand exceeds monthly capacity: an
overloaded fleet cannot serve the demand, so a per-token cost would be
fictional.

Each frontier model's monthly API bill at the same demand is:

```
monthly API bill = blended/M × monthly demand / 1,000,000
```

The API bill therefore scales linearly with demand, while the blended $/M is
demand-independent. The breakeven utilization against a model is:

```
breakeven = cost/M at 100% / blended/M × 100
```

Below that utilization, the API is cheaper on a per-token basis; above it,
self-hosting is cheaper. A breakeven above 100% means the API is cheaper at any
feasible utilization for this fleet. If a model's blended price is zero, the
breakeven is infinite and the table shows `>100%`.

When demand exceeds capacity, the utilization readout turns red and says so;
scenario cost is **N/A — insufficient capacity**, while API bills still reflect
the offered demand. A chart marker at 100% then identifies the capacity limit,
not a feasible scenario. With zero goodput, utilization and self-hosted $/M are
N/A; API bills still reflect the offered demand.

### 6. Chart and display

- The self-hosted curve is evaluated at integer utilizations from 1% to 100%:
  `cost at 100% / (u / 100)`.
- The x-axis is linear from 1–100% with ticks every 10 points.
- The y-axis auto-scales to
  `max(self-hosted cost at 1% × 1.05, highest enabled API blended price × 1.2)`,
  with no fixed floor or cap. The optional log-scale checkbox pads the range to
  whole decades and labels ticks compactly so the low-utilization spike does
  not swamp the comparison band.
- The breakeven table shows the blended $/M, breakeven percentage, and monthly
  API bill for every enabled model. Percentages above 100% display `>100%`.
- Below 640px the chart hides its legend and breakeven labels (the table
  retains the numbers) to avoid collisions.
- All displayed values cap at 2 decimal places, **except cached input prices,
  which keep 3** because they can be sub-cent (e.g. $0.003/M). Numbers are
  locale-formatted; tests run under a German locale to catch
  locale-dependent formatting assumptions.

Numerical results remain usable if the Chart.js CDN is unavailable: the chart
is hidden with a status note, and the breakeven table and verdict still render.

## Worked example

Using the default GLM-5.2 B200 preset and its default demand assumptions:

| Quantity | Value |
|---|---:|
| Fleet | 1 node × 8 B200 = 8 GPUs |
| Monthly fleet cost | $21,608 |
| Annual TCO | $259,296 |
| Total goodput | 160,111 tok/s |
| Annual capacity | 5,052.7B tokens |
| Self-hosted at 100% | $0.0513/M |
| Tokens per call | 155,205 ISL + 997 OSL = 156,202 |
| Input / output fractions | 99.36% / 0.64% |
| Cache hit rate | 92.8% |
| Uncached / cached input fractions | 7.15% / 92.21% |
| Calls/user/day | 1 session × 251.47 calls = 251.47 |
| Monthly demand (200 users, 22 days) | 172.83B tokens |
| Monthly capacity | 421.06B tokens |
| Average utilization | 41.0% |
| Self-hosted at demand | $0.1250/M → **$0.13/M** |
| Cheapest enabled API (GPT-6.1 Terra) | 7.15% × $1.00 + 92.21% × $0.050 + 0.64% × $5.00 = **$0.15/M** |
| Terra breakeven | 34.3% utilization |
| Terra monthly bill at this demand | $25,848 |

At 41% average utilization this deployment is above the Terra breakeven, so
self-hosting is cheaper per token; the fleet bill is also lower than the API
bill at the same demand.

## Input validation

`calculateScenario` validates every numeric input in the inline script itself,
independently of the HTML `min`/`max`/`step` attributes. Empty fields are
invalid, not zero. Invalid scenarios clear numerical results and highlight the
offending fields; they are never silently coerced.

| Input | Rule |
|---|---|
| GPUs per node | whole number, 1–144 |
| Number of nodes | whole number, 1–128 |
| $/node/month | finite, ≥ 0 |
| Concurrent sessions | whole number, ≥ 1 |
| Total goodput | finite, ≥ 0 |
| Output tok/s per user | finite, ≥ 0 |
| Cache hit rate | finite, 0–100 |
| Avg ISL | finite, ≥ 1 |
| Avg OSL | finite, ≥ 1 |
| Number of users | finite, ≥ 0 |
| Sessions/user/day | finite, ≥ 0 |
| Calls/session | finite, ≥ 0 |
| Working days/month | whole number, 1–31 |
| Frontier prices | each finite, ≥ 0 |

Spinner step sizes are convenience values, not validation constraints:
benchmark measurements need not be multiples of a step. After validation, the
calculator also rejects results that overflow to non-finite numbers.

## Assumptions and limitations

### Capacity and performance

- **Goodput is measured, not modelled.** The calculator does not derive
  capacity from prefill/decode split, batch size, concurrency, model size, or
  hardware specs. `total goodput` is used directly. It represents one
  measured workload at one latency SLO.
- **Changing the workload requires a new benchmark.** Editing ISL, OSL, or
  cache hit rate changes the frontier billing blend but not measured
  self-hosted throughput. This is deliberate: extrapolating capacity across
  workload shapes is not reliable.
- **Cache hit rate does not create a speedup here.** It affects API billing
  only; the measured goodput already reflects the run's real cache behavior.
- **Concurrency and output tok/s per user are descriptive.** They are carried
  from the preset and displayed in the provenance caption, but they do not
  affect cost, demand, or capacity.
- **Utilization is a calendar-month average.** The numerator counts working
  days of usage; the denominator is full calendar-month capacity, including
  nights and weekends. It is not a peak-concurrency or queueing analysis and
  does not prove the SLO holds at that average load.

### Cost scope

- **Rental basis.** Node costs come from InferenceX's rental ("external")
  $/GPU-hour and are converted with 730 hours/month. Owned hardware, reserved
  capacity, and spot pricing will differ.
- **No separate infrastructure line items.** TCO is
  `nodes × $/node/month × 12`; it excludes power contracts, data-center space,
  networking, storage, staffing, software licenses, taxes, and egress unless
  they are already baked into the node rate.
- **One self-hosted $/M for every token type.** The model assumes a shared
  fixed-cost pool. It does not model token-type-specific marginal costs.
- **Straight-line annualization.** There is no depreciation curve, refresh
  cycle, utilization ramp, or financing cost.

### Demand

- **Demand is an assumption, not a measurement.** Users, sessions/user/day,
  and working days are user inputs. Sessions/user/day defaults to 1.
- **Calls/session is trace-derived but corpus-specific.** The 251.47 and 173.70
  references are means from selected Weka coding-agent traces. They favour
  longer sessions and do not establish tasks or sessions per user per day for
  another organization.
- **Every call carries the full prompt mix.** Demand counts
  `calls × (ISL + OSL)`, including cached input, because APIs bill the full
  prompt. It does not model retries, failed calls, tool execution, or tokens
  outside the model API.
- **No growth or seasonality.** Demand is a single steady monthly rate.

### Frontier comparison

- **List prices only.** Prices are OpenRouter list prices per 1M tokens. Batch
  discounts, committed-use discounts, provisioned throughput, long-context
  surcharges, caching TTL rules, and free tiers are not modelled.
- **Closed APIs only.** Open-weight models (DeepSeek, Kimi, GLM, Qwen, ...) are
  excluded from the API side — self-hosting them is exactly what this
  calculator evaluates.
- **Cost only, not capability.** The tool does not compare model quality,
  latency, context limits, tool use, safety behavior, rate limits, or
  availability. A cheaper model is not necessarily an equivalent substitute.
- **Snapshot staleness.** The baked prices and presets are point-in-time
  snapshots. The app refreshes prices live when OpenRouter is reachable, but
  presets are only as current as the last refresh script run.

## Default parameters

The page opens on the measured GLM-5.2 B200 operating point rather than an
illustrative custom deployment:

| Parameter | Default | Source |
|---|---|---|
| GPU nodes | 1 node × 8 B200 | InferenceX run topology |
| Cost/node/month | $21,608 | InferenceX rental $3.70/GPU-hr × 730 h × 8 GPUs |
| Total goodput | 160,111 tok/s | InferenceX `total_tput_tps` (measured, input + output) |
| Cache hit rate | 92.8% | `server_gpu_cache_hit_rate` from the same run |
| Avg ISL | 155,205 tokens | `mean_input_tokens` from the same run |
| Avg OSL | 997 tokens | `mean_output_tokens_actual` from the same run |
| Output tok/s per user | 98.3 | `median_intvty` from the same run |
| Concurrency | 32 | run `conc` |

Demand keeps its usage assumptions (200 users, one session/user/day, 251.47
model calls/session, 22 working days) — presets never change them.

> Note: total goodput counts **all** tokens — input (cache hits included) plus
> output — the same convention as InferenceX `total_tput_tps` and AIPerf's
> total token throughput.

## System design and data provenance

The deployed artifact is a single static `index.html`. All state lives in the
page; the refresh scripts are maintenance tools that edit marker-delimited
blocks in that file.

```
                 build / refresh time                     browser runtime
┌──────────────────────────────────────────┐   ┌──────────────────────────────┐
│ scripts/refresh-pricing.mjs              │   │ parse baked snapshots        │
│   OpenRouter /api/v1/models              │──▶│ render defaults immediately  │
│   → FRONTIER_MODELS snapshot             │   │ fetch OpenRouter (8s timeout)│
├──────────────────────────────────────────┤   │   merge live prices          │
│ scripts/refresh-presets.mjs              │   │   preserve edits/selections  │
│   InferenceX /views/options              │   │ calculate + chart locally    │
│   InferenceX /views/gpu-specs            │──▶│                              │
│   InferenceX /benchmarks?model=…         │   │ HuggingFace search (on demand│
│   → SCENARIO_PRESETS snapshot            │   │   label only)                │
└──────────────────────────────────────────┘   └──────────────────────────────┘
                    │                                        │
                    └──────── committed to git ──────────────┘
                                      │
                             GitHub Pages (index.html)
```

### Frontier API pricing — OpenRouter

**Source:** `GET https://openrouter.ai/api/v1/models`, no authentication.
OpenRouter sends CORS headers, so the page can refresh prices directly.

At load time the page:

1. Renders the baked `FRONTIER_MODELS` snapshot immediately (no blank first
   paint).
2. Fetches live prices with an 8-second timeout.
3. Matches each snapshot model by OpenRouter model `id`.
4. For each model with usable live input and output prices, replaces all three
   prices. If `input_cache_read` is missing, the live input price is used as
   the cached price.
5. If a model's live input or output price is missing or unusable, it retains
   its complete baked snapshot price triple rather than mixing sources.
6. Preserves the user's checkbox selections and any manually edited prices.

Prices are per-token values from the API multiplied by 1,000,000. Cached input
prices keep 3 decimals; all others round to 2. The pricing status line reports
snapshot fallback, partial snapshot use, and missing cache-price fallbacks.

**Baked snapshot:** The `FRONTIER_MODELS` array between
`// BEGIN FRONTIER_PRICING` and `// END FRONTIER_PRICING` is generated by
`scripts/refresh-pricing.mjs`. For each family in `FAMILIES`, the script
selects the newest matching OpenRouter model by the API's `created` timestamp,
so version bumps are picked up automatically. Patterns are kept narrow to
exclude batch, free, and experimental variants, and the family list is
provider-contiguous so the UI can group rows by provider in order. If a family
has no match or incomplete pricing, the refresh fails loudly rather than
silently dropping a model.

The current list is intentionally limited to closed frontier providers:
Anthropic (Opus/Sonnet/Fable/Haiku), OpenAI (Sol/Terra/Sol Pro), Google
(Argon/Flash), xAI Grok, Amazon Nova Premier, and Cohere Command A+.

### Scenario presets — InferenceX

**Sources:**

- `GET https://inferencex.semianalysis.com/api/v1/views/options` — hardware
  catalog, framework families, rental `costPerHour.r`
- `GET https://inferencex.semianalysis.com/api/v1/views/gpu-specs` — chip
  topology (`scaleUpWorldSize`)
- `GET https://inferencex.semianalysis.com/api/v1/benchmarks?model=<display name>`
  — benchmark rows

The InferenceX API does **not** send CORS headers, so the browser cannot query
it. Presets are therefore baked into `index.html` between
`// BEGIN SCENARIO_PRESETS` and `// END SCENARIO_PRESETS`.

For each curated `(model, hardware)` pair in `CURATED`, the refresh script:

1. Keeps only `agentic_traces` runs on vLLM- or SGLang-family stacks, with an
   integer concurrency, positive total goodput / ISL / OSL, median
   interactivity at or above the 20 tok/s eligibility floor, a finite measured
   cache hit rate in `[0, 1]`, and a valid GPU count.
2. Builds that configuration's Pareto frontier over
   `(total_tput_tps, median_intvty)`. A point is dropped if another point
   matches or beats it on both axes and strictly beats it on at least one.
3. Picks the **highest-throughput frontier point whose median interactivity is
   at least 35 tok/s** — the same default InferenceX's own calculator uses. If
   no frontier point meets the target, it falls back to the most interactive
   frontier point. Date is only a tiebreak; it never prefers a newer dominated
   point.
4. Converts the row into calculator fields.

Field mapping:

| Calculator input | InferenceX source |
|---|---|
| GPU type | hardware label from `/views/options` |
| GPUs per node, nodes | run topology and `scaleUpWorldSize` |
| $/node/month | `costPerHour.r` (rental basis) × 730 × GPUs/node |
| Total goodput | `total_tput_tps` |
| Cache hit rate | `server_gpu_cache_hit_rate` (measured, same run) |
| Avg ISL / OSL | `mean_input_tokens` / `mean_output_tokens_actual` |
| Output tok/s per user | `median_intvty` |
| Concurrency | run `conc` |

**Topology.** Total GPUs are `num_prefill_gpu + num_decode_gpu` for
disaggregated rows, and `num_decode_gpu` (or prefill) for aggregate rows. Node
size is the chip catalog's `scaleUpWorldSize`. If the catalog lacks it, an
explicit `NVLnn` token in the hardware label is used. TPU7x has an explicit
eight-chip accounting unit until catalog coverage exists. Unknown hardware
fails the refresh rather than silently assuming an eight-GPU node. If total
GPUs divide evenly by node size, the preset uses that many full nodes;
otherwise the run becomes one node of its own size, so fleet cost still equals
`rental rate × 730 × total GPUs`.

**Rounding.** ISL, OSL, and total goodput are rounded to integers; output
tok/s/user and cache hit rate keep one decimal; node cost keeps two.

**Presets never touch demand.** Users, sessions/user/day, calls/session, and
working days retain the user's current values. Editing a benchmark field
switches the scenario to Custom and clears its measured-run attribution;
editing demand inputs retains the preset attribution.

### Demand references — Weka coding-agent traces

The calls-per-session defaults come from InferenceX's public dataset cards:

- [cc-traces-weka-062126](https://huggingface.co/datasets/semianalysisai/cc-traces-weka-062126)
  — 98,827 model calls across 393 sessions → `98,827 / 393 = 251.47`
- [cc-traces-weka-062126-256k](https://huggingface.co/datasets/semianalysisai/cc-traces-weka-062126-256k)
  — 68,266 model calls across 393 sessions → `68,266 / 393 = 173.70`

The equivalent published fields are
`summary.mainTurns + summary.subagentTurns` over `conversation_count`, or
`summary.meanRequestsPerConversation`. Use the mean for aggregate-volume
estimates, not the median. Subagent groups are not separate model calls. These
are selected, longer coding sessions, not measurements of tasks or sessions per
user per day; a session can contain many tasks.

### Model label — HuggingFace

`GET https://huggingface.co/api/models?search=<query>&pipeline_tag=text-generation&sort=downloads&direction=-1&limit=15`
is used only to label the self-hosted model. It supplies no pricing or capacity
data. Search is debounced by 300 ms, requires at least two characters, and
ignores stale responses.

### Snapshots and freshness

Both snapshots are plain JavaScript arrays in `index.html`, so the page has no
runtime dependency on either data source. The refresh scripts support three
modes:

```sh
node scripts/refresh-pricing.mjs            # preview (dry run)
node scripts/refresh-pricing.mjs --write    # update index.html
node scripts/refresh-pricing.mjs --check    # exit 1 if the snapshot is stale

node scripts/refresh-presets.mjs            # preview (dry run)
node scripts/refresh-presets.mjs --write    # update index.html
node scripts/refresh-presets.mjs --check    # exit 1 if the snapshot is stale
```

`--check` regenerates the expected block from the live APIs, normalizes the
snapshot date, and compares it with the committed block. The CI workflow runs
both checks on pushes to `main` and on pull requests, so a snapshot cannot
silently drift from its source. Because these are freshness checks, they verify
the committed block matches current upstream data; they are not an independent
verification of the selection algorithm (the fixture-based refresh tests cover
that).

## Scenario presets

The header offers preset scenarios built from measured
[InferenceX](https://inferencex.semianalysis.com) agentic-traces benchmark runs
on vLLM- and SGLang-family serving stacks — real single runs with full
provenance. Preset names carry the workload shape (ISL:OSL mix and measured
cache hit rate); the serving framework is not shown in the UI (it remains in
the baked data and the linked run). Featured presets get quick-select buttons
(up to three); the dropdown lists the full catalog.

Each preset fills the infrastructure, workload-shape, and serving-performance
fields from one benchmark run. The provenance caption shows precision,
disaggregation, concurrency, per-user interactivity, run date, a link to the
run, and the node-cost derivation. The baked snapshot currently contains 23
presets (snapshot date 2026-11-02).

> **Node cost source:** the rental $/GPU-hour rates come from the InferenceX
> hardware catalog (`GET /api/v1/views/options`, `costPerHour.r` — the rental
> "external" cost basis), browsable at
> [inferencex.semianalysis.com/chips](https://inferencex.semianalysis.com/chips).
> For example, H200 at $2.90/GPU-hr rental × 730 h × 8 GPUs/node = $16,936 per
> node-month. The derivation is shown in each preset's provenance caption.

Editing any benchmark-derived field switches the scenario to Custom. Demand
inputs are deliberately untouched by presets.

## Frontier pricing snapshot

The calculator renders snapshot prices immediately, then fetches live prices
from OpenRouter with an eight-second timeout. The visible pricing status reports
snapshot fallback and missing cached prices. For a live model without a
cached-input price, both the app and refresh script use its input price. Missing
input/output prices retain the model's complete snapshot price triple in the app;
the maintenance script rejects incomplete pricing. User price edits are preserved
when the background request completes.

The table below is the offline fallback baked into `index.html`, refreshed on
**2026-10-31**. Prices are USD per 1M tokens. Only closed frontier APIs are
listed — open-weight models (DeepSeek, Kimi, GLM, Qwen, ...) are excluded from
the comparison, since self-hosting them is exactly what this calculator
evaluates.

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

To add or remove a model family, edit `FAMILIES` in
`scripts/refresh-pricing.mjs`; see
`.claude/skills/refresh-frontier-pricing/SKILL.md` for the full workflow.

## Deploying

Pushing to `main` triggers the GitHub Pages workflow in
`.github/workflows/pages.yml`. Pull requests run the same validation.
Deployment requires successful calculation/DOM tests, refresh-algorithm tests,
browser tests, and both live snapshot checks. Only `index.html` is published.

A successful `git push` is not proof of deployment: the matching Pages run must
finish with `success`, and the live page should return HTTP 200 and match the
committed HTML. See `.claude/skills/commit-push-deploy/SKILL.md` for the
preflight, commit, watch, and live-site verification workflow.

## Tech stack

Single HTML file, no build step. Uses Chart.js 4.x and the Archivo / IBM Plex
Mono webfonts from CDNs, vanilla JavaScript, and browser `fetch()` for API
calls. OpenRouter and HuggingFace support CORS; InferenceX does not, so presets
are baked as a snapshot. The pricing and preset refresh scripts are maintenance
tools only; they are not part of the deployed page.

Print support: the Print button regenerates a report from current inputs and
pricing status, captures the chart after synchronous rendering, and includes
the validation state. Native browser printing triggers the same `beforeprint`
regeneration.

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

Important invariants covered by the tests:

- Doubling usage doubles demand and API bills without changing blended $/M or
  breakeven utilization.
- Changing streaming speed leaves demand unchanged.
- Changing capacity alone leaves API bills unchanged.
- Cache changes affect billing, not demand or measured self-hosted capacity.
- Presets preserve edited demand inputs.
- Zero demand, zero capacity, and overloaded demand are distinct states.

For an installed local Chrome, use
`CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser`.
Locale-independent assertions are also checked in CI with `LANG=de_DE.UTF-8`.

## License

Apache-2.0
