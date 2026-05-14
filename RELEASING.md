# Releasing baf

`brew install rthomare/baf/baf` is fed by tagged releases of this repo.
Each tag triggers `.github/workflows/release.yml`, which runs GoReleaser
to:

1. Build the web UI (`npm ci && npm run build` in `web/`).
2. Cross-compile `baf` for darwin-amd64/arm64 and linux-amd64/arm64.
3. Upload the archives + checksums to a GitHub release on this repo.
4. Push a refreshed `Formula/baf.rb` to the tap repo at
   [`rthomare/homebrew-baf`](https://github.com/rthomare/homebrew-baf).

## One-time setup (do this once, ever)

### 1. Create the tap repo

GitHub repo: `rthomare/homebrew-baf`, public, empty. Homebrew requires
the name to start with `homebrew-`; everything after that becomes the
tap name (so `brew install rthomare/baf/baf` ← from `rthomare/homebrew-baf`).

You don't need to write a formula by hand — GoReleaser will create
`Formula/baf.rb` on the first release.

### 2. Create a fine-grained PAT for the tap push

GoReleaser pushes commits to the tap repo on each release. That needs a
token with write access to `rthomare/homebrew-baf` (the default
`GITHUB_TOKEN` only has access to the repo running the workflow).

- GitHub → **Settings → Developer settings → Personal access tokens →
  Fine-grained tokens → Generate new token**.
- Resource owner: `rthomare`. Only select repositories: `homebrew-baf`.
- Repository permissions: **Contents: Read and write**.
- Expiration: whatever you're comfortable with. Set a calendar reminder.

### 3. Store the PAT as a secret on this repo

On `rthomare/baf` → **Settings → Secrets and variables → Actions → New
repository secret**:

- Name: `HOMEBREW_TAP_GITHUB_TOKEN`
- Value: the PAT from step 2.

The workflow reads it as `${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}`.
Without it, the release will still produce archives, but the brew tap
won't update — `brew install` will keep installing the previous version
until you push a fresh formula manually.

## Cutting a release

```sh
# Make sure main is green and you're on it.
git checkout main && git pull

# SemVer. Tag the commit you want to ship.
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Watch the run at `https://github.com/rthomare/baf/actions`. When it's
green, verify:

```sh
brew update
brew tap rthomare/baf      # one-time, no-op on subsequent releases
brew install baf           # or `brew upgrade baf` if already installed
baf --version              # should print: baf v0.1.0
```

After the tap is registered locally, `brew install baf` resolves
unqualified — Homebrew searches your tapped repos for an exact-name
match when no `homebrew-core` formula exists by that name.

If something went wrong, you can re-run the workflow after pushing the
fix and force-moving the tag (`git tag -f vX.Y.Z && git push -f origin
vX.Y.Z`) — but only do that if no one has installed the broken release.
Once a tag has been consumed by users, cut a fresh `vX.Y.Z+1` instead.

## Trying GoReleaser locally before tagging

```sh
brew install goreleaser
goreleaser release --snapshot --clean --skip=publish,validate
```

This runs the full pipeline against a synthetic version (`v0.0.0-next`),
writes archives to `dist/`, and skips publishing to GitHub. Good for
verifying the web build + cross-compile work before pushing a tag.
