# nextjs

A Next.js 15 App Router app wired to `@groundcover/browser` from this repo, for trying the SDK
inside a server-rendered framework. No test drives it.

`src/app/groundcover-rum.tsx` is a client component (`'use client'`) that calls `groundcover.init`
in a `useEffect`, so the SDK only ever runs in the browser. It also shows one way to share a session
across micro-frontends: it keeps a session id in `sessionStorage` and passes it as `sessionId`.

## Run

```bash
# From the repo root: builds the SDK in watch mode and serves this app and the Vite playground.
pnpm dev
```

The SDK reads its settings from environment variables, which Next.js inlines for the browser when
they start with `NEXT_PUBLIC_`. Put them in `apps/nextjs/.env.local` (git-ignored):

```
NEXT_PUBLIC_GROUNDCOVER_DSN=<ingest host>
NEXT_PUBLIC_GROUNDCOVER_API_KEY=<ingest key>
NEXT_PUBLIC_GROUNDCOVER_CLUSTER=<cluster name>
```

Without them the app starts with placeholder values and the SDK's requests go nowhere. `debug` is
on, so the browser console shows what the SDK does.
