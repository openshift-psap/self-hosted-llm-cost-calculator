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
node scripts/refresh-presets.mjs --check   # scenario preset snapshot must not be stale
node scripts/test-calculations.mjs        # offline calculation and interaction checks
```

Run all three Node checks for every deployment, including documentation-only
changes. The regression script also syntax-checks the inline app and verifies
session-based demand, speed independence, monthly API bills, Weka reference
buttons, preset preservation, zero demand, and print output. It does not test
real-browser layout or canvas drawing.

If `index.html` changed, also check the inline JavaScript:

```sh
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];fs.writeFileSync('/tmp/opencode/inline.js',m.at(-1)[1]);"
node --check /tmp/opencode/inline.js
```

Confirm:

- The diff contains only intended changes.
- No secrets, tokens, local paths, or generated artifacts are staged.
- `README.md` and the pricing snapshot agree when pricing changed.
- Demand-model changes keep the UI, derivation, print view, README, AGENTS.md,
  and regression expectations consistent. Usage is sessions/user/day × model
  calls/session, never a function of generation speed. Monthly API bills follow
  estimated demand; blended $/M does not change merely because demand changes.
- Unrelated untracked presentations, enablement material, and notes remain
  untouched and unstaged.

## 2. Commit

Stage only intended changed files by exact path, not `git add -A` or entire
directories. For example (adjust the list to the actual diff):

```sh
git add -- index.html README.md AGENTS.md scripts/test-calculations.mjs
git diff --cached --stat
git diff --cached --check
git commit -m "<area>: <short imperative summary>"
```

Include individual `SKILL.md` paths when those guides changed. Review new
untracked files explicitly; ordinary `git diff` does not show their contents.

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
SHA=$(git rev-parse HEAD)
gh run list --workflow pages.yml --branch main --commit "$SHA" --limit 5 --json databaseId,headSha,status,conclusion,url
```

Set `RUN_ID` to the matching `databaseId`, then watch that exact run:

```sh
gh run watch "$RUN_ID" --exit-status
```

Without `gh` authentication, use the public Actions API:

```sh
SHA=$(git rev-parse HEAD)
curl --fail --silent --show-error "https://api.github.com/repos/openshift-psap/self-hosted-llm-cost-calculator/actions/workflows/pages.yml/runs?branch=main&per_page=10" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).workflow_runs.find(r=>r.head_sha===process.argv[1]);if(!r){console.error('Matching workflow not available yet');process.exit(1)}console.log(JSON.stringify({sha:r.head_sha,url:r.html_url,status:r.status,conclusion:r.conclusion}))})" "$SHA"
```

If needed, retry every 10–15 seconds until the matching run's `status` is
`completed`, then require `conclusion` to be `success`. Do not accept a previous
commit's successful run, or a queued/in-progress run, as this deployment.
Missing `gh` authentication does not necessarily prevent Git push: Git may
have separate credentials. Do not expose credentials while troubleshooting.

## 5. Verify the live site

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expected = execFileSync('git', ['show', `${sha}:index.html`], { encoding: 'utf8' });
const url = `https://openshift-psap.github.io/self-hosted-llm-cost-calculator/?v=${sha}-${Date.now()}`;
const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
assert.equal(response.status, 200);
assert.equal(await response.text(), expected, 'Live HTML differs from the committed file');
console.log(`HTTP ${response.status}; live HTML matches ${sha}: ${url}`);
NODE
```

For demand changes, confirm the session inputs, Weka reference buttons, and
demand-based monthly bill formula are present. For pricing changes, confirm
the new model names. Documentation-only deploys can legitimately leave the
HTML unchanged; the exact-SHA workflow check still proves the new commit was
deployed. GitHub Pages can serve cached content briefly; retry with a fresh
cache-busting query string before assuming the deploy failed.

## Failure handling

- **Workflow failed**: read the failed step in the run URL. This workflow only
  uploads and deploys the repo root, so failures are usually Pages permissions,
  environment protection, or a missing `index.html`.
- **Pages not updating**: confirm the run succeeded and the `github-pages`
  environment points at the right artifact. Do not re-run with `--force`.
- **Bad deploy already live**: report the failure. If a rollback is authorized,
  use `git revert <sha>` and push the revert, not a reset or force push. That
  triggers a fresh deployment without rewriting history.

## Report

Finish by giving the user:

- Commit SHA and subject
- Push result
- Workflow run URL and conclusion
- Live URL checked, with HTTP status
