# Security Policy

## Reporting a vulnerability

We take the security of the groundcover RUM SDKs seriously: they run in end-user browsers and mobile
apps and handle potentially sensitive data.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately through either:

- **GitHub private advisories** — [open a draft advisory](https://github.com/groundcover-com/groundcover-rum/security/advisories/new)
  (Security → Advisories → *Report a vulnerability*), or
- **Email** — [security@groundcover.com](mailto:security@groundcover.com)

Please include:

- a description of the issue and its impact,
- the affected package and version (e.g. `@groundcover/browser@2.2.1`),
- steps to reproduce or a proof of concept,
- any suggested remediation.

## Response

- We aim to **acknowledge** your report within **3 business days**.
- We’ll keep you informed of progress and coordinate a disclosure timeline with you.
- Please give us a reasonable window to ship a fix before any public disclosure.

## Supported versions

| Package | Supported |
|---|---|
| `@groundcover/browser` `2.x` | ✅ |
| `@groundcover/browser` `< 2.0` | ❌ |
| `@groundcover/react-native`, latest release candidate | ✅ |
| `groundcover_rum` (Flutter), latest release candidate | ✅ |
| `GroundcoverRum` (iOS, Swift Package Manager), latest release candidate | ✅ |
| `com.groundcover:rum-android` (Android), latest release candidate | ✅ |

Security fixes are released against the latest `2.x` line of the browser SDK, and as a new release
candidate of the React Native, Flutter, iOS and Android SDKs.
