#!/usr/bin/env bash
# Android e2e body run INSIDE the android-emulator-runner (cwd = repo root).
# Extracted to a file so the workflow step stays short and the same body runs
# locally against an emulator.
#
# Deliberately no `set -e`: the readiness probes below are best-effort; the real
# pass/fail is the final `pnpm run e2e:rn:android` exit code.

mkdir -p test-results

# SIGKILL everything this run starts in the background so the step can exit
# immediately, on pass, fail or an early `exit 1` (whatever exit code the script
# chose is what stands):
#  - The emulator process tree — VM (qemu), network simulator (netsimd) and the
#    crash handler. Under software GPU the emulator won't shut down, and killing
#    only qemu is not enough (netsimd/crashpad keep the action's teardown waiting).
#  - Metro. A lingering background Metro keeps the STEP alive after the tests
#    have passed and the emulator is dead, until the step's timeout.
#  - The in-app agent stub, for the same reason as Metro.
# A trap rather than a block at the end, because the setup failures below exit
# early and would otherwise leave Metro and the stub holding the step open.
kill_background() {
  pkill -9 -f qemu-system 2>/dev/null || true
  pkill -9 -f netsimd 2>/dev/null || true
  pkill -9 -f 'crashpad_handler.*monitor-pid' 2>/dev/null || true
  pkill -9 -f 'expo start' 2>/dev/null || true
  pkill -9 -f in-app-agent-stub 2>/dev/null || true
}
trap kill_background EXIT

adb wait-for-device

# Forward device localhost:8081 -> host Metro. `expo run:android` sets this up
# itself, but the cache-hit path launches the prebuilt apk with a bare
# `am start`, which does NOT — and the Expo debug build resolves its dev server
# to localhost:8081, so without the reverse the app can't fetch its JS bundle,
# JS never mounts, the screen stays blank and every locator misses.
adb reverse tcp:8081 tcp:8081 || true

# Answer mobilecli's in-app agent socket ourselves on an x86_64 emulator. mobilecli ships that
# agent for arm64 only, and without an answer every tree read of this debuggable app waits 5s for
# an agent that can never load. in-app-agent-stub.mjs has the whole story. Not on arm64, where the
# real agent works and this would shadow it.
DEVICE_ABI=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
if [ "$DEVICE_ABI" != "arm64-v8a" ]; then
  ( nohup node tests/e2e/mobile/in-app-agent-stub.mjs 9494 > test-results/in-app-agent-stub.log 2>&1 & )
  # `adb reverse` succeeds with nothing listening, and a dead stub costs no error, just the 5s per
  # read back. So check it answers first, and fail here rather than in a slow, misleading spec.
  for i in $(seq 1 20); do
    curl -sf -X POST -d '{}' http://127.0.0.1:9494/ >/dev/null 2>&1 && break
    [ "$i" = 20 ] && { echo "::error::in-app agent stub did not start"; cat test-results/in-app-agent-stub.log; exit 1; }
    sleep 0.5
  done
  adb reverse localabstract:mobilecli.com.groundcover.rumplayground tcp:9494 \
    || { echo "::error::adb reverse for the in-app agent stub failed"; exit 1; }
  echo "device ABI $DEVICE_ABI: in-app agent stub on localabstract:mobilecli.com.groundcover.rumplayground"
fi

# Suppress system crash/ANR dialogs — under software-GPU rendering the launcher
# (Quickstep) intermittently ANRs and its dialog covers the app AND steals the
# accessibility tree, failing every locator.
adb shell settings put global hide_error_dialogs 1 || true

# Metro, idempotent: one may already be serving (a re-run, or a local session).
#
# CI=false is LOAD-BEARING. Actions sets CI=true on every runner, and Expo reads
# it to turn Metro's file watcher off outright (`isWatchEnabled()` in @expo/cli —
# "Metro is running in CI mode, reloads are disabled"). The config-preset
# mechanism rewrites apps/rn-playground/src/e2e-preset.ts and relies on the next
# relaunch fetching a re-bundled JS; with watching off Metro serves the bundle it
# built first, forever, so every preset spec would boot the app on `default` and
# fail its readback gate — and only in CI. Scoped to this process so the rest of
# the run still sees CI=true.
if ! curl -sf http://localhost:8081/status >/dev/null 2>&1; then
  ( cd apps/rn-playground && CI=false nohup npx expo start --port 8081 > metro.log 2>&1 & )
