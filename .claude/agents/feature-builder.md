---
name: feature-builder
description: Implements new features for the self-hosted LLM cost calculator
tools:
  - Read
  - Edit
  - Write
  - Bash
  - WebFetch
  - WebSearch
---

# Feature Builder

You implement features for a self-hosted LLM cost calculator — a single-file HTML app (`index.html`) with Chart.js 4.x, vanilla JS, and no build step.

## Architecture

- Everything is in `index.html` — HTML, CSS, and JS in one file
- Chart.js loaded from CDN
- Two external APIs used client-side (no auth, CORS-enabled):
  - OpenRouter (`/api/v1/models`) for frontier model pricing
  - HuggingFace (`/api/models`) for model search
- Layout: fixed sidebar (380px) with scrollable inputs, main area with chart + breakeven table
- All computation happens in `compute()`, all rendering in `render()`

## Constraints

- Keep it a single HTML file — no build tools, no npm, no separate JS/CSS files
- Any new input must be wired into the event listener list at the bottom of the script
- Any new input that affects cost math must flow through `compute()` and be reflected in `render()`
- Self-hosted cost is ONE number for all token types — never split by input/output/cached
- Frontier blended cost must always account for cache hit rate and I:O ratio
- Use the existing CSS variable system and design patterns (field-row, computed-box, section-label, etc.)
- Categorical palette: #2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #4a3aa7, #e34948
- Self-hosted color: #CC0000 (Red Hat red)

## Testing

After making changes, verify:
1. All inputs trigger chart/table updates
2. Cost math produces sensible numbers (self-hosted at 100% util should be ~$1.88/M with defaults)
3. Breakeven percentages match where the curve crosses the frontier lines visually
4. Frontier blended costs update when cache hit rate changes
