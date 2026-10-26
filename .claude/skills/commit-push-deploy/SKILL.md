---
name: Commit, Push, Deploy
description: Validate, commit, push, and deploy changes to the self-hosted LLM cost calculator GitHub Pages site. Use when the user asks to ship a change, deploy the calculator, or verify a deployment.
---

# Commit, Push, Deploy

This repo deploys automatically: a push to `main` triggers
`.github/workflows/pages.yml`, which publishes the repository root with GitHub
Pages. There is no build step.

## 1. Preflight

```sh
git status --short
git diff
git diff --check
node scripts/refresh-pricing.mjs --check   # pricing snapshot must not be stale
```

If `index.html` changed, also check the inline JavaScript:

```sh
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];fs.writeFileSync('/tmp/opencode/inline.js',m.at(-1)[1]);"
node --check /tmp/opencode/inline.js
```

Confirm:

- The diff contains only intended changes.
- No secrets, tokens, local paths, or generated artifacts are staged.
- `README.md` and the pricing snapshot agree when pricing changed.

## 2. Commit

Stage explicitly rather than using `git add -A`:

```sh
git add index.html README.md scripts/ .claude/
git commit -m "<area>: <short imperative summary>"
```

Use a concise subject line and, for larger changes, a body explaining the why.
Examples:

```text
Refresh frontier pricing snapshot (2026-10-26)
Add refresh and deploy skills
```

Do not amend or rewrite commits that are already pushed. Do not force-push
`main`.

## 3. Push

```sh
git push origin main
```

If the push is rejected because the remote moved, fetch and rebase onto the
latest `main`, resolve conflicts, re-run the preflight checks, then push again.

## 4. Watch the deployment

The push starts the `Deploy to GitHub Pages` workflow. If `gh` is authenticated:

```sh
gh run list --workflow pages.yml --branch main --limit 3
gh run watch --workflow pages.yml --branch main
```

Without `gh` authentication, use the public Actions API:

```sh
curl -s "https://api.github.com/repos/openshift-psap/self-hosted-llm-cost-calculator/actions/runs?branch=main&per_page=1" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).workflow_runs[0];console.log(r.html_url,r.status,r.conclusion)})"
```

Poll until `status` is `completed`, then require `conclusion` to be `success`.
A queued or in-progress run is not a successful deploy.

## 5. Verify the live site

```sh
curl -sI "https://openshift-psap.github.io/self-hosted-llm-cost-calculator/" | head -1
curl -s "https://openshift-psap.github.io/self-hosted-llm-cost-calculator/?v=$(date +%s)" | grep -o 'FRONTIER_MODELS' | head -1
```

For a pricing change, confirm the new model names appear in the deployed HTML.
GitHub Pages can serve cached content briefly; retry with a cache-busting query
string before assuming the deploy failed.

## Failure handling

- **Workflow failed**: read the failed step in the run URL. This workflow only
  uploads and deploys the repo root, so failures are usually Pages permissions,
  environment protection, or a missing `index.html`.
- **Pages not updating**: confirm the run succeeded and the `github-pages`
  environment points at the right artifact. Do not re-run with `--force`.
- **Bad deploy already live**: revert with `git revert <sha>` and push the
  revert. That triggers a fresh deployment without rewriting history.

## Report

Finish by giving the user:

- Commit SHA and subject
- Push result
- Workflow run URL and conclusion
- Live URL checked, with HTTP status
