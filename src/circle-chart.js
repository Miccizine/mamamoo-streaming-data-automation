'use strict';

const {
  getSheetsClient, getSheetData, getRegistryData, getPHTTimestamp,
  appendSheetRow, updateSheetRow, getComebackMode,
  getMemberConfig, buildClosingTags, findMatchInRegistry
} = require('./helpers');
const fetch = require('node-fetch');

// ── Config ────────────────────────────────────────────────────────────────────

const ARTIST_TERMS = [
  'MAMAMOO', 'MAMAMOO+',
  'Solar',
  'Moon Byul', 'Moonbyul',
  'Whee In', 'Wheein',
  'Hwa Sa', 'Hwasa', 'HWASA',
];

// Artist name → Discord tags (for posts not needing registry lookup)
const ARTIST_TAG_MAP = {
  'mamamoo+':  { handle: '#MAMAMOOplus', tags: '#MAMAMOOplus #마마무플러스\n#SOLAR #솔라 #ソラ #金容仙\n#MOONBYUL #문별 #ムンビョル #文星伊', closing: '#마마무 @RBW_MAMAMOO' },
  'solar':     { handle: '#SOLAR',       tags: '#SOLAR #솔라 #ソラ #金容仙',                                                                   closing: '#마마무 @RBW_MAMAMOO' },
  'moon byul': { handle: '#MOONBYUL',    tags: '#MOONBYUL #문별 #ムンビョル #文星伊',                                                           closing: '#마마무 @RBW_MAMAMOO' },
  'moonbyul':  { handle: '#MOONBYUL',    tags: '#MOONBYUL #문별 #ムンビョル #文星伊',                                                           closing: '#마마무 @RBW_MAMAMOO' },
  'whee in':   { handle: '#WHEEIN',      tags: '#WHEEIN #휘인 #フィイン #丁輝人',                                                               closing: '#마마무 @WheeIn_0fficial' },
  'wheein':    { handle: '#WHEEIN',      tags: '#WHEEIN #휘인 #フィイン #丁輝人',                                                               closing: '#마마무 @WheeIn_0fficial' },
  'hwa sa':    { handle: '#HWASA',       tags: '#HWASA #화사 #ファサ #華莎',                                                                    closing: '#마마무 @OfficialPnation' },
  'hwasa':     { handle: '#HWASA',       tags: '#HWASA #화사 #ファサ #華莎',                                                                    closing: '#마마무 @OfficialPnation' },
};
const GROUP_TAGS = { handle: '#MAMAMOO', tags: '#MAMAMOO #마마무', closing: '#마마무 #ママム #妈妈木\n@RBW_MAMAMOO' };

const ONOFF_CHARTS = [
  { name: 'Digital Chart',      serviceGbn: 'ALL'   },
  { name: 'Streaming Chart',    serviceGbn: 'S1040' },
  { name: 'Download Chart',     serviceGbn: 'S1020' },
  { name: 'BGM Chart',          serviceGbn: 'S1060' },
  { name: 'V Coloring Chart',   serviceGbn: 'S4010' },
  { name: 'Singing Room Chart', serviceGbn: 'S3010' },
  { name: 'Bell Chart',         serviceGbn: 'S2020' },
  { name: 'Ring Chart',         serviceGbn: 'S2040' },
];

const BASE_URL = 'https://circlechart.kr';
const SHEET    = 'Circle Chart Tracker';

const CERT_SHEET = 'Circle Cert Tracker';
const CERT_TYPES = [
  { serviceGbn: 'ALBUM', label: 'Album' },
  { serviceGbn: 'S1020', label: 'Download' },
  { serviceGbn: 'S1040', label: 'Streaming' },
];

const COL = {
  TRACK_NAME:   0,
  PLATFORM:     1,
  CHART_TYPE:   2,
  CURRENT_POS:  3,
  MOVEMENT:     4,
  PEAK_POS:     5,
  PEAK_DATE:    6,
  ENTRY_DATE:   7,
  LAST_SEEN:    8,
  WEEK:         9,
  REENTRY_DATE: 10,
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function getKSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function getCurrentWeekParams() {
  const now  = getKSTDate();
  const year = now.getFullYear();

  // Circle Chart uses yearTime=1; week number = floor((dayOfYear - 1) / 7) + 1
  const startOfYear = new Date(year, 0, 1);
  const dayOfYear   = Math.floor((now - startOfYear) / 86400000);
  const weekNum     = Math.floor(dayOfYear / 7) + 1;

  return {
    hitYear:    String(year),
    targetTime: String(weekNum).padStart(2, '0'),
    yearTime:   '1',
  };
}

function weekLabel(params) {
  return `${params.hitYear}${params.targetTime}`;
}

function todayPHT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }).replace(/-/g, '');
}

