const dayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC',
});

export function formatDay(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dayFormatter.format(date) : 'Date unavailable';
}

export function formatTime(value: string, seconds = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  const formatted = timeFormatter.format(date);
  return seconds ? formatted : formatted.slice(0, 5);
}

export function utcDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

export function ageLabel(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'Not yet checked';
  const minutes = Math.floor((now - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < -5) return 'Age unavailable';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h ago`;
}

export function gapLabel(earlier: string, later: string): string {
  const minutes = Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 60_000);
  if (minutes < 0) return 'Loop · back to first observation';
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m ` : ''}between observations`;
  return `${Math.max(0, minutes)}m between observations`;
}
