// How far the partner's computer clock is from ours, estimated from their saves: Eagle stamps each
// item it saves with its own Date.now(), and we see the save arrive a little later. So
// "their stamp - when it arrived" is their clock minus ours, minus the delivery time: a lower
// bound. The largest of recent samples is the fastest delivery, the best estimate. (Why it
// matters: their Eagle skips an edit whose value isn't at least 500 ms in its past,
// eagle/stamp.ts; and their timestamps are how we tell whether their Eagle is running now.)
//
// A backlog Dropbox delivers after hours offline looks like a clock far behind, so the estimate is
// trusted only once several samples arrived spread over a couple of minutes, and only while their
// stamps span about as much time as the arrivals: a backlog squeezes an evening of saves into a
// few minutes of downloading (review5 should-fix 1). Only the last day counts (clocks drift, and
// get fixed).

export const CLOCK_RULES = {
  keepMs: 24 * 60 * 60_000,
  maxSamples: 50,
  minSamples: 3,
  minSpreadMs: 2 * 60_000,
  /** Stamps spanning this much more time than their arrivals are a backlog, not a clock. */
  maxSquashMs: 60_000,
  /** Warn when their clock seems further behind ours than this (edits start being skipped near 60 s). */
  warnBehindMs: 30_000,
};

interface Sample {
  arrived: number;
  offset: number; // their stamp minus arrival
}

export class PartnerClock {
  private samples: Sample[] = [];

  /** They stamped something `theirTime` (their clock) and we saw it at `arrived` (ours). */
  add(theirTime: number, arrived: number): void {
    if (!Number.isFinite(theirTime) || theirTime <= 0) return;
    this.samples.push({ arrived, offset: theirTime - arrived });
    const old = arrived - CLOCK_RULES.keepMs;
    this.samples = this.samples.filter((x) => x.arrived >= old).slice(-CLOCK_RULES.maxSamples);
  }

  /** Their clock minus ours (a lower bound, off by the fastest delivery), or null until it can be trusted. */
  offset(now = Date.now()): number | null {
    const recent = this.samples.filter((x) => x.arrived >= now - CLOCK_RULES.keepMs);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const squashed = (xs: Sample[]) =>
      spread(xs.map((x) => x.arrived + x.offset)) - spread(xs.map((x) => x.arrived)) >
      CLOCK_RULES.maxSquashMs;
    // A backlog among them: estimate from the newer ones, dropping the oldest until the rest
    // agree (a morning backlog must not hide a real offset for the rest of the day, review6).
    while (recent.length >= CLOCK_RULES.minSamples && squashed(recent)) recent.shift();
    if (recent.length < CLOCK_RULES.minSamples) return null;
    if (spread(recent.map((x) => x.arrived)) < CLOCK_RULES.minSpreadMs) return null;
    return Math.max(...recent.map((x) => x.offset));
  }

  /** Their time `t` on our clock (as it is, while their offset isn't known). */
  toOurs(t: number, now = Date.now()): number {
    return t - (this.offset(now) ?? 0);
  }

  /** Plain English when their clock is far enough behind ours to matter, else null. */
  problem(partnerName: string | null, now = Date.now()): string | null {
    const off = this.offset(now);
    if (off === null || off > -CLOCK_RULES.warnBehindMs) return null;
    const behind = -off;
    const amount =
      behind < 90_000
        ? `${Math.round(behind / 1000)} seconds`
        : behind < 90 * 60_000
          ? `${Math.round(behind / 60_000)} minutes`
          : `${Math.round(behind / 3_600_000)} hours`;
    const who = partnerName ?? 'your partner';
    const whose = partnerName ? `${partnerName}'s` : "Your partner's";
    return `${whose} computer clock seems about ${amount} behind yours, so their Eagle may miss your edits. Ask ${who} to turn on "Set time automatically" in Windows Settings.`;
  }
}