function kstTimestamp() {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(',', '');
}

// ── API callers ───────────────────────────────────────────────────────────────

async function fetchOnoffChart(serviceGbn, params) {
  const body = new URLSearchParams({
    nationGbn:  'T',
    serviceGbn,
    termGbn:    'week',
    hitYear:    params.hitYear,
    targetTime: params.targetTime,
    yearTime:   params.yearTime,
    curUrl:     `circlechart.kr/page_chart/onoff.circle?serviceGbn=${serviceGbn}`,
  });
  const res = await fetch(`${BASE_URL}/data/api/chart/onoff`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${BASE_URL}/page_chart/onoff.circle`,
      'User-Agent':   'Mozilla/5.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`onoff API ${res.status} for ${serviceGbn}`);
  const json = await res.json();
  // List is an object with numeric string keys, not an array
  return Object.values(json.List || {});
}

async function fetchAlbumChart(params) {
  const body = new URLSearchParams({
    nationGbn:  'T',
    termGbn:    'week',
    hitYear:    params.hitYear,
    targetTime: params.targetTime,
    yearTime:   params.yearTime,
    curUrl:     'circlechart.kr/page_chart/album.circle',
  });
  const res = await fetch(`${BASE_URL}/data/api/chart/album`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${BASE_URL}/page_chart/album.circle`,
      'User-Agent':   'Mozilla/5.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`album API ${res.status}`);
  const json = await res.json();
  return Object.values(json.List || {});
}

async function fetchGlobalChart(termGbn, yyyymmdd) {
  const body = new URLSearchParams({ termGbn, yyyymmdd });
  const res = await fetch(`${BASE_URL}/data/api/chart/global`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_chart/global.circle`, 'User-Agent': 'Mozilla/5.0' },
    body,
  });
  if (!res.ok) throw new Error(`global chart API ${res.status}`);
  const json = await res.json();
  return Object.values(json.List || {});
}

async function fetchGlobalDefaultDate(termGbn) {
  const body = new URLSearchParams({ termGbn });
  const res = await fetch(`${BASE_URL}/data/api/chart_func/global/default_value`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_chart/global.circle`, 'User-Agent': 'Mozilla/5.0' },
    body,
  });
  if (!res.ok) throw new Error(`global default_value API ${res.status}`);
  const json = await res.json();
  return json.List && json.List[0] ? json.List[0]['YYYYMMDD'] : '';
}

function getMostRecentMonday() {
  const now = getKSTDate();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const mon = new Date(now);
  mon.setDate(now.getDate() - diff);
  return mon.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).replace(/-/g, '');
}

function todayKST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).replace(/-/g, '');
}

// fix: template was too crowded (separate 🎵/🎤 lines, extra blank lines).
// Now: rank+artist+title+movement on one line, then song/album hashtags +
// handle on one line, then closing tags. Also added song/album hashtag
// lookup against Master Registry — was missing entirely despite the
// standing project rule that all chart/milestone posts include them.
async function postGlobalChartEntry(row, termGbn, dateLabel, registryData) {
  const title  = row.Title  || '';
  const artist = row.Artist || '';
  const rank   = row.Rank   || '';
  const status = (row.RankStatus || '').toLowerCase();
  const movementStr = status === 'new' ? '(NEW)' : status === 'hot' ? '(HOT 🔥)' : '(=)';
  const termLabel   = termGbn === 'day' ? 'Daily' : 'Weekly';
  const tags        = resolveArtistTags(artist);
  const { songHashtags, albumHashtags } = getHashtagsForTitle(title, registryData);

  await sendEmbed({
    title: `[CIRCLE GLOBAL K-POP] ${termLabel} — ${dateLabel}`,
    color: 16744272,
    description: [
      `#${rank} ${artist} - ${title} ${movementStr}`,
      '',
      [songHashtags, albumHashtags, tags.handle].filter(Boolean).join(' '),
      tags.closing,
    ].filter(Boolean).join('\n'),
    footer: { text: '✅ Approve and post manually to X | ❌ Discard' },
  });
}

