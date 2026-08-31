# Bastion Core integration

The IDE embeds selected `bastion-core` crates at revision
`aece48b55981a1c64b04eaf1f8c9eae3404f9503`. This is the revision used by the
local Bastion Agent reference composition when the foundation was created.

## Ownership map

| IDE requirement | Existing Bastion contract | IDE-owned work |
|---|---|---|
| Governed local memory | `bastion-memory` + `SqliteMemory` | classify IDE memories; keep Guidance/Truth separate |
| Approval-gated effects | `CapabilityRegistry` + `ApprovalGate` | workspace capability implementations and Context Dock UX |
| Privacy/egress | runtime privacy tiers | destination classification needed beyond current local-provider naming |
| External coding agents | `bastion-agent-runtime` | project-scoped adapter composition and capability UI |
| Model calls and MCP | `bastion-providers`, `bastion-mcp` | IDE context compilation and project tools |
| Project/resource/intent/evidence | none: host business state remains host-owned | `ide-domain` and later store/runtime crates |

## Upgrade policy

1. Pin every Core dependency to a reviewed release or revision.
2. Update in a dedicated branch.
3. Run the IDE's foundation, conformance and regression tests in GitHub Actions.
4. Record behavior changes before merging.
5. Never patch a Core crate inside this repository to bypass a missing contract.

