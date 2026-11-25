### Fixed

- **React Native — recover fatal JavaScript errors on startup.** On iOS and Android, the SDK saves the crash report together with the events queued before it, including before the first interaction. It sends them under the original session right away when the app keeps running, and after a bundle reload or app restart otherwise.
