export function formatFullDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatTimeOnly(date: Date | string | null | undefined): string {
  if (!date) return '--:--';
  const d = typeof date === 'string' ? parseFlexibleDate(date) : date;
  if (!d) return typeof date === 'string' ? date : '--:--';
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatSecondsToHMS(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const rem = secs % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function formatSecondsToHmText(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Monday=0 … Sunday=6 */
export function getTodayDayIndex(date = new Date()): number {
  const day = date.getDay();
  return day === 0 ? 6 : day - 1;
}

/** Monday of the week containing `date` (local time). */
export function getWeekMonday(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function parseFlexibleDate(value: string): Date | null {
  if (!value) return null;
  // ISO or datetime-local style
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  // HH:mm:ss on today's date
  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (timeOnly) {
    const d = new Date();
    d.setHours(
      Number(timeOnly[1]),
      Number(timeOnly[2]),
      Number(timeOnly[3] || 0),
      0
    );
    return d;
  }
  return null;
}

export function secondsBetween(
  start: string | null | undefined,
  end: Date | string | null | undefined = new Date()
): number {
  if (!start) return 0;
  const a = parseFlexibleDate(start);
  const b =
    typeof end === 'string'
      ? parseFlexibleDate(end)
      : end instanceof Date
        ? end
        : new Date();
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 1000));
}

export function shortDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
