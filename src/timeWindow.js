/**
 * timeWindow.js — City-timezone daily window calculation.
 *
 * A campaign defines dailyStart/dailyEnd in the CITY's local wall-clock time
 * (e.g. 12:00 → 21:00 in Asia/Kolkata). Each campaign day has its own UTC
 * window derived from the city timezone. Boundaries are INCLUSIVE on both
 * ends (per spec Example 9).
 */
"use strict";

/** Convert a local date-time string (YYYY-MM-DDTHH:mm) in `timeZone` to UTC ms. */
function localToUtc(localDateTime, timeZone) {
  // Use Intl to compute the zone offset for a candidate instant, then iterate
  // to converge (handles DST transitions correctly by construction).
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const toParts = (utcMs) => {
    const p = {};
    for (const part of fmt.formatToParts(new Date(utcMs))) {
      if (part.type !== "literal") p[part.type] = part.value;
    }
    // Intl can return "24" for midnight; normalize.
    if (p.hour === "24") p.hour = "00";
    return p;
  };

  // Initial guess: treat local string as UTC.
  let guess = Date.parse(localDateTime + ":00Z");
  for (let i = 0; i < 3; i++) {
    const p = toParts(guess);
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second)
    );
    const offsetMs = asUtc - guess;
    guess = Date.parse(localDateTime + ":00Z") - offsetMs;
  }
  return guess;
}

/**
 * Compute the UTC window for one campaign day.
 * @param {string} dateStr "YYYY-MM-DD" (city-local calendar day)
 * @param {{dailyStart: string, dailyEnd: string}} cfg "HH:mm"
 * @param {string} timeZone IANA name, e.g. "Asia/Kolkata"
 * @returns {{startUtc: number, endUtc: number}} inclusive boundaries (ms)
 */
function dayWindow(dateStr, cfg, timeZone) {
  const startUtc = localToUtc(`${dateStr}T${cfg.dailyStart}`, timeZone);
  const endUtc = localToUtc(`${dateStr}T${cfg.dailyEnd}`, timeZone);
  if (endUtc < startUtc) {
    // Window spans midnight (e.g. 22:00 → 06:00): end belongs to next day.
    const next = new Date(`${dateStr}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    return {
      startUtc,
      endUtc: localToUtc(`${nextDate}T${cfg.dailyEnd}`, timeZone),
    };
  }
  return { startUtc, endUtc };
}

/** List of campaign day date strings (city-local) between startDate..endDate inclusive. */
function campaignDays(startDate, endDate) {
  const days = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/** Inclusive range check with ms precision. */
function inWindow(tsMs, win) {
  return tsMs >= win.startUtc && tsMs <= win.endUtc;
}

module.exports = { localToUtc, dayWindow, campaignDays, inWindow };
