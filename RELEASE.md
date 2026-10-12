# Release

## Version sources

Keep these in sync for each release:

1. `package.json` → `version`
2. `src-tauri/tauri.conf.json` → `version`
3. `src-tauri/Cargo.toml` → `version`
4. `src/config.ts` → `APP_VERSION` (UI footer)

## Checklist

1. Update version numbers (semver).
2. Confirm `.env.example` documents required keys (no secrets).
3. Run `npm run typecheck` and `npm run build`.
4. Run `npm run tauri:build` on the release OS (Windows for the primary target).
5. Smoke-test:
   - **Login on SkilledIM** opens the system browser (no password fields in Companion)
   - Deep-link callback authenticates Companion
   - Check-in / check-out against SkilledIM APIs
   - Week history loads / external ESS changes eventually sync
   - Logout clears OS secure storage
6. Attach installers / exe from `src-tauri/target/release/bundle/` to the GitHub Release.
7. Tag the commit: `vX.Y.Z`.

## GitHub Releases

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI (see `.github/workflows/ci.yml`) validates install/typecheck/build on pull requests. Signed Windows installers can be added later with code-signing certificates in repository secrets.

## Hotfix

For critical API-client fixes, bump the patch version and ship a full rebuild — there is no in-app web update channel in v0.1.0.
