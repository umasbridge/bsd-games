# Deploy bsd-app and all related repos

Run the full deployment pipeline: commit all changed repos, push to GitHub, update bsd-app's pinned dependency hashes, and redeploy bsd-app to Vercel production with cache busting.

## Related repos to check

Always check these repos for uncommitted changes before deploying:

| Repo | Path | Branch | bsd-app dependency |
|------|------|--------|-------------------|
| `ips` | `/Users/umajalapathy/ips` | `main` | pinned to commit hash |
| `games-display` | `/Users/umajalapathy/games-display` | `master` | pinned to branch `#master` |
| `bsd-games` | `/Users/umajalapathy/bsd-games` | `main` | pinned to commit hash |
| `games-retrieval` | `/Users/umajalapathy/games-retrieval` | `main` | pinned to commit hash |
| `bsd-lib` | `/Users/umajalapathy/bsd-lib` | `main` | pinned to branch `#main` |
| `bsd-app` | `/Users/umajalapathy/bsd-app` | `main` | — (the app itself) |

Check all at once:
```bash
for repo in bsd-app bsd-lib bsd-games games-display games-retrieval ips; do
  echo "=== $repo ===" && git -C "/Users/umajalapathy/$repo" status --short && git -C "/Users/umajalapathy/$repo" log --oneline -1 && echo ""
done
```

## Steps

1. **Commit & push all changed library repos** (ips, games-display, bsd-games, games-retrieval, bsd-lib):
   - For each repo with changes: `git add -A && git commit -m "..."` and push to its remote.
   - Skip clean repos.

2. **Update bsd-app's pinned dependency hashes**:
   - For repos pinned to a commit hash (ips, bsd-games, games-retrieval), update `package.json` with the new HEAD hash:
     ```bash
     git -C /Users/umajalapathy/<repo> rev-parse HEAD
     ```
   - Edit `bsd-app/package.json` to set `"<pkg>": "github:umasbridge/<repo>#<newhash>"`.
   - Repos pinned to a branch name (bsd-lib `#main`, games-display `#master`) — just update package-lock by following the next step; no package.json edit needed.

3. **Regenerate package-lock.json** (ALWAYS delete first):
   - **Critical**: `npm install --package-lock-only` without deleting first will silently keep old cached GitHub hashes in the lock file, causing Vercel to install old code even after the hash in package.json is updated.
   - Always do:
     ```bash
     cd /Users/umajalapathy/bsd-app
     rm package-lock.json
     npm install --package-lock-only
     ```
   - Verify new hashes landed: `grep -E "resolved.*umasbridge" package-lock.json`

4. **Commit & push bsd-app**:
   - Stage `package.json` and `package-lock.json`.
   - Commit with message like "Bump ips, bsd-games to latest".
   - `git push origin main`

5. **Deploy bsd-app to Vercel**:
   - Run: `cd /Users/umajalapathy/bsd-app && npx vercel --prod --yes --force`
   - `--force` is critical — without it, Vercel may serve cached node_modules with old GitHub deps.

6. **Deploy bsd-games to Vercel** (if bsd-games changed):
   - Run: `cd /Users/umajalapathy/bsd-games && npx vercel --prod --yes --force`
   - bsd-games standalone URL: `https://bsd-games.vercel.app`

7. **Verify**:
   - bsd-app production URL: `https://bsd-app-bay.vercel.app`
   - Tell the user to hard-refresh on their phone (pull-to-refresh on iOS Safari, or clear cache).

## Important notes

- Always use `--force` on Vercel deploys to bust npm cache for GitHub dependencies.
- **npm lock file gotcha**: `package-lock.json` caches the resolved git commit hash for GitHub dependencies. Even if you update the hash in `package.json`, `npm install` may reinstall the old commit from the lock file. Deleting `package-lock.json` before `npm install --package-lock-only` forces fresh resolution.
- **bsd-app uses `components/GameAnalysis.jsx`** as the entry point bsd-app imports for games — not `src/App.jsx`.
- If the user still sees old content on mobile after deploy, suggest hard refresh or clearing Safari/Chrome cache.
