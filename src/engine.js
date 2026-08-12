/**
 * engine.js — Streak evaluation engine (state machine).
 *
 * Responsibilities (spec §9 / checklist):
 *  - Evaluate every driver's qualifying activity separately per campaign day
 *  - Time-filter ALL activity to the campaign's daily window (city timezone)
 *  - All-or-nothing daily KPI evaluation
 *  - Run progression with reward multiplier: reward = base * multiplier^(day-1)
 *  - Fail → close run, payout processed, restart Day 1 on next eligible day
 *  - Multi-run support within one campaign
 *  - Idempotent payouts (never pay twice)
 *  - Audit trail of every daily evaluation
 */
"use strict";

const { dayWindow, campaignDays, inWindow } = require("./timeWindow");
const { evaluateDay } = require("./kpis");

const STATUS = {
  ACTIVE: "active",
  FAILED: "failed",
  COMPLETED: "completed", // campaign ended
};

/**
 * @param {object} cfg campaign config
 *  { id, name, startDate, endDate, dailyStart, dailyEnd, timezone,
 *    baseReward, multiplier, targets[] }
 * @param {object} store persistence adapter (see store.js)
 */
function createEngine(cfg, store) {
  const days = campaignDays(cfg.startDate, cfg.endDate);
  const windows = new Map(days.map((d) => [d, dayWindow(d, cfg, cfg.timezone)]));

  /** Filter raw activity to a single day's window. */
  function filterDay(activity, day) {
    const win = windows.get(day);
    const inW = (ts) => inWindow(ts, win);
    return {
      trips: (activity.trips || []).filter((t) => inW(t.completedAt)),
      requests: (activity.requests || []).filter((r) => inW(r.at)),
      onlineSessions: (activity.onlineSessions || []).filter((s) => inW(s.startedAt)),
      shifts: (activity.shifts || []).filter((s) => inW(s.startedAt)),
    };
  }

  function rewardForDay(runDay) {
    return Math.round(cfg.baseReward * Math.pow(cfg.multiplier, runDay - 1) * 100) / 100;
  }

  /**
   * Evaluate a driver for a specific campaign day.
   * Returns the persisted streak state (see spec §9 field list).
   */
  async function evaluate(driverId, day, activity) {
    const dayActivity = filterDay(activity, day);
    const evalResult = evaluateDay(dayActivity, cfg.targets);

    const state = (await store.getState(driverId, cfg.id)) || freshState(driverId, day);

    // --- idempotency: the same campaign day is evaluated at most once ---
    // (prevents double payout when a scheduled job / message is re-delivered)
    if ((state.evaluatedDays || []).includes(day)) {
      return state;
    }

    // --- decide outcome ---
    let next = { ...state };
    if (evalResult.met) {
      next.currentRunDay = state.currentRunDay + 1;
      next.completedToday = true;
      next.todayReward = rewardForDay(next.currentRunDay);
      next.nextReward = rewardForDay(next.currentRunDay + 1);
      next.totalEarned = Math.round((state.totalEarned + next.todayReward) * 100) / 100;
      next.lastCompletedDay = day;
      next.failureReason = null;
      next.streakStatus = STATUS.ACTIVE;
    } else {
      // FAIL: close the run, trigger payout, reset for a possible new run.
      next.completedToday = false;
      next.todayReward = 0;
      next.failureReason = evalResult.failureReason;
      next.streakStatus = STATUS.FAILED;

      const payout = await store.payout({
        driverId,
        campaignId: cfg.id,
        runId: state.runId,
        runDay: state.currentRunDay,
        amount: state.totalEarned,
        reason: evalResult.failureReason,
        day,
      });
      next.lastPayout = payout;
      next.payoutStatus = payout.paid ? "paid" : "duplicate-suppressed";

      // Reset for next eligible day (new run starts Day 1 / base reward).
      next.currentRunDay = 0;
      next.runId = next.runId + 1;
      next.nextReward = rewardForDay(1);
      next.totalEarned = 0; // paid out; fresh run keeps its own total
    }

    next.updatedAt = day;
    next.evaluatedDays = [...(state.evaluatedDays || []), day];

    // --- audit ---
    await store.appendAudit({
      driverId,
      campaignId: cfg.id,
      day,
      window: windows.get(day),
      met: evalResult.met,
      failureReason: evalResult.failureReason,
      results: evalResult.results.map((r) => ({ type: r.type, met: r.met, progress: r.progress })),
      reward: next.todayReward,
    });

    await store.saveState(next);
    return next;
  }

  function freshState(driverId, day) {
    return {
      driverId,
      campaignId: cfg.id,
      streakStatus: STATUS.ACTIVE,
      currentRunId: 1,
      runId: 1,
      currentRunDay: 0, // no day completed yet
      completedToday: false,
      todayProgress: null,
      todayReward: 0,
      nextReward: rewardForDay(1),
      totalEarned: 0,
      payoutStatus: "none",
      lastCompletedDay: null,
      failureReason: null,
      evaluatedDays: [],
      lastPayout: null,
      updatedAt: day,
    };
  }

  /** Campaign status + reward projection for the dashboard API. */
  async function getStatus(driverId) {
    const state = await store.getState(driverId, cfg.id);
    if (!state) return freshState(driverId, cfg.startDate);
    return state;
  }

  return { evaluate, getStatus, days, windows, rewardForDay };
}

module.exports = { createEngine, STATUS };
