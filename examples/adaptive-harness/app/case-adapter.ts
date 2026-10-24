import type { FeedbackCaseSink } from "../feedback-trigger/host.js";

export class CaseFilingUnavailableError extends Error {
  constructor() {
    super(
      "Production GitHub case filing is intentionally disabled; no verified #76 adapter is configured",
    );
    this.name = "CaseFilingUnavailableError";
  }
}

/**
 * The candidate harness deliberately exposes pending-only case review. This
 * adapter is a typed seam for a later, separately authorized #76 integration;
 * it cannot report a fake ref or claim a remote readback.
 */
export const pendingOnlyCaseSink: FeedbackCaseSink = {
  async fileOrLink() {
    throw new CaseFilingUnavailableError();
  },
  async verify() {
    return false;
  },
};
