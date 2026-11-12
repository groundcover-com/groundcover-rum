export function safeWarn(message: string): void {
  try {
    // Keep SDK diagnostics out of our console capture.
    console.warn(`${message} (groundcoverIgnore)`);
  } catch {
    // A host's patched console must not break SDK initialization or updates.
  }
}
