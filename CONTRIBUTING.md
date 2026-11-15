# Contributing

How a change lands in this repo. Setup, commands and CI lanes are in the [README](README.md).

## Pull requests

- Branch from `main` and open the PR against `main`.
- Title it with the platforms and the change, e.g. `Native iOS and Android — engine signals`.
- Keep one commit per work item, and push a PR's commits together: CI reports on the head only.
- The lanes your paths touch must go green. `Core CI`, `RN CI` and `Web CI` are required; the
  Flutter and native lanes run on their own paths and should be green too.

## Changelog entries

Every PR that changes what an SDK ships adds one file to
[`changelog_unreleased/`](changelog_unreleased), named after the change in lower-case kebab case
(`native-crash-and-hang-fixes.md`). Use Keep a Changelog headings (`### Added`, `### Changed`,
`### Fixed`, `### Removed`, `### Notes`) and one line per change:

```markdown
### Fixed
- **React Native and Flutter — <the change, as a headline>.** <What a customer sees now and why.>
```

Name the SDKs the line applies to, and write it for someone using the SDK, not for a reviewer.
When a package is released, its lines move into that package's `CHANGELOG.md` under the new
version, and a file whose lines have all shipped is deleted.

## Rules for SDK code

- **Never break the host app.** Each SDK runs inside someone else's app or page. Guard every
  callback and hook, detect features rather than platforms, keep work off the main thread, and
  when something fails, degrade to sending less, never to throwing.
- **The browser is the baseline.** When SDKs disagree on behaviour, the browser's is the default.
  The shared request fixtures in [`packages/core/wire`](packages/core/wire) prove it: every SDK's
  golden test makes the same call and deep-compares the request. A fixture changes only when what
  the SDKs send changes on purpose, and then every golden must pass again.
- **Edit the native engine in `packages/core/swift` and `packages/core/kotlin`.** The copies inside
  the SDKs are written by `node scripts/vendor-engine.mjs` and overwritten on the next run; CI fails
  if one is committed. See [`packages/core/README.md`](packages/core/README.md).
- **Change public API on purpose.** The native SDKs keep their public surface in files:
  `packages/ios/api/` (check with `packages/ios/scripts/api-surface.sh`, accept a change with
  `--update`) and `packages/android/*/api/` (`./gradlew apiCheck`, accept with `./gradlew apiDump`).
  A PR that changes what customers can call shows it as a diff there.
- **Nothing internal ships.** A published package (npm tarball, pub.dev archive, the iOS source
  mirror, Maven artifacts) must not contain paths into this repo (a link to it on GitHub is fine),
  internal identifiers, people's names or secrets, comments included. Check the exact upload set before a release:
  `npm pack --dry-run`, `dart pub publish --dry-run`, `packages/ios/scripts/build-mirror.sh <dir>`,
  and the `maven-upload-set` artifact of a `release-android.yml` run (locally,
  `./gradlew publishToMavenLocal` in `packages/android`).
- **Comments carry the reasoning here.** When a change alters behaviour, search the whole diff for
  prose that still describes the old behaviour, not only the block you edited.

## Docs

Each package's README is that SDK's customer reference: change it in the same PR as the behaviour
it describes, and keep it free of internal names, as above. The developer guides are
[`apps/DEVICE_TESTING.md`](apps/DEVICE_TESTING.md) (a playground against a real cluster),
[`tests/e2e/mobile/README.md`](tests/e2e/mobile/README.md) (the mobile e2e suite),
[`packages/core/NATIVE_TESTING.md`](packages/core/NATIVE_TESTING.md) (the engine's unit suites)
and [`patches/README.md`](patches/README.md) (why each dependency patch exists).

## Security

Report vulnerabilities privately, as [`SECURITY.md`](SECURITY.md) describes, never in an issue or
a PR.
