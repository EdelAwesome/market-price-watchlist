/** Injectable time source. Real code uses systemClock; tests use FakeClock to control now(). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
  set(d: Date): void {
    this.t = new Date(d);
  }
}

/** A sleep bound to a FakeClock: "waiting" simply advances virtual time (no real delay). */
export const fakeSleep = (clock: FakeClock) => async (ms: number): Promise<void> => {
  clock.advance(ms);
};

export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
