# This fork (read before AGENTS.md)

This is f4yis's personal fork of Ardia, not the owner's checkout. Follow `AGENTS.md` for code rules (no comments,
conventions, hidden test instances), but skip its releases, issues/PRs, Bonzai and commit-to-`main` parts, and
publish nothing.

- Remotes: `origin` = f4yis/ardia, `upstream` = mantrakp04/ardia. Work and commit on branch `my-features`, then
  `git push origin my-features`.
- The user's daily browser is this fork's build at `/Applications/Ardia.app` (bundle ID `com.peweo.ardia`, team
  `869475H5P9`, empty `SUFeedURL` so it never auto-updates). Never test in it; replacing it as below is expected.

## After every change: rebuild and replace the app
1. Check: `pnpm -C apps/browser typecheck && pnpm -C apps/browser test`
2. Build:
   ```sh
   cd apps/browser && xcodebuild -workspace macos/Ardia.xcworkspace -scheme Ardia-macOS -derivedDataPath build-fayis \
     -destination 'platform=macOS,arch=arm64' -configuration Release -allowProvisioningUpdates -quiet build
   ```
3. Quit the app: `osascript -e 'tell application id "com.peweo.ardia" to quit'`. If it doesn't exit, it's
   waiting on a confirm dialog: ask the user. Never kill it. Once it has exited:
   ```sh
   rm -rf /Applications/Ardia.app && ditto apps/browser/build-fayis/Build/Products/Release/Ardia.app /Applications/Ardia.app && open /Applications/Ardia.app
   ```
4. Commit on `my-features` and push.

## Pulling updates from the original Ardia
```sh
git fetch upstream && git rebase upstream/main && pnpm install && pnpm pods
```
Then rebuild and replace as above. `pnpm pods` quotes `MARKETING_VERSION` in `project.pbxproj`; undo that before the
next rebase. If the build says "no prebuilt engine", run `packages/ardiacore/scripts/fetch-engine.sh --nearest`.
Don't edit `engine/`: that needs a 5-hour Chromium build.

## Gotchas
- A hook blocks `git switch` and `git checkout <branch>`; use `git checkout -b`.
- `scripts/agent/await` needs GNU `timeout` (`brew install coreutils`); until then, use a plain deadline loop.

@AGENTS.md
