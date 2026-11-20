const DAY_MS = 24 * 60 * 60 * 1000;

function calendarDay(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar label for a receipt timestamp, compared in the local timezone. */
export function formatSmartDate(isoString: string | null | undefined): string {
  if (!isoString) return '';

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date();
  const dayDelta = Math.round((calendarDay(today) - calendarDay(date)) / DAY_MS);
  if (dayDelta === 0) return 'Today';
  if (dayDelta === 1) return 'Yesterday';

  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
