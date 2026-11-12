# patches/

`pnpm` applies every patch here at install time (`pnpm.patchedDependencies` in
the root `package.json`, hashed into `pnpm-lock.yaml`). Patches are a last
resort; each one below states what it fixes and the condition under which it
gets deleted.

---

## `mobilewright@0.0.62.patch`

Lets the test fixture relaunch an iOS app that is no longer running. No
upstream fix exists as of 0.0.62.

### The bug

Before every test the `@mobilewright/test` fixture terminates the app and
launches it again (`terminateAppIfRunning`, then `launchApp`). Since 0.0.61 the
terminate tolerates exactly one "not running" error, a physical iPhone's
`process of <bundleId> not found`, and rethrows anything else. The iOS
simulator reports a stopped app differently: `xcrun simctl terminate` exits 3
("found nothing to terminate"), and mobilecli 1.0.16 passes that on as
`failed to execute xcrun simctl command: exit status 3`. So once the app has
died, setup throws before `launchApp`, the app stays stopped, and every later
test in that iOS shard, retries included, fails at setup. 0.0.52 swallowed any
terminate error, so one crash cost one test.

### What the fix does

`dist/launchers.js` also treats that simulator error as "not running". Any
other terminate failure is still rethrown, and an app that is not installed at
all still fails loudly at `launchApp`.

### Blast radius

A dev dependency of the e2e harness only. Nothing published depends on it.

### How it was produced

```bash
pnpm patch mobilewright@0.0.62 --edit-dir /tmp/mw-edit
# edit /tmp/mw-edit/dist/launchers.js, with the provenance header at the top
pnpm patch-commit /tmp/mw-edit
```

### When to remove it

On the next `mobilewright` bump, read `terminateAppIfRunning` in the new
version. If it tolerates the simulator's error (or mobilecli now reports it as
not running), delete the patch and its `pnpm.patchedDependencies` entry;
otherwise re-cut it against the new version with the commands above.
