# GitHub Actions

## Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `ci.yml` | every push + PR to `main` | Backend tests + frontend build + landing build. Required gate. |
| `deploy.yml` | push to `main` (or manual `workflow_dispatch`) | Runs tests, then `railway up --detach`, then waits up to 10 min for `/api/health` 200. |

## One-time setup

The deploy workflow needs **two** secrets:

### 1. `RAILWAY_TOKEN` (required)

Token used by `railway up`. Create at https://railway.app → project settings → Tokens → Create.

In GitHub: Repo → **Settings → Secrets and variables → Actions → New repository secret**, name `RAILWAY_TOKEN`.

### 2. `LANDING_REPO_TOKEN` (required because the `landing/` submodule is private)

The `landing/` submodule points to `juanmitriatti/campo-chat-bot` (private repo). The default `GITHUB_TOKEN` cannot read other private repos, so the deploy workflow needs a PAT (or fine-grained token) with **read** access to that repo.

Create one at https://github.com/settings/personal-access-tokens/new:
- Resource owner: `juanmitriatti`
- Repository access: only `juanmitriatti/campo-chat-bot`
- Permissions → Contents: **Read-only**

Add as secret `LANDING_REPO_TOKEN` in this repo.

### 3. (Optional) Repository variables

- `RAILWAY_SERVICE` — only if your Railway service is named something other than `campo-bot`.

### 4. (Optional) GitHub environment

Create a `production` environment under **Settings → Environments** for protection rules / required reviewers on the deploy job.

## Manual deploy

```bash
gh workflow run deploy.yml
```

Or from the GitHub UI: Actions → Deploy → Run workflow.

## Smoke test

`deploy.yml` polls `https://campo-bot-production.up.railway.app/api/health` for up to 10 minutes after `railway up`. The endpoint returns `{ status, timestamp, sha }`. The smoke step compares `sha` against the commit currently being deployed and only succeeds when they match — that confirms the new build is actually live, not just the old one still serving 200s.

`sha` is read from `RAILWAY_GIT_COMMIT_SHA` which Railway sets automatically.

## Local equivalent

```bash
npm test                                   # what CI runs
cd frontend && npm ci && npm run build      # frontend gate
cd landing && npm ci && npm run build       # landing gate
railway up --detach                          # what deploy.yml runs
curl https://campo-bot-production.up.railway.app/api/health
```
