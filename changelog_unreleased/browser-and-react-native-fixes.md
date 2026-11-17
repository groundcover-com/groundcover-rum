### Fixed
- **Browser and React Native — a refused batch is no longer silent.** When the ingest endpoint answers 401 or 403, the SDK warns on the console once, even with `debug` off, so a wrong `apiKey` or `dsn` no longer looks like a working SDK. Any other non-2xx response is logged with its status when `debug` is on.
