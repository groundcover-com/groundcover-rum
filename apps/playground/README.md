# playground

A Vite + React page wired to `@groundcover/browser` from this repo. It is the page the browser e2e
suite ([`tests/e2e/playground`](../../tests/e2e/playground)) drives with Playwright, and a place to
try SDK changes by hand.

Its buttons cover what the SDK captures: `fetch` and XHR requests (with custom headers and
sensitive bodies), logs, handled and uncaught errors, custom events, user identity, manual and
client-side navigation (`/other-page`), session ids, `updateConfig`, session replay start and stop,
and a canvas chart.

## Run

```bash
# From the repo root: builds the SDK in watch mode and serves this page and the Next.js app.
pnpm dev
```

`src/main.tsx` calls `groundcover.init` with `debug` on, compression off and a DSN of
`http://localhost:3000`, a local address (under `pnpm dev`, the Next.js app's port), so the SDK's
batches stay on your machine: open the browser's console and network panel to see what it sends.
**Update Config** keeps them local too. To send to a real cluster from that button, set
`VITE_GC_DSN` and `VITE_GC_API_KEY` in `apps/playground/.env.local` (git-ignored). The network
buttons do leave the machine: they call `jsonplaceholder.typicode.com`.

## e2e

```bash
pnpm run e2e    # builds every package, then runs tests/e2e/playground in Chromium, Firefox and WebKit
```

Playwright serves this app's production build with `vite preview` on `:4173`, and reuses a server
that is already listening there when not on CI. If a result looks like it came from old code,
stop whatever holds `:4173`, delete `apps/playground/dist` and rebuild: turbo can restore a cached
build and report it as up to date.

A spec picks its privacy config through the URL: `?gcp=<base64 JSON>` merges into the options in
`src/main.tsx`, and `redactorName` selects one of the named redactors defined there.