// ── Retail Album Chart API callers ──────────────────────────────────────────────

async function fetchRetailDefaultDate(termGbn) {
  const body = new URLSearchParams({ termGbn });
  const res = await fetch(`${BASE_URL}/data/api/chart_func/retail/default_value`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_chart/retail.circle?termGbn=${termGbn}`, 'User-Agent': 'Mozilla/5.0' },
    body,
  });
  if (!res.ok) throw new Error(`retail default_value API ${res.status}`);
  const json = await res.json();
  return json.List && json.List[0] ? json.List[0]['YYYYMMDD'] : '';
}

async function fetchRetailList(termGbn, yyyymmdd) {
  const body = new URLSearchParams({ termGbn, yyyymmdd });
  const res = await fetch(`${BASE_URL}/data/api/chart/retail_list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_chart/retail.circle?termGbn=${termGbn}`, 'User-Agent': 'Mozilla/5.0' },
    body,
  });
  if (!res.ok) throw new Error(`retail_list API ${res.status}`);
  const json = await res.json();
  return json.List || [];
}

// fix: same spacing cleanup + hashtag lookup as postGlobalChartEntry
async function postRetailChartEntry(row, label, registryData) {
  const album    = row.Album  || '';
  const artist   = row.Artist || '';
  const rank     = row.RankInt || '';
  const sales    = row.rowSum ? parseInt(row.rowSum, 10).toLocaleString('en-US') : '';
  const status   = (row.RankStatus || '').toLowerCase();
  const movementStr = status === 'new' ? '(NEW)' : status === 'hot' ? '(HOT 🔥)' : (row.CalRank || '(=)');
  const tags     = resolveArtistTags(artist);
  const { songHashtags, albumHashtags } = getHashtagsForTitle(album, registryData);

  await sendEmbed({
    title: `[PHYSICAL] Circle Retail Album Chart — ${label}`,
    color: 16744272,
    description: [
      `#${rank} ${artist} - ${album} ${movementStr}`,
      sales ? `${sales} copies` : '',
      '',
      [songHashtags, albumHashtags, tags.handle].filter(Boolean).join(' '),
      tags.closing,
    ].filter(Boolean).join('\n'),
    footer: { text: '✅ Approve and post manually to X | ❌ Discard' },
  });
}

// ── Certification API caller ─────────────────────────────────────────────────
// Endpoint confirmed from actual /page_cert/chart.circle?serviceGbn=X page
// source — much simpler than onoff/album: just one param, no date/week math.

