# Dependency baseline

This is the reviewed dependency baseline for T01. Exact resolved transitive versions live in
`Cargo.lock` and `package-lock.json`; additions require the same review before entering CI.

| Dependency | Pin | License | Role |
|---|---:|---|---|
| `bastion-core` crates | `aece48b55981a1c64b04eaf1f8c9eae3404f9503` | MIT | Governed memory, capabilities, approvals and agent substrate |
| Tauri | `2.11.5` | MIT OR Apache-2.0 | Desktop host and narrow IPC boundary |
| tauri-plugin-dialog | `2.7.2` | MIT OR Apache-2.0 | Native host-owned directory selection |
| React / React DOM | `19.2.0` | MIT | Renderer UI |
| TypeScript | `5.9.3` | Apache-2.0 | Typed renderer contracts |
| Vite | `7.2.2` | MIT | Renderer build and development server |
| Vitest | `4.0.8` | MIT | Renderer tests |
| SQLite via Bastion | transitive | Public domain | Local governed-memory persistence |
| Axum | `0.8.9` | MIT | Local benchmark HTTP boundary |
| rusqlite | `0.39.0` | MIT | Transactional benchmark persistence |
| Tokio | `1.53.1` | MIT | Native async runtime and local server |
| thiserror | `2.0.20` | MIT OR Apache-2.0 | Typed benchmark failures |
| notify | `8.2.0` | CC0-1.0 | Scoped external-workspace watching |
| portable-pty | `0.9.0` | MIT | Native terminal surface |

## Admission rules

- Pin direct dependencies exactly; update them in a dedicated change.
- Do not add a dependency merely to avoid a small implementation.
- Prefer permissive licenses compatible with this repository's MIT baseline.
- Record any copyleft, proprietary service, native binary or code-generation dependency before
  adding it.
- GitHub Actions runs the lockfiles actually committed by this repository.
