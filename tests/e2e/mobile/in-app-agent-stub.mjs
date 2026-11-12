// Stands in for mobilecli's in-app agent on an x86_64 emulator, where the real one cannot load.
//
// Since 1.0.8, every Android `dump ui` first asks whether the foreground app is Flutter, and for
// a debuggable app that means attaching a JVMTI agent (mobilecli.so) and waiting up to 5s for it
// to answer on `localabstract:mobilecli.<package>`. mobilecli ships that agent for arm64 only
// (agents/android/Makefile builds with aarch64-linux-android26-clang), so on the x86_64 emulator
// every tree read fails the dlopen, sits out the full 5s, and then falls back to the accessibility
// dump it would have used anyway. That slows every Android spec several-fold, and leaves the list
// still for long enough to stretch vitals-safety's short segments well past their cap.
//
// `adb reverse` puts this server on that socket name, so mobilecli finds an agent at once, asks it
// `device.flutter.vmServiceUri`, gets an error — the same answer the real agent gives a non-Flutter
// app — and goes straight to the accessibility dump. It is never attached, so nothing is injected.
//
// Usage: node in-app-agent-stub.mjs <port>   (JSON-RPC 2.0 over HTTP POST, as mobilecli speaks it)
import http from "node:http";

const port = Number(process.argv[2] ?? 9494);

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let id = "1";
      let method = "(readiness probe)";
      try {
        const parsed = JSON.parse(body || "{}");
        id = parsed.id ?? id;
        method = parsed.method ?? method;
      } catch {
        // mobilecli's readiness probe posts "{}"; anything unparseable gets the same answer.
      }
      console.log(`${new Date().toISOString()} ${method}`);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "in-app agent stub: mobilecli ships no x86_64 agent" },
        })
      );
    });
  })
  // Die loudly (EADDRINUSE and the like): ci-android-e2e.sh probes the port and fails the run.
  .on("error", (error) => {
    console.error(`in-app agent stub: ${error.message}`);
    process.exit(1);
  })
  .listen(port, "127.0.0.1", () => console.log(`in-app agent stub listening on 127.0.0.1:${port}`));
