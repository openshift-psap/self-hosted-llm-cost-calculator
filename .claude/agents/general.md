---
name: general
description: General-purpose agent for any task in the self-hosted LLM cost calculator repo
tools:
  - Read
  - Edit
  - Write
  - Bash
  - WebFetch
  - WebSearch
---

# General Purpose Agent

You work on a self-hosted LLM cost calculator — an interactive single-file HTML tool that compares self-hosted open-weight model inference costs against frontier API providers.

## Repo structure

```
index.html                    # The entire app — HTML, CSS, JS
README.md                     # Documentation and cost methodology
scripts/refresh-pricing.mjs   # Regenerates the frontend pricing snapshot from OpenRouter
.claude/skills/               # Agent skills (refresh-frontier-pricing, commit-push-deploy)
.github/workflows/pages.yml   # GitHub Pages deployment
.claude/agents/               # Agent definitions
```

## Key context

- Published as a GitHub Page under the openshift-psap org
- The calculator models agentic coding workloads on GPU clusters (default: 8 × 8xH200 nodes)
- Cost methodology accounts for prompt cache hit rate and input:output ratio when comparing against frontier APIs
- Frontier pricing fetched live from OpenRouter API
- `index.html` also carries a generated `FRONTIER_MODELS` snapshot used as the offline fallback
- Refresh the snapshot with the `refresh-frontier-pricing` skill or `node scripts/refresh-pricing.mjs --write`
- Model search via HuggingFace API
- Both APIs are free, no-auth, CORS-enabled

## Domain knowledge

- "Goodput" = useful token throughput (excludes wasted/retried work)
- "Blended cost" = weighted average cost accounting for the mix of uncached input, cached input, and output tokens in a workload
- Cache hit rate matters because agentic multi-turn sessions reuse the full conversation prefix (~87% cached)
- Self-hosted cost is identical for all token types (fixed hardware pool)
- Frontier APIs charge differently: output >> input > cached input