fi
npx wait-on http://localhost:8081/status -t 180000

# Clear logcat so the readiness check below only matches THIS app launch.
adb logcat -c 2>/dev/null || true

# Install the prebuilt apk + launch it (skips the Gradle build) when the apk there
# can be trusted; otherwise build (which installs too) and stash it for the save step.
# See apk-reuse.sh for what "can be trusted" means and why.
# shellcheck source=./apk-reuse.sh
. "$(dirname "${BASH_SOURCE[0]}")/apk-reuse.sh"
if should_reuse_apk; then
  echo "installing cached apk"
  # Setup commands (unlike the best-effort readiness probes below) MUST fail the
  # run loudly — a silent install/build failure would let the suite run against a
  # stale or half-installed app and mask the real cause.
  adb install -r apps/rn-playground/artifacts/android/app-debug.apk || { echo "::error::adb install failed"; exit 1; }
  adb shell am start -n com.groundcover.rumplayground/.MainActivity || { echo "::error::am start failed"; exit 1; }
else
  # vendor-engine first: Gradle compiles RN's git-ignored copy of the engine, which is only as
  # fresh as the last write, and a bare `expo run:android` never writes it.
  ( node scripts/vendor-engine.mjs && cd apps/rn-playground && npx expo run:android --no-bundler ) || { echo "::error::expo run:android failed"; exit 1; }
  mkdir -p apps/rn-playground/artifacts/android
  cp apps/rn-playground/android/app/build/outputs/apk/debug/app-debug.apk apps/rn-playground/artifacts/android/ || { echo "::error::apk copy failed"; exit 1; }
fi

# Warm-up: wait for the RN app's JS to mount — logged as `Running "main"` — a
# signal read from logcat, which dumps-and-exits and so CANNOT hang (unlike
# polling `uiautomator dump`, which can block indefinitely on this emulator).
# Gating on render matters because on a cold app the first JS-bundle load +
# Fabric render lags window focus by tens of seconds; starting the suite against
# a blank app makes every locator miss. A short settle then lets the first frame
# paint.
for i in $(seq 1 60); do
  if adb logcat -d 2>/dev/null | grep -q 'Running "main"'; then echo "app JS mounted"; break; fi
  echo "waiting for app JS $i"; sleep 2
done
sleep 5

adb exec-out screencap -p > test-results/screen-before-e2e.png 2>/dev/null || true
# Capture the app's logcat for diagnostics (bundle-load / JS errors don't show in
# the script's stdout, only on-device).
adb logcat -d > test-results/logcat.txt 2>&1 || true

# Sharded when MW_SHARD is set ("2/3"), whole-suite otherwise (a local run).
# mobilewright validates the x/n form and splits by test count over whole spec
# files, in file order (tests/e2e/mobile/README.md#sharding) — uneven in
# duration, but it needs no manual balancing as specs are added.
if [ -n "$MW_SHARD" ]; then
  echo "running shard $MW_SHARD"
  npx mobilewright test --project=rn-android --shard="$MW_SHARD"
else
  pnpm run e2e:rn:android
fi
rc=$?

# Device-side evidence for whatever just happened. The pre-run capture above only
# covers the launch; a gesture that came out as the wrong kind, or a locator that
# found nothing, leaves its trace in the app's log DURING the suite — and the
# emulator is killed a few lines below, so this is the only chance to read it.
adb logcat -d > test-results/logcat-after-e2e.txt 2>&1 || true
adb exec-out screencap -p > test-results/screen-after-e2e.png 2>/dev/null || true

# The test exit code is what stands; kill_background (the EXIT trap) clears up.
exit "$rc"
