# engine-sidecar — build instructions

Small standalone Rust binary that wraps the **real** `ide-diff` engine
(`../../ai-native-ide/crates/ide-diff`) and speaks line-delimited JSON over
stdio. The Theia backend service spawns this binary as a child process.

> This crate is intentionally **not** part of the `ai-native-ide` Cargo
> workspace (see the empty `[workspace]` table in `Cargo.toml`). It builds on
> its own, pulling `ide-diff` in by path.

## Build (run this — the machine that must NOT run cargo is the agent's, not yours)

```bash
cd "ide-theia-spike/engine-sidecar"
cargo build --release
```

## Resulting binary

```
ide-theia-spike/engine-sidecar/target/release/engine-sidecar
```

This is exactly the path the Theia backend service (`EngineSidecarService`)
defaults to. Override it at runtime with the `ENGINE_SIDECAR_BIN` env var if you
put the binary elsewhere.

## Smoke test (optional, proves the engine without Theia)

```bash
printf '%s\n' \
  '{"id":1,"method":"ping","params":{}}' \
  '{"id":2,"method":"diff","params":{"original":"a\nb\nc\n","proposed":"a\nB\nc\n"}}' \
  | ./target/release/engine-sidecar
```

Expected: two JSON lines — a `pong` response, then a response whose `result.hunks`
is a one-element array describing the `b` -> `B` change.

## Unit tests

```bash
cd "ide-theia-spike/engine-sidecar"
cargo test
```
