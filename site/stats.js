// Watch statuses and the time-watched maths, shared by the tracker and the public profile page.

export const STATUSES = [
  ['planned', 'Planned'],
  ['watching', 'Watching'],
  ['completed', 'Completed'],
  ['on_hold', 'On hold'],
  ['dropped', 'Dropped'],
];
export const STATUS_LABEL = Object.fromEntries(STATUSES);

// Minutes for one full watch-through.
export function fullMinutes(e) {
  if (e.kind === 'movie') return e.runtime_minutes ?? 0;
  return (e.episodes ?? e.episodes_watched) * (e.episode_minutes ?? 0);
}

// Minutes actually spent: the first pass (partial unless completed) plus every rewatch.
export function minutesWatched(e) {
  if (e.status === 'planned') return 0;
  const full = fullMinutes(e);
  let first;
  if (e.status === 'completed') first = full;
  else if (e.kind === 'movie') first = 0;
  else first = Math.min(e.episodes_watched, e.episodes ?? Infinity) * (e.episode_minutes ?? 0);
  return first + e.rewatch_count * full;
}

export function fmtDuration(min) {
  if (!min) return '0m';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ');
}
