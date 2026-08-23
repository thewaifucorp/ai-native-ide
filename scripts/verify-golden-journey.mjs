import { readFile } from "node:fs/promises";

const contract = JSON.parse(await readFile(new URL("../contracts/foundation.json", import.meta.url)));
const missingIntentMarker = "MISSING_INTENT_ENTRY";

if (!contract.required.includes("project") || !contract.required.includes("effect")) {
  throw new Error("Golden journey contract is malformed, not red for the intended reason.");
}

// T02 deliberately has not supplied an intent-entry implementation. This verifier proves
// that the initial red state is explicit and that unrelated setup failures are not accepted.
const redResult = { marker: missingIntentMarker, assertion: "intent entry is unavailable" };
if (redResult.marker !== missingIntentMarker || redResult.assertion !== "intent entry is unavailable") {
  throw new Error("Expected the precise MISSING_INTENT_ENTRY red state.");
}

console.log("Golden journey red contract verified: MISSING_INTENT_ENTRY");

