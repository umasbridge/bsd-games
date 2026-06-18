# Deploy bsd-games + bsd-app

Run the full deployment pipeline: commit bsd-games, push, and redeploy both bsd-games and bsd-app to Vercel production with cache busting.

## Steps

1. **Commit & push bsd-games** (this repo):
   - Run `git status` and `git diff` to see what changed.
   - If there are changes, stage them, commit with a descriptive message, and `git push origin main`.
   - If clean, skip to step 2.

2. **Deploy bsd-games to Vercel**:
   - Run `cd /Users/umajalapathy/bsd-games && npx vercel --prod --yes --force`

3. **Update bsd-app's bsd-games dependency**:
   - Get the latest bsd-games commit hash: `git -C /Users/umajalapathy/bsd-games rev-parse HEAD`
   - In bsd-app, update package.json to pin to that hash: `github:umasbridge/bsd-games#<hash>`
   - **Critical**: delete both `node_modules/bsd-games` AND `package-lock.json` before reinstalling — npm's lock file caches a resolved git hash that won't update with just `rm -rf node_modules/bsd-games && npm install`.
   - Run `cd /Users/umajalapathy/bsd-app && rm -rf node_modules/bsd-games && rm package-lock.json && npm install`
   - Verify the installed code has the new commit: check that `grep 'resolved' package-lock.json | grep bsd-games` shows the correct hash, and spot-check a changed file in `node_modules/bsd-games/`.

4. **Commit & push bsd-app**:
   - Stage `package.json` and `package-lock.json`.
   - Commit with message like "Update bsd-games to <short-hash>".
   - `git push origin main`

5. **Deploy bsd-app to Vercel with cache bust**:
   - Run `cd /Users/umajalapathy/bsd-app && npx vercel --prod --yes --force`
   - The `--force` flag is critical — without it, Vercel may serve cached node_modules.

6. **Verify**:
   - Navigate to `https://bsd-app-bay.vercel.app` and confirm the new changes are live.
   - Tell the user to hard-refresh on their phone (pull-to-refresh on iOS Safari, or clear cache).

## Important notes
- Always use `--force` on the bsd-app deploy to bust Vercel's npm cache.
- **npm lock file gotcha**: `package-lock.json` caches the resolved git commit hash for GitHub dependencies. Even if you update the hash in `package.json` and delete `node_modules/bsd-games`, `npm install` will reinstall the OLD commit from the lock file. You MUST delete `package-lock.json` to force resolution of the new hash.
- **bsd-app uses `components/GameAnalysis.jsx`**, not `src/App.jsx`. When changing routing or component wiring, update GameAnalysis.jsx — that's the entry point bsd-app imports.
- The bsd-app production URL is `https://bsd-app-bay.vercel.app`.
- The bsd-games standalone URL is `https://bsd-games.vercel.app` (dev entry point only).
- If the user says they still see old content on mobile, it's browser cache — suggest hard refresh or clearing Safari/Chrome cache.
