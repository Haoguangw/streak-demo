/**
 * store.js — In-memory persistence adapter with IDEMPOTENT payouts + audit.
 *
 * This is a reference implementation of the persistence contract the real
 * backend needs (DB/Redis). Swap `createStore` internals for the project's
 * actual data layer — the engine only calls these 4 methods:
 *   getState(driverId, campaignId)
 *   saveState(state)
 *   payout(payload)            -> idempotent, never pays the same run twice
 *   appendAudit(entry)
 */
"use strict";

function createStore() {
  const states = new Map(); // key: `${campaignId}:${driverId}`
  const payouts = new Map(); // key: `${campaignId}:${driverId}:${runId}` — idempotency
  const audits = [];

  const key = (driverId, campaignId) => `${campaignId}:${driverId}`;

  return {
    async getState(driverId, campaignId) {
      const k = key(driverId, campaignId);
      return states.get(k) ? JSON.parse(JSON.stringify(states.get(k))) : null;
    },

    async saveState(state) {
      states.set(key(state.driverId, state.campaignId), JSON.parse(JSON.stringify(state)));
    },

    /**
     * Idempotent payout: each (driver, campaign, run) is paid at most once.
     * Returns { paid: false, reason: "duplicate" } on a repeat attempt.
     */
    async payout({ driverId, campaignId, runId, amount, reason, day }) {
      const k = `${campaignId}:${driverId}:${runId}`;
      if (payouts.has(k)) {
        return { paid: false, reason: "duplicate", existing: payouts.get(k) };
      }
      const record = {
        payoutId: `PO-${campaignId}-${driverId}-${runId}`,
        driverId,
        campaignId,
        runId,
        amount,
        reason,
        day,
        paidAt: new Date().toISOString(),
      };
      payouts.set(k, record);
      return { paid: true, ...record };
    },

    async appendAudit(entry) {
      audits.push({ ...entry, ts: new Date().toISOString() });
    },

    // --- introspection for tests/debug ---
    listAudits() {
      return audits;
    },
    listPayouts() {
      return [...payouts.values()];
    },
  };
}

module.exports = { createStore };