async function fetchCertChart(serviceGbn) {
  const body = new URLSearchParams({ serviceGbn });
  const res = await fetch(`${BASE_URL}/data/api/cert/chart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': `${BASE_URL}/page_cert/chart.circle?serviceGbn=${serviceGbn}`, 'User-Agent': 'Mozilla/5.0' },
    body,
  });
  if (!res.ok) throw new Error(`cert API ${res.status} for ${serviceGbn}`);
  const json = await res.json();
  if (json.ResultStatus !== 'OK') return [];
  // List structure unconfirmed (object-with-numeric-keys like onoff/album, or
  // a true array) — Object.values() is safe either way, no-op on a real array.
  return Object.values(json.List || {});
}

function certAlreadyPosted(rows, serviceGbn, grade, album, title) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (
      (r[0] || '') === serviceGbn &&
      (r[1] || '') === grade &&
      (r[3] || '').toLowerCase() === album.toLowerCase() &&
      (r[2] || '').toLowerCase() === (title || '').toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

async function ensureCertSheet(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const meta   = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === CERT_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: CERT_SHEET } } }] },
    });
    await appendSheetRow(sheets, CERT_SHEET, [
      'Service Type', 'Grade', 'Title', 'Album', 'Artist', 'Certify Date', 'Issue Date', 'Posted At',
    ]);
    console.log(`Created sheet: ${CERT_SHEET}`);
  }
}

async function postCertEntry(row, label, registryData) {
  const album       = row.ALBUM_NAME || '';
  const artist      = row.ARTIST_NAME || '';
  const title       = row.SONG_NAME || '';
  const grade       = row.Certify_Grade || '';
  const certifyDate = row.Certify_Date || '';
  const issueDate   = row.Issue_date || '';
  const tags        = resolveArtistTags(artist);
  const { songHashtags, albumHashtags } = getHashtagsForTitle(title || album, registryData);

  await sendEmbed({
    title: `[CERTIFICATION] ${label} — ${grade}`,
    color: 16766720,
    description: [
      `${artist} - ${title ? `${title} (${album})` : album}`,
      [certifyDate ? `Certified ${certifyDate}` : '', issueDate ? `Issued ${issueDate}` : ''].filter(Boolean).join(' | '),
      '',
      [songHashtags, albumHashtags, tags.handle].filter(Boolean).join(' '),
      tags.closing,
    ].filter(Boolean).join('\n'),
    footer: { text: '✅ Approve and post manually to X | ❌ Discard' },
  });
}

async function checkCertifications(sheets, registryData) {
  await ensureCertSheet(sheets);
  let certRows = await getSheetData(sheets, CERT_SHEET);

  for (const certType of CERT_TYPES) {
    console.log(`Fetching ${certType.label} certifications...`);
    try {
      const list    = await fetchCertChart(certType.serviceGbn);
      const ourRows = list.filter(r => isOurArtist(r.ARTIST_NAME));

      for (const row of ourRows) {
        const grade = row.Certify_Grade || '';
        const album = row.ALBUM_NAME || '';
        const title = row.SONG_NAME || '';
        if (certAlreadyPosted(certRows, certType.serviceGbn, grade, album, title)) continue;

        await appendSheetRow(sheets, CERT_SHEET, [
          certType.serviceGbn, grade, title, album, row.ARTIST_NAME || '',
          row.Certify_Date || '', row.Issue_date || '', kstTimestamp(),
        ]);
        await postCertEntry(row, certType.label, registryData);
        await new Promise(r => setTimeout(r, 2000));

        certRows.push([certType.serviceGbn, grade, title, album, row.ARTIST_NAME || '']);
      }
    } catch (e) {
      console.error(`Failed ${certType.label} certifications: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOurArtist(artistName) {
  if (!artistName) return false;
  const lower = artistName.toLowerCase();
  return ARTIST_TERMS.some(t => lower.includes(t.toLowerCase()));
}

function resolveArtistTags(artistName) {
  if (!artistName) return GROUP_TAGS;
  const lower = artistName.toLowerCase();
  for (const [key, val] of Object.entries(ARTIST_TAG_MAP)) {
    if (lower.includes(key)) return val;
  }
  return GROUP_TAGS;
}

// new: looks up song/album hashtags (Master Registry cols S/19, T/20 — 0-indexed
// 18/19) for a given chart title. Returns blanks (filtered out by the post
// functions) if no registry match is found, e.g. for album-level titles that
// don't line up with individual track names.
function getHashtagsForTitle(title, registryData) {
  if (!registryData || !title) return { songHashtags: '', albumHashtags: '' };
  const match = findMatchInRegistry(title, registryData);
  if (!match) return { songHashtags: '', albumHashtags: '' };
  return {
    songHashtags:  match.row[18] || '',
    albumHashtags: match.row[19] || '',
  };
}

function formatMovement(rankChange, rankStatus) {
  if (rankStatus === 'new')  return '(NEW)';
  if (rankStatus === 'same') return '(=)';
  const n = parseInt(rankChange, 10);
  if (isNaN(n) || n === 0) return '(=)';
  return n > 0 ? `(+${n})` : `(${n})`;
}

// ── Sheet init ────────────────────────────────────────────────────────────────

async function ensureSheet(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const meta          = await sheets.spreadsheets.get({ spreadsheetId });
  const exists        = meta.data.sheets.some(s => s.properties.title === SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET } } }] },
    });
    await appendSheetRow(sheets, SHEET, [
      'Track Name', 'Platform', 'Chart Type', 'Current Position',
      'Movement', 'Peak Position', 'Peak Date', 'Entry Date',
      'Last Seen', 'Week', 'Re-entry Date',
    ]);
    console.log(`Created sheet: ${SHEET}`);
  }
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function sendEmbed(embed) {
  const res = await fetch(process.env.DISCORD_CHARTS_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (res.status === 429) {
    const retry = (await res.json()).retry_after || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    await sendEmbed(embed);
  } else if (!res.ok) {
    console.error(`Discord webhook error: ${res.status}`);
  }
}

// fix: same spacing cleanup + hashtag lookup as the two functions above.
// Kept peak position and week number (this chart type's extra context that
// Global K-pop and Retail don't have); dropped the rankStatusEmoji() prefix
// since the movement label itself already conveys NEW/HOT/etc.
async function postChartEntry(hit, isReentry, registryData) {
  const reentryTag = isReentry ? ' (Re-entry)' : '';
  const peakLine   = hit.peakPos ? `Peak #${hit.peakPos}` : '';
  const tags       = resolveArtistTags(hit.artist);
  const { songHashtags, albumHashtags } = getHashtagsForTitle(hit.title, registryData);

  await sendEmbed({
    title: `[PHYSICAL] Circle Chart — ${hit.chartName}`,
    color: 3066993,
    description: [
      `#${hit.rank} ${hit.artist} - ${hit.title} ${hit.movement}${reentryTag}`,
      [peakLine, `Week ${hit.week}`].filter(Boolean).join(' | '),
      '',
      [songHashtags, albumHashtags, tags.handle].filter(Boolean).join(' '),
      tags.closing,
    ].filter(Boolean).join('\n'),
    footer: { text: '✅ Approve and post manually to X | ❌ Discard' },
  });
}

// ── State management ──────────────────────────────────────────────────────────

function findExistingRow(rows, trackName, chartType) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (
      (r[COL.TRACK_NAME] || '').toLowerCase() === trackName.toLowerCase() &&
      (r[COL.CHART_TYPE] || '').toLowerCase() === chartType.toLowerCase()
    ) {
      return { sheetRowIndex: i + 1, data: r };
    }
  }
  return null;
}

