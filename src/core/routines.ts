import type { RoutineSchedule } from '../shared/types.ts';
import { CodeBotError } from './util.ts';

/**
 * When routines run. Times are the computer's local time, as the user set them
 * up; a daily routine at 09:00 stays at 09:00 across daylight-saving changes.
 */

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Checks a schedule from outside (the window, later a remote client) and returns a clean copy. */
export function cleanSchedule(value: unknown): RoutineSchedule {
  const schedule = (value ?? {}) as Record<string, unknown>;
  switch (schedule.kind) {
    case 'once': {
      const at = new Date(String(schedule.at ?? ''));
      if (Number.isNaN(at.getTime())) throw new CodeBotError('invalid', 'Pick the date and time for the routine');
      return { kind: 'once', at: at.toISOString() };
    }
    case 'daily': {
      const time = String(schedule.time ?? '');
      if (!TIME.test(time)) throw new CodeBotError('invalid', 'Give the time of day as HH:MM, for example 09:00');
      const days = Array.isArray(schedule.days) ? schedule.days : [];
      const clean = [...new Set(days.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
      if (clean.length === 0) throw new CodeBotError('invalid', 'Pick at least one day of the week');
      return { kind: 'daily', time, days: clean };
    }
    case 'interval': {
      const minutes = Number(schedule.minutes);
      if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        throw new CodeBotError(
          'invalid',
          `Repeat every ${MIN_INTERVAL_MINUTES} minutes at the most often, and at least once a week (${MAX_INTERVAL_MINUTES} minutes)`,
        );
      }
      return { kind: 'interval', minutes };
    }
    default:
      throw new CodeBotError('invalid', 'A routine runs once, daily on chosen days, or at an interval');
  }
}

/**
 * The first run strictly after `after`, or null when there is none (a "once"
 * routine whose time has passed). Interval routines keep their rhythm from
 * `anchor` (when they were set up, or their last planned run).
 */
export function nextRun(schedule: RoutineSchedule, after: Date, anchor: Date = after): Date | null {
  switch (schedule.kind) {
    case 'once': {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : null;
    }
    case 'daily': {
      const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
      for (let offset = 0; offset <= 7; offset += 1) {
        const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, hours, minutes, 0, 0);
        if (day.getTime() > after.getTime() && schedule.days.includes(day.getDay())) return day;
      }
      return null;
    }
    case 'interval': {
      const step = schedule.minutes * 60_000;
      const start = anchor.getTime();
      const steps = Math.max(1, Math.floor((after.getTime() - start) / step) + 1);
      return new Date(start + steps * step);
    }
  }
}
