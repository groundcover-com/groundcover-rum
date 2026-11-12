#!/usr/bin/env bash
# The body native-android.yml's e2e-android job runs inside the emulator runner, for the native
# Android playground (APP=native). ci-flutter-android-e2e.sh's shape: the app carries its own
# code, so there is no bundler to start, and the script waits for the playground's ready line in
# logcat before running specs.
#
# Runs locally too, against a booted emulator with the APK built:
#   APK=apps/android-playground/app/build/outputs/apk/debug/app-debug.apk \
#     bash tests/e2e/mobile/ci-native-android-e2e.sh
#
# MW_SHARD=N/M runs one shard. APK defaults to the path native-android.yml downloads the artifact to.
set -uo pipefail

PACKAGE=com.groundcover.nativeplayground
APK=${APK:-apps/android-playground/artifacts/app-debug.apk}
mkdir -p test-results

# The emulator runner waits for every child of this script before it stops the emulator, so
# anything left running here holds the job open. The emulator itself is only killed on CI: a
# local run leaves the developer's emulator up.
kill_background() {
  pkill -9 -f in-app-agent-stub 2>/dev/null || true
  if [ "${CI:-}" = "true" ]; then
    pkill -9 -f qemu-system 2>/dev/null || true
    pkill -9 -f netsimd 2>/dev/null || true
    pkill -9 -f 'crashpad_handler.*monitor-pid' 2>/dev/null || true
  fi
}
trap kill_background EXIT

adb wait-for-device

# mobilecli asks whether any DEBUGGABLE app is Flutter by injecting an in-app agent it ships for
# arm64 only, and on an x86_64 emulator every tree read waits 5 s for that to fail. The debug
# playground is debuggable, so the stub answers the agent's socket with the not-Flutter reply, as
# for the Flutter lane (in-app-agent-stub.mjs explains).
DEVICE_ABI=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
if [ "$DEVICE_ABI" != "arm64-v8a" ]; then
  ( nohup node tests/e2e/mobile/in-app-agent-stub.mjs 9494 > test-results/in-app-agent-stub.log 2>&1 & )
  for i in $(seq 1 20); do
    curl -sf -X POST -d '{}' http://127.0.0.1:9494/ >/dev/null 2>&1 && break
    [ "$i" = 20 ] && { echo "::error::in-app agent stub did not start"; cat test-results/in-app-agent-stub.log; exit 1; }
    sleep 0.5
  done
  adb reverse "localabstract:mobilecli.$PACKAGE" tcp:9494 \
    || { echo "::error::adb reverse for the in-app agent stub failed"; exit 1; }
  echo "device ABI $DEVICE_ABI: in-app agent stub on localabstract:mobilecli.$PACKAGE"
fi

# A crash dialog left on screen covers every later spec's locators.
adb shell settings put global hide_error_dialogs 1 || true
# The ready line is logged once the first frame draws, which a sleeping screen never does.
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
adb logcat -c 2>/dev/null || true

[ -f "$APK" ] || { echo "::error::no APK at $APK"; exit 1; }
adb install -r "$APK" || { echo "::error::adb install failed"; exit 1; }
# The launcher activity as the device resolves it, and `am start`'s output as the verdict: it
# exits 0 on "Error type 3" and on a thrown exception (ci-flutter-android-e2e.sh).
ACTIVITY=$(adb shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$PACKAGE" \
  | tail -n 1 | tr -d '\r')
case "$ACTIVITY" in
  "$PACKAGE"/*) ;;
  *) echo "::error::no launcher activity for $PACKAGE (resolved '$ACTIVITY')"; exit 1 ;;
esac
START=$(adb shell am start -n "$ACTIVITY" 2>&1)
echo "$START"
case "$START" in *Error* | *Exception*) echo "::error::am start failed for $ACTIVITY"; exit 1 ;; esac

# The playground logs this line once it has started the SDK and drawn its first frame
# (MainActivity.kt).
for i in $(seq 1 60); do
  if adb logcat -d 2>/dev/null | grep -q 'native-playground: ready'; then echo "app ready"; break; fi
  [ "$i" = 60 ] && { echo "::error::the playground never logged its ready line"; adb logcat -d > test-results/logcat.txt; exit 1; }
  echo "waiting for the app $i"; sleep 2
done

adb exec-out screencap -p > test-results/screen-before-e2e.png 2>/dev/null || true

if [ -n "${MW_SHARD:-}" ]; then
  echo "running shard $MW_SHARD"
  APP=native npx mobilewright test --project=native-android --shard="$MW_SHARD"
else
  APP=native npx mobilewright test --project=native-android
fi
rc=$?

adb logcat -d > test-results/logcat-after-e2e.txt 2>&1 || true
adb exec-out screencap -p > test-results/screen-after-e2e.png 2>/dev/null || true
exit "$rc"
