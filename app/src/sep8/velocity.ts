// Velocity windows. Pure functions over spend/reservation entries.
import { localDay } from '../config.js';
import type { SpendEntry } from './types.js';

export const WEEK_SECONDS = 168 * 3600;

/** A spend always counts; a reservation counts while it is live (now < expiresAt). */
export function counts(e: SpendEntry, now: number): boolean {
  if (e.kind === 'spend') return true;
  return e.expiresAt === undefined || now < e.expiresAt;
}

/** Sum for the programme-local calendar day containing `now`. */
export function usedToday(entries: readonly SpendEntry[], now: number, tzOffsetSeconds: number): bigint {
  const day = localDay(now, tzOffsetSeconds);
  let t = 0n;
  for (const e of entries) {
    if (e.at <= now && counts(e, now) && localDay(e.at, tzOffsetSeconds) === day) t += e.amount;
  }
  return t;
}

/** Sum over the rolling window (now - 168 h, now]. */
export function usedWeek(entries: readonly SpendEntry[], now: number): bigint {
  let t = 0n;
  for (const e of entries) {
    if (e.at <= now && e.at > now - WEEK_SECONDS && counts(e, now)) t += e.amount;
  }
  return t;
}
