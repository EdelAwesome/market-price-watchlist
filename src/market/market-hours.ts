/**
 * NYSE regular-session awareness so the poll cycle doesn't burn quota at 3am. Timezone is handled
 * via Intl (America/New_York) so DST is correct without a tz dependency. Holidays are a static set
 * (documented in DECISIONS as a maintained list); early-close half-days are treated as full days
 * for MVP (a conservative over-inclusion — we might poll during a closed half-hour, never miss one).
 */

// NYSE full-day holidays (America/New_York), 2025–2026. Maintain as the calendar rolls forward.
export const NYSE_HOLIDAYS_2025_2026 = new Set<string>([
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Jr. Day
  '2025-02-17', // Washington's Birthday
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03', // Independence Day observed
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

interface EtParts {
  weekday: string; // 'Mon'..'Sun'
  ymd: string; // 'YYYY-MM-DD'
  minutesOfDay: number; // minutes since ET midnight
}

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function etParts(date: Date): EtParts {
  const parts = etFormatter.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00'; // Intl can emit 24 at midnight
  return {
    weekday: get('weekday'),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: Number(hour) * 60 + Number(get('minute')),
  };
}

const OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const CLOSE_MIN = 16 * 60; // 16:00 ET

export interface MarketCalendarOptions {
  holidays?: Set<string>;
}

export class MarketCalendar {
  private readonly holidays: Set<string>;
  constructor(opts: MarketCalendarOptions = {}) {
    this.holidays = opts.holidays ?? NYSE_HOLIDAYS_2025_2026;
  }

  isOpen(date: Date): boolean {
    const { weekday, ymd, minutesOfDay } = etParts(date);
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    if (this.holidays.has(ymd)) return false;
    return minutesOfDay >= OPEN_MIN && minutesOfDay < CLOSE_MIN;
  }
}
