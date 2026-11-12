// Whether a configured DSN can actually be reached from the build that is running.
//
// Separate from the wiring, and pure, because this is the part that can be WRONG: warning on a
// DSN that works trains people to ignore the warning, and staying quiet on one that does not is
// the failure it exists to prevent.

/**
 * Why a cleartext DSN will not be reachable in this build, or null when it will.
 *
 * Both platforms block plain HTTP in a release build, by different mechanisms and neither of them
 * ours to change from a library:
 *
 * - **Android** — `usesCleartextTraffic` is set only in the app's `debug` manifest (Expo's
 *   template, and the RN CLI's). A release build has no cleartext permission, so the request never
 *   leaves the device.
 * - **iOS** — App Transport Security refuses plain HTTP unless the app declares an exception in
 *   its Info.plist.
 *
 * A warning rather than only a README line, because of what it looks like: combined with ingest
 * responses being unchecked, a release build against a cleartext DSN is indistinguishable from a
 * working one — every batch discarded, nothing logged — while the debug build it is tested in
 * works perfectly.
 *
 * @param endpoint the resolved endpoint, i.e. what `getEndpoint()` returns — already
 *   `https://`-prefixed when the DSN carried no scheme, so only an EXPLICIT `http://` reaches here.
 * @param isDevBundle whether this is a development bundle (React Native's `__DEV__`). A debug build
 *   has the cleartext manifest entry and can reach the DSN, so warning there would be false.
 */
export function cleartextDsnWarning(endpoint: string, isDevBundle: boolean): string | null {
  if (!endpoint.toLowerCase().startsWith("http://")) return null;
  if (isDevBundle) return null;
  return (
    `[groundcover] the configured DSN uses plain HTTP (${endpoint}) and this is not a development ` +
    `build. Android release builds have no usesCleartextTraffic permission and iOS App Transport ` +
    `Security blocks plain HTTP, so NO telemetry will reach it. Use https, or declare the ` +
    `exception in your app's manifest / Info.plist. (groundcoverIgnore)`
  );
}
