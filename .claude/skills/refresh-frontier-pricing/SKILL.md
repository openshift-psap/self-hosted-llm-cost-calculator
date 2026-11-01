---
name: Refresh Frontier Pricing
description: Refresh the frontier model list and prices in index.html from the OpenRouter API. Use when pricing is stale, a new frontier model ships, or the user asks to update the comparison models.
---

# Refresh Frontier Pricing

The calculator fetches prices live from OpenRouter at page load, but `index.html`
also carries a generated snapshot that acts as the offline fallback. This skill
keeps that snapshot and the list of comparison models current.

## Quick path

```sh
# 1. Preview the new snapshot (no file changes)
node scripts/refresh-pricing.mjs

# 2. Apply it
node scripts/refresh-pricing.mjs --write

# 3. Verify the generated block is current
node scripts/refresh-pricing.mjs --check

# 4. Review the result
git diff -- index.html
```

Then update the pricing snapshot table in `README.md` (see below) and commit
both files together. A typical commit message:

```text
Refresh frontier pricing snapshot (YYYY-MM-DD)
```

## How the script works

`scripts/refresh-pricing.mjs`:

1. Fetches `https://openrouter.ai/api/v1/models` (no API key).
2. For every family in its `FAMILIES` array, selects the newest matching model
   by OpenRouter's `created` timestamp. Batch (`:batch`), free, and experimental
   variants are excluded by the family patterns.
3. Converts per-token prices to USD per 1M tokens. `input_cache_read` is the
   cached-input price; if a model has no cache price, the input price is used.
4. Rewrites only the block between `// BEGIN FRONTIER_PRICING` and
   `// END FRONTIER_PRICING` in `index.html`.

The block defines `FRONTIER_MODELS`; the app derives `DEFAULT_CHECKED` from
it and uses the same entries as the offline fallback.
`checked: true` controls which models are plotted by default.

Input and output prices round to 2 decimal places; cached-input prices keep
3 because sub-cent values are meaningful. Preserve genuine zero prices.

`--check` ignores the snapshot date, so it fails only when the selected models
or prices actually change. This makes it safe to use in CI.

## Adding, removing, or replacing a model

Edit `FAMILIES` in `scripts/refresh-pricing.mjs`. Each entry needs:

| Field | Meaning |
|---|---|
| `label` | Human-readable family name used in script output |
| `pattern` | Regex matched against the OpenRouter model id |
| `checked` | Whether the model is plotted by default |

Keep patterns narrow. For example, `^openai\/gpt-[\d.]+-sol$` tracks the newest
Sol without accidentally matching `-pro`, `:batch`, or unrelated OpenAI models.
If a provider renames a family, the script fails with the unmatched pattern so
you can update it deliberately rather than silently dropping a model.

Use families that make sense for an agentic coding comparison: current
flagship and workhorse **closed API** models from the major providers. Keep
the families provider-contiguous for the grouped accordion UI. Open-weight
models belong on the self-hosted side, not in this comparison list. Avoid
embedding, image, audio, router, and batch-only models, and avoid adding a
model whose price OpenRouter does not expose.

## Keep pricing separate from demand

The blended API $/M uses full-prompt ISL/OSL weights, splitting input into
uncached and cached tokens at the assumed hit rate. The monthly API bill is
`blended/M × monthlyDemand / 1e6`; it must not use a fixed 25% utilization.
Changing demand leaves the blended rate and horizontal API chart lines
unchanged. Changing prices can change those rates and breakeven utilization.

Pricing refreshes must not change sessions/user/day, calls/session, Weka
reference values, benchmark throughput, or the scenario preset snapshot.
Cache hit rate changes billing only; do not infer self-hosted capacity gains.

## Manual fallback

If the API cannot be reached, edit the generated block in `index.html` by hand
using the current prices from the provider's pricing page, then run:

```sh
node scripts/refresh-pricing.mjs --check
```

If the API is still unreachable, `--check` cannot verify freshness; do not
report it as passed or deploy while a required preflight check is failing.
If it reports stale, review the API-backed output and resolve the difference
before deploying rather than bypassing the check.

## README snapshot table

The README's **Frontier pricing snapshot** table is human-facing documentation,
not read by the app. Update it to match the script output, including the
snapshot date. Keep the order and display names aligned with `FRONTIER_MODELS`.

## Validation

After writing:

1. `node scripts/refresh-pricing.mjs --check` exits 0 and the README matches.
2. `node scripts/refresh-presets.mjs --check` exits 0.
3. `node scripts/test-calculations.mjs` passes. If intentional rate-card changes
   alter a hardcoded dollar expectation, recalculate that expectation from the
   new snapshot; preserve the demand-independence and billing invariants.
4. When a browser is available, `index.html` opens without console errors and
   the sidebar shows finite, non-negative input, cached, and output prices.
   A genuine zero cached-input price is valid, not a missing-value signal.
5. Changing cache hit rate updates the blended prices for models with a
   distinct cached-input rate; changing demand updates monthly bills without
   changing blended $/M.
6. The breakeven table and chart render, and checked models stay reasonable
   relative to the self-hosted curve.

Use the commit-push-deploy skill for shipping: stage only intended files,
watch the Pages workflow for the pushed SHA, and verify the live HTML.
