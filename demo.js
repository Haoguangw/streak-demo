/**
 * demo.js — End-to-end walkthrough: a driver completes a 3-day run, fails,
 * restarts, and we show the full state + audit + payouts.
 *
 * Run: node demo.js
 */
"use strict";

const { createEngine } = require("./src/engine");
const { createStore } = require("./src/store");
const { localToUtc } = require("./src/timeWindow");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const store = createStore();
  const cfg = {
    id: "CAMPAIGN-001",
    name: "Monochrome Driver Streak — Feb 2026",
    startDate: "2026-02-01",
    endDate: "2026-02-10",
    dailyStart: "12:00",
    dailyEnd: "21:00",
    timezone: "Asia/Kolkata", // UTC+5:30
    baseReward: 5,
    multiplier: 1.5,
    targets: [
      { type: "trips_completed", count: 3 },
      { type: "acceptance_rate", min: 1.0 },
      { type: "online_time", minutes: 60 },
    ],
  };
  const engine = createEngine(cfg, store);
  const t = (day, h, m) => localToUtc(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, cfg.timezone);

  const driver = "DRV-001";
  const line = "─".repeat(64);

  console.log(`\n${line}\n🏁 CAMPAIGN: ${cfg.name}\n   Window: ${cfg.dailyStart}–${cfg.dailyEnd} ${cfg.timezone}\n   Reward: base £${cfg.baseReward} × ${cfg.multiplier}^(day-1)\n   Targets: 3 trips, 100% acceptance, 60 min online\n${line}`);

  const days = [
    // Day 1 ✅  3 trips, 3/3 accepted, 90 min online
    ["2026-02-01", 3, 1.0, 90],
    // Day 2 ✅  3 trips, 3/3 accepted, 75 min online
    ["2026-02-02", 3, 1.0, 75],
    // Day 3 ✅  3 trips, 3/3 accepted, 65 min online
    ["2026-02-03", 3, 1.0, 65],
    // Day 4 ❌  only 2 trips → fail (run closes, payout issued)
    ["2026-02-04", 2, 1.0, 80],
    // Day 5 ✅  new run, Day 1
    ["2026-02-05", 3, 1.0, 70],
  ];

  for (const [day, trips, acc, mins] of days) {
    const activity = {
      trips: Array.from({ length: trips }, (_, i) => ({
        id: `${day}-t${i}`,
        status: "completed",
        completedAt: t(day, 13 + i, 0),
        fare: 10 + i,
      })),
      requests: Array.from({ length: trips + (acc === 1.0 ? 0 : 1) }, (_, i) => ({
        id: `${day}-r${i}`,
        at: t(day, 13 + i, 0),
        accepted: i < trips,
      })),
      onlineSessions: [{ startedAt: t(day, 12, 0), durationMinutes: mins }],
      shifts: [],
    };
    const s = await engine.evaluate(driver, day, activity);
    const mark = s.completedToday ? "✅" : "❌";
    console.log(`\n${mark} ${day}  ${s.completedToday ? `Day ${s.currentRunDay} — reward £${s.todayReward}` : `FAIL — ${s.failureReason}`}`);
    console.log(`   state: runDay=${s.currentRunDay} todayReward=£${s.todayReward} nextReward=£${s.nextReward} totalEarned=£${s.totalEarned} payout=${s.payoutStatus}`);
    if (!s.completedToday) {
      console.log(`   💸 payout → ${s.lastPayout.paid ? `£${s.lastPayout.amount} (${s.lastPayout.payoutId})` : "duplicate suppressed"}`);
    }
    await sleep(50);
  }

  const final = await engine.getStatus(driver);
  console.log(`\n${line}\n📊 FINAL STATUS (API response):\n${JSON.stringify(final, null, 2)}`);
  console.log(`\n📝 AUDIT TRAIL (${store.listAudits().filter((a) => a.driverId === driver).length} evaluations logged)`);
  for (const a of store.listAudits().filter((a) => a.driverId === driver)) {
    console.log(`   ${a.day}  ${a.met ? "✅" : "❌"}  ${a.failureReason || "all targets met"}`);
  }
  console.log(`\n💰 PAYOUTS (${store.listPayouts().filter((p) => p.driverId === driver).length}):`);
  for (const p of store.listPayouts().filter((p) => p.driverId === driver)) {
    console.log(`   ${p.payoutId}  £${p.amount}  reason=${p.reason}  paid=${p.paid}`);
  }
  console.log(`${line}\n`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
