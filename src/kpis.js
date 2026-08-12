/**
 * kpis.js — Per-day KPI evaluators.
 *
 * Every evaluator receives the day's *already time-filtered* activity and a
 * target config, and returns { met, progress, detail }.
 *
 * Supported target types (per spec section 4 + extended examples):
 *   trips_completed : count of completed trips
 *   rating          : average (or count-mode) rating of qualifying trips
 *   acceptance_rate : acceptedRequests / totalRequests
 *   online_time     : aggregated online minutes across sessions
 *   shifts          : count of shifts that are accepted AND completed
 *   earnings        : sum of fares from completed trips
 */
"use strict";

function tripsCompleted(activity, target) {
  const trips = activity.trips.filter((t) => t.status === "completed");
  const met = trips.length >= (target.count ?? 1);
  return { met, progress: trips.length, detail: { countedTrips: trips.length } };
}

function rating(activity, target) {
  // Only completed trips carry ratings.
  const rated = activity.trips.filter((t) => t.status === "completed" && typeof t.rating === "number");
  const mode = target.mode || "average";
  if (mode === "count") {
    // e.g. "at least 1 five-star rating"
    const threshold = target.star ?? 5;
    const matches = rated.filter((t) => t.rating >= threshold).length;
    return { met: matches >= (target.count ?? 1), progress: matches, detail: { mode, matches } };
  }
  // average mode
  if (rated.length === 0) {
    return { met: false, progress: 0, detail: { mode, ratedTrips: 0, average: null } };
  }
  const avg = rated.reduce((s, t) => s + t.rating, 0) / rated.length;
  const min = target.min ?? 5.0;
  return { met: avg >= min, progress: avg, detail: { mode, ratedTrips: rated.length, average: avg, min } };
}

function acceptanceRate(activity, target) {
  const total = activity.requests.length;
  const accepted = activity.requests.filter((r) => r.accepted).length;
  const min = target.min ?? 1.0;
  if (total === 0) {
    // Spec Example 4 — recommended: no participation = FAIL.
    return { met: false, progress: 0, detail: { total: 0, accepted: 0, rate: null, edge: "zero-activity-fail" } };
  }
  const rate = accepted / total;
  return { met: rate >= min, progress: rate, detail: { total, accepted, rate } };
}

function onlineTime(activity, target) {
  const minutes = activity.onlineSessions.reduce((s, sess) => s + (sess.durationMinutes || 0), 0);
  const need = target.minutes ?? 60;
  return { met: minutes >= need, progress: minutes, detail: { minutes, need } };
}

function shifts(activity, target) {
  const done = activity.shifts.filter((s) => s.accepted && s.completed).length;
  return { met: done >= (target.count ?? 1), progress: done, detail: { completedShifts: done } };
}

function earnings(activity, target) {
  // Earnings only from qualifying COMPLETED trips within the window.
  const sum = activity.trips
    .filter((t) => t.status === "completed")
    .reduce((s, t) => s + (t.fare ?? 0), 0);
  return { met: sum >= (target.amount ?? 0), progress: sum, detail: { earnings: sum, need: target.amount ?? 0 } };
}

const EVALUATORS = {
  trips_completed: tripsCompleted,
  rating,
  acceptance_rate: acceptanceRate,
  online_time: onlineTime,
  shifts,
  earnings,
};

/**
 * Evaluate all targets for one day. ALL must pass (spec: no partial credit).
 * @returns {{met: boolean, results: Array, failureReason: string|null}}
 */
function evaluateDay(activity, targets) {
  const results = targets.map((t) => {
    const fn = EVALUATORS[t.type];
    if (!fn) return { type: t.type, met: false, progress: null, detail: { error: `unknown target type: ${t.type}` } };
    const r = fn(activity, t);
    return { type: t.type, target: t, ...r };
  });
  const failed = results.filter((r) => !r.met);
  return {
    met: failed.length === 0,
    results,
    failureReason: failed.length ? failed[0].type : null,
  };
}

module.exports = { evaluateDay, EVALUATORS };
