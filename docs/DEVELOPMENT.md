# Development

## Normal loop

```bash
npm ci
npm run check
cargo test -p ide-domain
bash scripts/clean-local-artifacts.sh
```

GitHub Actions is the retained, reproducible validation source for the whole Rust
workspace and Tauri package. Local builds are welcome when they speed investigation,
but remove their generated artifacts after use.

## Tauri on Linux

The desktop host needs WebKitGTK development headers. Ubuntu/Debian users who want to
compile it locally need the same packages installed in `.github/workflows/ci.yml`,
including `libwebkit2gtk-4.1-dev`. This is a host prerequisite, not a Rust dependency.

If those headers are unavailable, still run the shell-neutral domain test above and use
the GitHub artifact for desktop validation.

## Disk discipline

Before a large local build:

```bash
bash scripts/preflight-space.sh
```

After it:

```bash
bash scripts/clean-local-artifacts.sh
```

The cleanup script only removes repository-local `target/`, frontend distribution and
artifact staging/download directories. It never traverses a home directory or Cargo's
global registry cache.

