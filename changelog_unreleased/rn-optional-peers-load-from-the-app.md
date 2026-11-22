### Fixed
- **React Native — AsyncStorage is picked up without passing `storage`.** When `init()` gets no `storage`, the SDK now loads `@react-native-async-storage/async-storage` from your app, so a session continues across app restarts. Before, the published bundle looked the module up in a way Metro couldn't link, so the SDK always fell back to memory-only storage and started a fresh session on every launch. Passing `storage` explicitly works as before.
- **React Native — sessions persist with AsyncStorage 3.x.** AsyncStorage 3 replaced `multiGet` with `getMany`, so the SDK couldn't read its saved state back and started a fresh session on every launch, whether AsyncStorage was passed in or picked up. It now reads with whichever of the two your version has.
- **React Native — unhandled promise rejections are captured on JavaScriptCore.** Rejection tracking now hooks React Native's own Promise. Before, it was enabled on a private copy of the Promise library bundled into the SDK, so rejections from your app's promises were missed. Hermes, the default engine, is unchanged.

### Changed
- **React Native — `expo-constants` comes from your app instead of a copy inside the SDK.** The published bundle no longer carries its own copy of the expo-constants and expo-modules-core JavaScript, so it is about 8 KB smaller and always matches your app's Expo version. When you don't pass `appVersion` / `appBuild`, they are still read from `expo-constants`.

### Notes
- **React Native — optional peers rely on Metro's `allowOptionalDependencies`.** The default Metro configs turn it on (React Native 0.74+ and Expo SDK 51+). A custom Metro config that turns it off makes a missing optional peer (AsyncStorage, expo-constants) fail the bundle instead of being skipped.
