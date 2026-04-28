# GitHub Actions

## Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `ci.yml` | every push + PR to `main` | Backend tests + frontend build + landing build. Required gate. |
| `deploy.yml` | push to `main` (or manual `workflow_dispatch`) | Runs tests, then `railway up --detach`, then waits up to 10 min for `/api/health` 200. |

## One-time setup

The deploy workflow needs a Railway token. Create it once and add it as a repo secret:

```bash
# Locally (already authenticated):
railway login
railway link  # pick the campo-bot project

# Generate a project-scoped token:
# Go to https://railway.app → project settings → Tokens → Create
# Copy the value.
```

Then in GitHub:

1. Repo → **Settings → Secrets and variables → Actions**
2. **New repository secret**:
   - Name: `RAILWAY_TOKEN`
   - Value: the token from Railway
3. (Optional) **Variables** tab → add `RAILWAY_SERVICE` if your Railway service is not named `campo-bot`.
4. (Optional) **Environments** → create `production` for the deploy job (allows protection rules / required reviewers).

## Manual deploy

```bash
gh workflow run deploy.yml
```

Or from the GitHub UI: Actions → Deploy → Run workflow.

## Smoke test

`deploy.yml` polls `https://campo-bot-production.up.railway.app/api/health` for up to 10 minutes after `railway up`. The endpoint returns `{ status, timestamp, sha }`. If you want to verify a specific commit is live, compare `sha` with `git rev-parse --short HEAD`.

## Local equivalent

```bash
npm test                                   # what CI runs
cd frontend && npm ci && npm run build      # frontend gate
cd landing && npm ci && npm run build       # landing gate
railway up --detach                          # what deploy.yml runs
curl https://campo-bot-production.up.railway.app/api/health
```
