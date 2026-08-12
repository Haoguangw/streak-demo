# Streak Rewards — Backend Core Logic (Reference Implementation)

A clean-room, dependency-free Node.js implementation of the **Monochrome
driver streak** incentive engine, built directly from the project spec
(12 extended examples + developer checklist).

**Zero npm dependencies** — runs on plain Node.js, engineered to drop into an
existing well-structured backend (the persistence layer is a 4-method
interface you swap for the project's DB).

## Run it

```bash
node test/run-tests.js   # 23 assertions, all spec examples covered
node demo.js             # end-to-end walkthrough: 3-day run → fail → restart
```

## What it implements (spec compliance)

| Spec requirement | Where |
|---|---|
| Daily evaluation per driver, per campaign day | `src/engine.js` `evaluate()` |
| **City-timezone** daily windows (IANA, DST-safe, inclusive boundaries) | `src/timeWindow.js` |
| Time-window filtering: only in-window activity counts | `filterDay()` |
| KPI types: trips / rating / acceptance / online time / shifts / earnings | `src/kpis.js` |
| All-KPIs-must-pass, no partial credit | `evaluateDay()` |
| Reward = base × multiplier^(runDay−1), grows only on unbroken streak | `rewardForDay()` |
| Fail → run closes, payout processed, restart Day 1 / base reward | `engine.js` fail branch |
| Multiple runs per campaign supported | `runId` + reset logic |
| **Idempotent payout** (same run never paid twice) | `src/store.js` `payout()` |
| Daily evaluation idempotency (re-delivered job ≠ double pay) | `evaluate()` early return |
| Audit trail of every daily evaluation | `store.appendAudit()` |
| Status fields for the app: runDay / completedToday / todayReward / nextReward / totalEarned / payoutStatus / streakStatus / failureReason | `getStatus()` / state object |
| Mobile apps compute nothing — backend returns everything | state object is API-ready |

## Architecture

```
streak-demo/
├── src/
│   ├── timeWindow.js   IANA timezone → per-day UTC windows (DST-safe)
│   ├── kpis.js         6 KPI evaluators, all-or-nothing aggregation
│   ├── engine.js       state machine: run progression, restart, payout trigger
│   └── store.js        persistence contract (in-memory ref impl) + idempotent payouts + audit
├── test/run-tests.js   23 assertions mirroring spec examples 1–12 + timezone + idempotency
├── demo.js             end-to-end scripted scenario
```

## Key design decisions

1. **Persistence is 4 methods**: `getState`, `saveState`, `payout`, `appendAudit`.
   The engine never touches SQL/Redis directly — swap in the client's data
   layer in one file.
2. **Idempotency at two levels**: payout dedup by `(campaign, driver, runId)`,
   plus daily evaluation dedup — a cron/SQS re-delivery can't double-pay.
3. **Timezone via `Intl`**: no dependency, correct across DST; boundaries are
   inclusive per spec Example 9.
4. **Edge cases from the spec**: 0-activity day = fail (Example 4, recommended
   option); midnight-spanning windows handled; cancelled trips excluded from
   earnings; shifts require accepted **and** completed.

## Integration notes (for the real project)

- Replace `createStore()` with adapters over the client's DB; engine contract
  stays identical.
- Activity ingestion: pass per-driver raw events (trips, requests, online
  sessions, shifts) for the day being evaluated; the engine time-filters.
- Payouts: `store.payout()` is where the client hooks their wallet/payment
  gateway — idempotency key is `campaignId:driverId:runId`.
