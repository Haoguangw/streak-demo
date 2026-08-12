/**
 * run-tests.js — Executable test suite covering the spec's 12 extended
 * examples + reward math + restart + idempotent payout + timezone.
 *
 * Run: node test/run-tests.js
 */
"use strict";

const { createEngine } = require("../src/engine");
const { createStore } = require("../src/store");
const { localToUtc } = require("../src/timeWindow");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name} ${detail ? "— " + JSON.stringify(detail) : ""}`);
  }
}

/** Build a campaign + engine + helper that evaluates a driver across days. */
function makeEnv(cfgOverrides = {}, store) {
  store = store || createStore();
  const cfg = {
    id: "c1",
    name: "Test Campaign",
    startDate: "2026-02-01",
    endDate: "2026-02-05",
    dailyStart: "12:00",
    dailyEnd: "21:00",
    timezone: "Asia/Kolkata", // UTC+5:30 (no DST) — also tests non-integer offset
    baseReward: 5,
    multiplier: 1.5,
    targets: [{ type: "trips_completed", count: 1 }],
    ...cfgOverrides,
  };
  const engine = createEngine(cfg, store);
  const t = (h, m, day = "2026-02-01") => localToUtc(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, cfg.timezone);
  return { engine, cfg, t };
}

async function main() {
  console.log("\n=== Spec Example 1: strict window filtering (3 trips, 12:00–21:00) ===\n");
  {
    const { engine, t } = makeEnv({ targets: [{ type: "trips_completed", count: 3 }] });
    const act = {
      trips: [
        { id: "a", status: "completed", completedAt: t(9, 0) },   // outside → ignored
        { id: "b", status: "completed", completedAt: t(13, 0) },  // in
        { id: "c", status: "completed", completedAt: t(15, 0) },  // in
        { id: "d", status: "completed", completedAt: t(20, 0) },  // in
      ],
    };
    const s = await engine.evaluate("d1", "2026-02-01", act);
    check("3 in-window trips → PASS (day completed)", s.completedToday === true && s.currentRunDay === 1);
    check("reward Day 1 = base", s.todayReward === 5);
  }

  console.log("\n=== Spec Example 2: failing because of time misalignment ===\n");
  {
    const { engine, t } = makeEnv({ targets: [{ type: "trips_completed", count: 5 }] });
    const act = {
      trips: [
        { id: "a", status: "completed", completedAt: t(10, 0) }, // outside
        { id: "b", status: "completed", completedAt: t(10, 30) },
        { id: "c", status: "completed", completedAt: t(10, 45) },
        { id: "d", status: "completed", completedAt: t(18, 0) },  // in
        { id: "e", status: "completed", completedAt: t(19, 0) },  // in
      ],
    };
    const s = await engine.evaluate("d2", "2026-02-01", act);
    check("only 2 counted → FAIL", s.completedToday === false && s.failureReason === "trips_completed");
    check("run closed, payout triggered", s.lastPayout && s.lastPayout.paid === true);
  }

  console.log("\n=== Spec Example 3: rating KPI (average vs count) ===\n");
  {
    const { engine, t } = makeEnv({ targets: [{ type: "rating", mode: "average", min: 5.0 }] });
    const s = await engine.evaluate("d3", "2026-02-01", {
      trips: [
        { id: "a", status: "completed", completedAt: t(13, 0), rating: 5 },
        { id: "b", status: "completed", completedAt: t(14, 0), rating: 4 },
      ],
    });
    check("avg 4.5 < 5.0 → FAIL", s.completedToday === false && s.failureReason === "rating");

    const { engine: e2, t: t2 } = makeEnv({ targets: [{ type: "rating", mode: "count", star: 5, count: 1 }] });
    const s2 = await e2.evaluate("d4", "2026-02-01", {
      trips: [
        { id: "a", status: "completed", completedAt: t2(13, 0), rating: 4 },
        { id: "b", status: "completed", completedAt: t2(14, 0), rating: 5 },
      ],
    });
    check("at least one 5-star → PASS", s2.completedToday === true);
  }

  console.log("\n=== Spec Example 4: acceptance rate edge (0 requests) ===\n");
  {
    const { engine } = makeEnv({ targets: [{ type: "acceptance_rate", min: 1.0 }] });
    const s = await engine.evaluate("d5", "2026-02-01", { requests: [] });
    check("0 requests → FAIL (no participation, recommended)", s.completedToday === false);
  }

  console.log("\n=== Spec Example 5: online time aggregated across sessions ===\n");
  {
    const { engine, t } = makeEnv({ targets: [{ type: "online_time", minutes: 60 }] });
    const s = await engine.evaluate("d6", "2026-02-01", {
      onlineSessions: [
        { startedAt: t(12, 0), durationMinutes: 20 },
        { startedAt: t(13, 0), durationMinutes: 25 },
        { startedAt: t(14, 0), durationMinutes: 20 },
      ],
    });
    check("20+25+20 = 65 min ≥ 60 → PASS", s.completedToday === true);
  }

  console.log("\n=== Spec Example 6+7: fail breaks run, restart starts Day 1 ===\n");
  {
    const { engine, t } = makeEnv();
    const day1 = await engine.evaluate("d7", "2026-02-01", { trips: [{ id: "a", status: "completed", completedAt: t(13, 0) }] });
    const day2 = await engine.evaluate("d7", "2026-02-02", { trips: [{ id: "b", status: "completed", completedAt: t(13, 0, "2026-02-02") }] });
    check("Day1 ✅ runDay=1, reward=5", day1.completedToday && day1.currentRunDay === 1 && day1.todayReward === 5);
    check("Day2 ✅ runDay=2, reward=7.5 (5×1.5)", day2.completedToday && day2.currentRunDay === 2 && day2.todayReward === 7.5);
    const day3 = await engine.evaluate("d7", "2026-02-03", { trips: [] }); // FAIL
    check("Day3 ❌ run broken", day3.completedToday === false);
    check("payout = accumulated 12.5", day3.lastPayout.paid && day3.lastPayout.amount === 12.5);
    const day4 = await engine.evaluate("d7", "2026-02-04", { trips: [{ id: "c", status: "completed", completedAt: t(13, 0, "2026-02-04") }] });
    check("Day4 = new run Day 1, base reward", day4.completedToday && day4.currentRunDay === 1 && day4.todayReward === 5);
    check("totalEarned reset after payout", day4.totalEarned === 5);
  }

  console.log("\n=== Spec Example 8: multi-KPI, ALL must pass ===\n");
  {
    const { engine, t } = makeEnv({
      targets: [
        { type: "trips_completed", count: 2 },
        { type: "acceptance_rate", min: 1.0 },
      ],
    });
    const s = await engine.evaluate("d8", "2026-02-01", {
      trips: [
        { id: "a", status: "completed", completedAt: t(13, 0) },
        { id: "b", status: "completed", completedAt: t(14, 0) },
      ],
      requests: [
        { id: "r1", at: t(13, 0), accepted: true },
        { id: "r2", at: t(14, 0), accepted: false }, // 80% → FAIL
      ],
    });
    check("trips ✅ but acceptance 80% → FAIL", s.completedToday === false && s.failureReason === "acceptance_rate");
  }

  console.log("\n=== Spec Example 9: boundary inclusivity ===\n");
  {
    const { engine, t } = makeEnv();
    const s = await engine.evaluate("d9", "2026-02-01", {
      trips: [
        { id: "start", status: "completed", completedAt: t(12, 0) },   // exact start → counts
        { id: "end", status: "completed", completedAt: t(21, 0) },     // exact end → counts
      ],
    });
    check("12:00 and 21:00 both count (inclusive)", s.completedToday === true && s.currentRunDay === 1);
  }

  console.log("\n=== Spec Example 11: earnings from completed trips only ===\n");
  {
    const { engine, t } = makeEnv({ targets: [{ type: "earnings", amount: 50 }] });
    const s = await engine.evaluate("d10", "2026-02-01", {
      trips: [
        { id: "a", status: "completed", completedAt: t(13, 0), fare: 30 },
        { id: "b", status: "completed", completedAt: t(15, 0), fare: 25 },
        { id: "c", status: "cancelled", completedAt: t(16, 0), fare: 999 }, // excluded
      ],
    });
    check("30+25 = 55 ≥ 50 → PASS (cancelled excluded)", s.completedToday === true);
  }

  console.log("\n=== Spec Example 12: shift must be accepted AND completed ===\n");
  {
    const { engine, t } = makeEnv({ targets: [{ type: "shifts", count: 1 }] });
    const s = await engine.evaluate("d11", "2026-02-01", {
      shifts: [{ id: "s1", startedAt: t(13, 0), accepted: true, completed: false }],
    });
    check("accepted but not completed → FAIL", s.completedToday === false && s.failureReason === "shifts");
  }

  console.log("\n=== Idempotent payout: same run never paid twice ===\n");
  {
    const store = createStore();
    const { engine } = makeEnv({}, store);
    await engine.evaluate("d12", "2026-02-01", { trips: [] }); // fail → payout
    // Re-running the same day must NOT double-pay (runId unchanged, dedup by runId)
    await engine.evaluate("d12", "2026-02-01", { trips: [] });
    const payouts = store.listPayouts().filter((p) => p.driverId === "d12");
    check("exactly 1 payout record", payouts.length === 1);
  }

  console.log("\n=== Timezone correctness (Asia/Kolkata UTC+5:30) ===\n");
  {
    const { engine, t } = makeEnv();
    // 12:00 IST = 06:30 UTC; 21:00 IST = 15:30 UTC. A trip at 06:29 UTC is OUTSIDE.
    const outsideUtc = Date.parse("2026-02-01T06:29:00Z");
    const insideUtc = Date.parse("2026-02-01T06:30:00Z");
    const s = await engine.evaluate("d13", "2026-02-01", {
      trips: [
        { id: "x", status: "completed", completedAt: outsideUtc },
        { id: "y", status: "completed", completedAt: insideUtc },
      ],
    });
    check("06:29Z excluded, 06:30Z included", s.completedToday === true && s.currentRunDay === 1);
    check("window boundaries correct", t(12, 0) === Date.parse("2026-02-01T06:30:00Z") && t(21, 0) === Date.parse("2026-02-01T15:30:00Z"));
  }

  console.log("\n=== Campaign ends: status reflects completed ===\n");
  {
    const { engine } = makeEnv({ endDate: "2026-02-02" });
    await engine.evaluate("d14", "2026-02-01", { trips: [{ id: "a", status: "completed", completedAt: Date.parse("2026-02-01T13:00:00+05:30") }] });
    await engine.evaluate("d14", "2026-02-02", { trips: [{ id: "b", status: "completed", completedAt: Date.parse("2026-02-02T13:00:00+05:30") }] });
    const s = await engine.getStatus("d14");
    check("2 days completed, total = 5 + 7.5 = 12.5", s.currentRunDay === 2 && s.totalEarned === 12.5);
    check("audit trail has 2 entries", s.evaluatedDays.length === 2);
  }

  console.log("\n================================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("FAILED:", failures.join(", "));
    process.exit(1);
  }
  console.log("ALL TESTS PASSED ✅");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
