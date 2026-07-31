// services/payloadService.js
//
// Generates the two payloads at file creation time. Both are DERIVED
// from reference_number, not independently random — this keeps them
// stable pointers rather than data that needs rewriting on every
// transition (a printed barcode label can't be "regenerated" anyway).
//
// qr_payload  — static identity data, JSON-encoded. Answers "what is
//               this file" (who created it, department, when). Never
//               changes after creation.
// barcode_payload — a plain, stable reference to the file. Scanning
//               this is how officers resolve "what am I holding" to a
//               file id + LIVE state (current stage, holder, SLA) via
//               GET /files/scan/:payload. The barcode itself carries
//               no state — it's a pointer, the live lookup carries state.

function buildQrPayload({ referenceNumber, department, createdByName, createdAt }) {
  return JSON.stringify({
    referenceNumber,
    department,
    createdBy: createdByName,
    createdAt,
  });
}

function buildBarcodePayload({ referenceNumber }) {
  // Deliberately just the reference number. Security note: this is NOT
  // a security boundary — dispatch/receive/terminal routes already
  // enforce role + custody checks independently of how the file was
  // selected. A guessable reference number lets someone look up a file
  // (same info the citizen portal already gives), not act on it.
  return referenceNumber;
}

module.exports = { buildQrPayload, buildBarcodePayload };
