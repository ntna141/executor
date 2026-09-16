# Executor upstream

This directory vendors [`ntna141/executor`](https://github.com/ntna141/executor) branch `spark` at
merge commit `e9cf6281fded` (upstream `main` at `ddfe3f52f2ff` plus the Spark overlay).

The fork tracks [`UsefulSoftwareCo/executor`](https://github.com/UsefulSoftwareCo/executor).
To update: merge upstream `main` into the fork's `spark` branch, resolve conflicts, then re-vendor
this directory from that branch. Keep the Spark trusted-JWT adapter in
`apps/host-cloudflare/src/auth`, the Spark tools bridge in `apps/host-cloudflare/src/spark-tools.ts`,
and the identity pass-through in `packages/core/api/src/server/scoped-executor.ts`.