function findSentinelRow(rows, sentinelKey) {
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if ((r[COL.TRACK_NAME] || '') === sentinelKey) return true;
  }
  return false;
}

function checkReentry(lastSeen) {
  if (!lastSeen) return false;
  const last    = new Date(`${lastSeen.slice(0, 4)}-${lastSeen.slice(4, 6)}-${lastSeen.slice(6, 8)}`);
  const now     = getKSTDate();
  const diffDays = Math.floor((now - last) / 86400000);
  return diffDays > 9;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Circle Chart scraper...');

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  await ensureSheet(sheets);

  // Fetched once, passed into every post function for song/album hashtag lookup
  const registryData = await getRegistryData(sheets);

  const params = getCurrentWeekParams();
  const week   = weekLabel(params);
  const today  = todayPHT();
  console.log(`Week params: ${JSON.stringify(params)}`);

  const hits = [];

  // ── Fetch onoff charts ────────────────────────────────────────────────────
  for (const chart of ONOFF_CHARTS) {
    console.log(`Fetching ${chart.name}...`);
    try {
      const list = await fetchOnoffChart(chart.serviceGbn, params);
      for (const row of list) {
        if (!isOurArtist(row.ARTIST_NAME)) continue;
        hits.push({
          chartName:  chart.name,
          rank:       parseInt(row.SERVICE_RANKING, 10),
          rankStatus: row.RankStatus,
          rankChange: row.RankChange,
          movement:   formatMovement(row.RankChange, row.RankStatus),
          title:      row.SONG_NAME,
          artist:     row.ARTIST_NAME,
          score:      row.ROW_CNT || '',   // digital stream count
          week,
          peakPos:    null,
        });
      }
    } catch (e) {
      console.error(`Failed ${chart.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── Fetch album chart ─────────────────────────────────────────────────────
  console.log('Fetching Album Chart...');
  try {
    const list = await fetchAlbumChart(params);
    for (const row of list) {
      if (!isOurArtist(row.ARTIST_NAME)) continue;
      hits.push({
        chartName:  'Album Chart',
        rank:       parseInt(row.SERVICE_RANKING, 10),
        rankStatus: row.RankStatus,
        rankChange: row.RankChange,
        movement:   formatMovement(row.RankChange, row.RankStatus),
        title:      row.ALBUM_NAME,
        artist:     row.ARTIST_NAME,
        score:      row.Album_CNT || '',   // physical album sales
        week,
        peakPos:    null,
      });
    }
  } catch (e) {
    console.error(`Failed Album Chart: ${e.message}`);
  }

  console.log(`Found ${hits.length} hit(s).`);
  if (hits.length === 0) {
    console.log('No entries found in regular charts. Continuing to Global/Retail checks.');
  }

  // Load current sheet state once
  let sheetRows = await getSheetData(sheets, SHEET);

  for (const hit of hits) {
    const existing = findExistingRow(sheetRows, hit.title, hit.chartName);
    const reentry  = existing ? checkReentry(existing.data[COL.LAST_SEEN]) : false;

    if (existing) {
      const prevPeak = parseInt(existing.data[COL.PEAK_POS], 10) || hit.rank;
      const newPeak  = Math.min(hit.rank, prevPeak);
      const peakDate = newPeak < prevPeak ? today : (existing.data[COL.PEAK_DATE] || today);
      const alreadyThisWeek = existing.data[COL.WEEK] === week;

      hit.peakPos = newPeak;

      const nothingChanged =
        alreadyThisWeek &&
        !reentry &&
        parseInt(existing.data[COL.CURRENT_POS], 10) === hit.rank &&
        prevPeak === newPeak;

      if (nothingChanged) {
        console.log(`No change: ${hit.chartName} — ${hit.title}`);
        continue;
      }

      const updatedRow = [...existing.data];
      updatedRow[COL.CURRENT_POS] = hit.rank;
      updatedRow[COL.MOVEMENT]    = hit.movement;
      updatedRow[COL.PEAK_POS]    = newPeak;
      updatedRow[COL.PEAK_DATE]   = peakDate;
      updatedRow[COL.LAST_SEEN]   = today;
      updatedRow[COL.WEEK]        = week;
      if (reentry) updatedRow[COL.REENTRY_DATE] = today;

      await updateSheetRow(sheets, SHEET, existing.sheetRowIndex, updatedRow);

      // Log album chart updates to Physical Sales Log
      if (hit.chartName === 'Album Chart') {
        await appendSheetRow(sheets, 'Physical Sales Log', [
          kstTimestamp(), hit.title, 'Circle Chart', hit.score, '',
        ]);
      }

      if (!alreadyThisWeek || reentry) {
        await postChartEntry(hit, reentry, registryData);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.log(`Already posted this week: ${hit.chartName} — ${hit.title}`);
      }

    } else {
      // New entry
      hit.peakPos = hit.rank;
      const newRow = new Array(11).fill('');
      newRow[COL.TRACK_NAME]   = hit.title;
      newRow[COL.PLATFORM]     = 'circlechart';
      newRow[COL.CHART_TYPE]   = hit.chartName;
      newRow[COL.CURRENT_POS]  = hit.rank;
      newRow[COL.MOVEMENT]     = hit.movement;
      newRow[COL.PEAK_POS]     = hit.rank;
      newRow[COL.PEAK_DATE]    = today;
      newRow[COL.ENTRY_DATE]   = today;
      newRow[COL.LAST_SEEN]    = today;
      newRow[COL.WEEK]         = week;
      newRow[COL.REENTRY_DATE] = '';

      await appendSheetRow(sheets, SHEET, newRow);

      if (hit.chartName === 'Album Chart') {
        await appendSheetRow(sheets, 'Physical Sales Log', [
          kstTimestamp(), hit.title, 'Circle Chart', hit.score, '',
        ]);
      }

      await postChartEntry(hit, false, registryData);
      await new Promise(r => setTimeout(r, 2000));

      // Refresh sheet rows after append so subsequent lookups are accurate
      sheetRows = await getSheetData(sheets, SHEET);
    }

    console.log(`Processed: ${hit.chartName} #${hit.rank} — ${hit.title}`);
  }

  // ── GLOBAL K-POP CHART ────────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 1500));
  sheetRows = await getSheetData(sheets, SHEET);
  const todayKSTStr = todayKST();

  // Weekly — always-on, one post per Monday
  const globalWeeklyKey = `**SENTINEL**|global-weekly|${getMostRecentMonday()}`;
  if (!findSentinelRow(sheetRows, globalWeeklyKey)) {
    console.log('Fetching Global K-pop Weekly...');
    try {
      const yyyymmdd = await fetchGlobalDefaultDate('week');
      const list     = await fetchGlobalChart('week', yyyymmdd);
      const ourRows  = list.filter(r => isOurArtist(r.Artist));
      if (ourRows.length > 0) {
        const s = new Array(11).fill('');
        s[COL.TRACK_NAME] = globalWeeklyKey;
        s[COL.LAST_SEEN]  = todayKSTStr;
        await appendSheetRow(sheets, SHEET, s);
        for (const row of ourRows) {
          await postGlobalChartEntry(row, 'week', yyyymmdd, registryData);
          await new Promise(r => setTimeout(r, 2000));
        }
        console.log(`Global K-pop Weekly: ${ourRows.length} entries posted`);
      } else {
        console.log('Global K-pop Weekly: no Mamamoo entries');
      }
    } catch (e) {
      console.error(`Failed Global K-pop Weekly: ${e.message}`);
    }
  } else {
    console.log('Global K-pop Weekly: already posted this week');
  }

  // Daily — comeback only, one post per day
  if (isComeback) {
    const globalDailyKey = `**SENTINEL**|global-daily|${todayKSTStr}`;
    sheetRows = await getSheetData(sheets, SHEET);
    if (!findSentinelRow(sheetRows, globalDailyKey)) {
      console.log('Fetching Global K-pop Daily...');
      try {
        const yyyymmdd = await fetchGlobalDefaultDate('day');
        const list     = await fetchGlobalChart('day', yyyymmdd);
        const ourRows  = list.filter(r => isOurArtist(r.Artist));
        if (ourRows.length > 0) {
          const s = new Array(11).fill('');
          s[COL.TRACK_NAME] = globalDailyKey;
          s[COL.LAST_SEEN]  = todayKSTStr;
          await appendSheetRow(sheets, SHEET, s);
          for (const row of ourRows) {
            await postGlobalChartEntry(row, 'day', yyyymmdd, registryData);
            await new Promise(r => setTimeout(r, 2000));
          }
          console.log(`Global K-pop Daily: ${ourRows.length} entries posted`);
        } else {
          console.log('Global K-pop Daily: no Mamamoo entries');
        }
      } catch (e) {
        console.error(`Failed Global K-pop Daily: ${e.message}`);
      }
    } else {
      console.log('Global K-pop Daily: already posted today');
    }
  }

  // ── RETAIL ALBUM CHART ────────────────────────────────────────────────────
  // Cadence matches onoff/album charts: comeback mode runs every 6hr (per cron),
  // normal mode runs once daily (per cron). One post per day via daily sentinel.
  await new Promise(r => setTimeout(r, 1500));
  sheetRows = await getSheetData(sheets, SHEET);
  const retailDailyKey = `**SENTINEL**|retail-daily|${todayKSTStr}`;
  if (!findSentinelRow(sheetRows, retailDailyKey)) {
    console.log('Fetching Retail Album Chart Daily...');
    try {
      const yyyymmdd = await fetchRetailDefaultDate('day');
      const rows     = await fetchRetailList('day', yyyymmdd);
      const ourRows  = rows.filter(r => isOurArtist(r.Artist));
      if (ourRows.length > 0) {
        const s = new Array(11).fill('');
        s[COL.TRACK_NAME] = retailDailyKey;
        s[COL.LAST_SEEN]  = todayKSTStr;
        await appendSheetRow(sheets, SHEET, s);
        for (const row of ourRows) {
          await postRetailChartEntry(row, 'Daily', registryData);
          await appendSheetRow(sheets, 'Physical Sales Log', [
            kstTimestamp(), row.Album, 'Circle Retail', row.rowSum || '', '',
          ]);
          await new Promise(r => setTimeout(r, 2000));
        }
        console.log(`Retail Daily: ${ourRows.length} entries posted`);
      } else {
        console.log('Retail Daily: no Mamamoo entries');
      }
    } catch (e) {
      console.error(`Failed Retail Daily: ${e.message}`);
    }
  } else {
    console.log('Retail Daily: already posted today');
  }

  // ── CERTIFICATIONS ────────────────────────────────────────────────────────
  // No date filtering on this endpoint — first run will surface Mamamoo's
  // full certification history at once (everything not yet in Circle Cert
  // Tracker), not just new ones going forward. Worth knowing before the
  // first run lands in #charts-updates.
  await new Promise(r => setTimeout(r, 1500));
  await checkCertifications(sheets, registryData);

  console.log('Circle Chart scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
