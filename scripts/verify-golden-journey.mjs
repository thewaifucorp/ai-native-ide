import { readFile } from "node:fs/promises";

const contract = JSON.parse(await readFile(new URL("../contracts/foundation.json", import.meta.url)));
const journeySource = await readFile(
  new URL("../apps/desktop/src-tauri/src/golden_journey.rs", import.meta.url),
  "utf8",
);

if (!contract.required.includes("project") || !contract.required.includes("effect")) {
  throw new Error("Golden journey contract is malformed, not red for the intended reason.");
}

const requiredRouteMarkers = [
  "informal_intent_reaches_evidenced_preview_reconciliation",
  "propose_write",
  "start local benchmark preview",
  "capture actual failed health check",
  "PreviewReconciliationAction::ChangeImplementation",
];
const missing = requiredRouteMarkers.filter((marker) => !journeySource.includes(marker));
if (missing.length > 0) {
  throw new Error(`Golden journey is incomplete: ${missing.join(", ")}`);
}

console.log("Golden journey contract verified: host route is covered by Rust integration test.");
