# Executor upstream

[`ntna141/executor`](https://github.com/ntna141/executor) is a fork of
[`UsefulSoftwareCo/executor`](https://github.com/UsefulSoftwareCo/executor). The `spark` branch
carries the Spark overlay on top of upstream `main`, and `halo-g1` consumes it as the git
submodule at `executor/`.

To update: merge upstream `main` into `spark`, resolve conflicts, push, then bump the submodule
pointer in `halo-g1`. Keep the Spark trusted-JWT adapter in `apps/host-cloudflare/src/auth`, the
Spark tools bridge in `apps/host-cloudflare/src/spark-tools.ts`, and the identity pass-through in
`packages/core/api/src/server/scoped-executor.ts`.
