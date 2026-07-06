/**
 * TWO staleness bounds, not one (per the plan):
 *  - alertSec (STRICT, ~1 poll interval): older than this -> NEVER evaluate an alert on it. A
 *    stale alert email is irreversible.
 *  - displaySec (LENIENT): older than this -> the UI flags it; a stale display self-corrects.
 * We answer both questions independently rather than collapsing to one enum.
 */
export interface StalenessResult {
  ageSeconds: number;
  okForAlerts: boolean; // age <= alertSec
  okForDisplay: boolean; // age <= displaySec (else UI should flag "stale")
}

export interface StalenessBounds {
  alertSec: number;
  displaySec: number;
}

/** `asOf` is the quote's PROVIDER timestamp (not when we cached it). */
export function classifyStaleness(asOf: Date, now: Date, b: StalenessBounds): StalenessResult {
  const ageSeconds = (now.getTime() - asOf.getTime()) / 1000;
  return {
    ageSeconds,
    okForAlerts: ageSeconds <= b.alertSec,
    okForDisplay: ageSeconds <= b.displaySec,
  };
}
