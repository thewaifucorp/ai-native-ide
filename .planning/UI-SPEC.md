# UI Specification: AI-Native IDE

**Status:** consolidated for planning and implementation  
**Authority:** product-wide information architecture, interaction, and visual language

## Product thesis

The interface represents the living product state—intent, execution, artifacts, evidence, decisions, and result. It is neither a chat that owns files nor a file tree with an AI sidebar. Code, Markdown, terminal, configuration, and raw evidence remain directly accessible.

## Permanent anatomy

1. **Project Rail** — switches semantic projects and signals activity/attention.
2. **Project Navigator** — Overview, Build, Resources, Evidence, and Ship perspectives over one state.
3. **Work Surface** — real tabs/splits for intent, conversation, preview, editor, docs, terminal, diff, and evidence.
4. **Context Dock** — active agent, scope, context, capability, permission, budget summary, and canonical pending decision.
5. **Activity Strip / Pulse Line** — connects intent, edit, checkpoint, effect, evidence, and result; expands into an auditable timeline.

## Project home

The default order is: current objective and next usable result; activity now; what needs the user; product area map; recent sessions and changes. A new project opens an intent canvas asking what the user wants to put into operation, not a technical wizard.

## Progressive depth

- **Essential:** objective, explanation, preview, decisions, consequence language.
- **Detailed:** plan, affected resources, evidence, scope, checkpoints, reasoning.
- **Raw:** editor, Markdown, file tree, diffs, PTY terminal, logs, payloads, and events.

Depth is per-panel zoom over the same project/session. It never creates incompatible products. Full Vibes, Spec, and Hybrid alter workflow; depth alters presentation; permissions alter authority.

## Visual language: Instrument

- Neutral graphite/white chrome; no decorative brand hue in the default state.
- Blue means step/progression, amber needs human action, green verified, red broken.
- Color is never the only signal.
- UI font: Geologica. Machine font: DM Mono. Fonts ship locally.
- Human intent uses larger white sans; state/cost/logs use muted mono.
- Secondary controls are borderless/ghost; one solid primary per context.
- Heights 26/30px; radii 4px controls, 7px panels, 10px preview product.
- Square tabs with separators and a 2px top indicator.
- Findings use a 2px semantic side rule instead of colored card borders.
- Consistent authored SVG icons.
- Common transitions 120–200ms; reduced motion required.
- Preview visually belongs to the built product and is isolated from privileged chrome.

## Intent and conversation

- Conversation is an objective-oriented session, never the project container.
- Prompt autocomplete detects ambiguity, missing decisions, risks, and concepts; it explains relevance and remains dismissible.
- Responses are concise by default and deepen with risk or explicit request.
- Voice and text share the same intent pipeline when voice is available.

## Code, documents, terminal, preview

- Monaco is the initial editor candidate, subject to Phase 1 spike.
- Markdown/specs are real editable files.
- Diffs support hunk/file/checkpoint review.
- Terminal is backed by a real PTY.
- Compressed output always links to raw output.
- Preview states: starting, healthy, stale, broken, reconnecting.
- Preview errors link back to activity, effect, and affected artifacts.

## Findings and reconciliation

Every finding presents claim, consequence, source, evidence, confidence, severity, remediation, and scope. Actions are understand, fix, reject, or accept scoped risk with justification. Intent↔implementation divergence supports changing intent, changing implementation, or recording a scoped exception.

## Permissions

- Asked at effect time in consequence language.
- Context Dock is canonical; Overview only summarizes/navigates.
- Rules can persist by project, resource, agent, and effect kind.
- YOLO is explicit and permanently visible while active.
- Authorization is not an outcome and never grants Game Mode progress.

## Game Mode

Optional feedback profile over the complete IDE.

- Never reward tokens, prompts, generated lines, seated time, or action volume.
- Reward only verified outcomes: clarified intent, completed spec/checkpoint, satisfied criterion/test, finding resolved without regression, feature validated in preview, divergence reconciled, or publish/operational update completed.
- Progression is cosmetic and grants no capability, permission, or model quality.
- No punishment for pauses, absence, failure, or disabling the mode.
- Level always includes a receipt of supporting outcomes.
- Milestones are real project objectives.
- Optional companion reacts to explore, specify, build, verify, repair, and ship.
- Intensity profiles: Minimal, Companion, Immersive.

### Descriptive archetypes

Explorer, Architect, Finisher, Guardian, and Operator may coexist and evolve. Every inference exposes evidence and can be hidden/corrected. Archetypes are never fixed classes, value rankings, or gates.

## Configuration defaults

Hybrid, balanced permissions, adaptive Essential depth, harness layers 0/1, reversible checkpoints, local AAG when available, concise responses, and no paid idle inference. Configuration appears just-in-time with recommendation, consequence, and undo. Simplified UI and complete config file are views of the same state.

## Accessibility and desktop behavior

- Full keyboard navigation and visible focus.
- Adequate contrast; text/icon/shape accompany color.
- Reduced motion, UI zoom, and screen-reader labels.
- Desktop target starts at 1280px.
- Context Dock collapses before Work Surface content disappears.
- Navigator can collapse to rail.
- Preview/editor become tabs when split is impractical.
- Game Mode can disappear without functional gaps.

## Required states

- new/resumed project;
- agent connecting, working, waiting, failed, disconnected;
- preview starting, healthy, stale, broken, reconnecting;
- no/partial/blocking evidence;
- permission pending, denied, allowed, executing, verified;
- external file change;
- AAG degraded/unavailable;
- offline and context-limit warning;
- Game Mode on/off and reduced motion.

## Phase 1 slice

One benchmark project; Project Rail; Navigator with Overview/Build/Resources/Evidence; Work Surface with intent, preview, editor, and minimal diff; Context Dock with agent/scope/one decision; Activity Strip with timeline; Essential and Raw depths; one verified Game Mode outcome.

Not in the first slice: marketplace, seasons, multiple companions, extensive theming, multiplayer collaboration, or cloud analytics.

## Acceptance

- Does not read as chat-with-sidebar.
- Does not require the file tree to explain the project.
- A nontechnical user finds objective, result, and pending decision within ten seconds.
- A technical user reaches code, terminal, and raw evidence within two actions.
- Agent activity links to scope and observed effect.
- UI remains understandable without color, animation, or Game Mode.

---
*Last updated: 2026-08-22 after founder delegated remaining UI decisions.*
