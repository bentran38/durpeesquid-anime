// Turns a MyAnimeList "Export My List" file into library rows. Pure helpers, no network:
// app.js looks the titles up on AniList (by MAL id) and calls buildRow with each match.

// MAL downloads the export gzipped (animelist_*.xml.gz); a plain .xml works too.
export async function readExportText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(buf);
}

const STATUS = {
  watching: 'watching',
  completed: 'completed',
  'on-hold': 'on_hold',
  onhold: 'on_hold',
  dropped: 'dropped',
  'plan to watch': 'planned',
  plantowatch: 'planned',
  // numeric codes used by some exporters
  1: 'watching',
  2: 'completed',
  3: 'on_hold',
  4: 'dropped',
  6: 'planned',
};

const toInt = (s) => Math.max(0, Number.parseInt(s, 10) || 0);

// MAL writes 0000-00-00 (or partial dates like 2018-00-00) when a date is unset.
function toDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m && +m[1] && +m[2] && +m[3] ? s : null;
}

export function parseMalExport(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not valid XML.');
  const nodes = [...doc.querySelectorAll('anime')];
  if (!nodes.length) throw new Error('No anime found. Export your anime list from MyAnimeList and try again.');

  const text = (n, tag) => n.querySelector(tag)?.textContent.trim() ?? '';
  const seen = new Set();
  const items = [];
  for (const n of nodes) {
    const malId = Number.parseInt(text(n, 'series_animedb_id'), 10);
    if (!(malId > 0) || seen.has(malId)) continue;
    seen.add(malId);
    items.push({
      malId,
      title: text(n, 'series_title'),
      status: STATUS[text(n, 'my_status').toLowerCase()] ?? 'planned',
      watched: toInt(text(n, 'my_watched_episodes')),
      score: toInt(text(n, 'my_score')),
      times: toInt(text(n, 'my_times_watched')),
      startedOn: toDate(text(n, 'my_start_date')),
      finishedOn: toDate(text(n, 'my_finish_date')),
      notes: text(n, 'my_comments'),
    });
  }
  return items;
}

// Combines one parsed MAL item with the AniList entry it matched into a tracker_entries row.
export function buildRow(item, entry) {
  const { startedOn } = item;
  // The table rejects finishing before starting; drop an inconsistent finish date rather than the title.
  const finishedOn = startedOn && item.finishedOn && item.finishedOn < startedOn ? null : item.finishedOn;

  let watched = 0;
  if (entry.kind === 'series' && item.status !== 'planned') {
    watched = item.status === 'completed' && entry.episodes != null ? entry.episodes : item.watched;
    if (entry.episodes != null) watched = Math.min(watched, entry.episodes);
  }

  return {
    ...entry,
    status: item.status,
    episodes_watched: watched,
    rewatch_count: item.times,
    rating: item.score >= 1 && item.score <= 10 ? item.score : null, // MAL uses 0 for "no score"
    started_on: startedOn,
    finished_on: finishedOn,
    notes: item.notes,
  };
}
