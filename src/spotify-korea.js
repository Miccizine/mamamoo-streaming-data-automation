'use strict';

const {
  getSheetsClient,
  getSheetData,
  getRegistryData,
  appendSheetRow,
  getMemberConfig,
  buildClosingTags,
  getPHTTimestamp,
} = require('./helpers');

const fetch = require('node-fetch');

const DAILY_URL  = 'https://kworb.net/spotify/country/kr_daily.html';
const WEBHOOK    = process.env.DISCORD_CHARTS_WEBHOOK;
const COLOR      = 1947988;
const SHEET_NAME = 'Spotify Korea Chart';
const HEADERS    = ['Track Name', 'Artist', 'Peak Position', 'Date Achieved', 'Last Seen', 'Entry Date', 'Re-entry Date', 'Current Day Count', 'Current Position'];

// ── Registry match with artist verification ───────────────────────────────────

const MAMAMOO_ARTISTS = [
  'mamamoo','마마무','solar','솔라','moonbyul','문별',
  'wheein','휘인','hwasa','화사','mamamoo+','마마무플러스',
];

function normStr(s) {
  return s.toLowerCase()
    .replace(/\(feat\..*?\)/gi, '').replace(/\(ft\..*?\)/gi, '')
    .replace(/[^\w\s가-힣]/g, '').replace(/\s+/g, ' ').trim();
}

function isMamamooArtist(s) {
  const n = normStr(s);
  return MAMAMOO_ARTISTS.some(a => n.includes(a));
}

function findMatchInRegistryVerified(chartTitle, chartArtist, registryData) {
  const nc = normStr(chartTitle);
  const na = normStr(chartArtist);

  if (!nc || !na || !isMamamooArtist(na)) return null;

  for (const row of registryData.slice(1)) {
    if (!row[0]) continue;
    if ((row[11] || '').toLowerCase() === 'no') continue;
    if (!isMamamooArtist(normStr(row[1] || ''))) continue;

    // display name + Korean + English names of the row
    const names = [row[0], row[20], row[21]]
      .map(v => normStr((v || '').toString())).filter(Boolean);

    const isLatin = s => /^[a-z0-9 ]+$/.test(s);
    const titleMatch = names.some(nr => nr === nc ||
      (isLatin(nc) && isLatin(nr) && nc.length >= 5 && nr.length >= 5 &&
       (nr.includes(nc) || nc.includes(nr))));
    if (!titleMatch) continue;

    return { row };
  }
  return null;
}

// ── Ensure sheet exists ───────────────────────────────────────────────────────

async function ensureSheet(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const meta     = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.map(s => s.properties.title);
  if (existing.includes(SHEET_NAME)) return;

  console.log(`Sheet "${SHEET_NAME}" not found — creating...`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] }
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:I1`,
    valueInputOption: 'RAW',
    resource: { values: [HEADERS] }
  });
  console.log(`Sheet "${SHEET_NAME}" created with headers.`);
}

// ── Scrape kworb Korea daily chart ───────────────────────────────────────────

async function fetchKoreaChart() {
  const response = await fetch(DAILY_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${DAILY_URL}`);
  return response.text();
}

function parseKoreaChart(html) {
  const tracks = [];
  const rows   = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = cellPattern.exec(row)) !== null) {
      cells.push(m[1].replace(/<[^>]+>/g, '').trim());
    }

    if (cells.length < 6) continue;

    const pos = parseInt(cells[0], 10);
    if (isNaN(pos)) continue;

    const movement    = (cells[1] || '').trim();
    const artistTitle = cells[2] || '';
    const days        = parseInt(cells[3], 10) || 1;
    const peak        = parseInt(cells[4], 10) || pos;
    const streams     = parseInt((cells[5] || '').replace(/,/g, ''), 10) || 0;

    const dashIdx = artistTitle.indexOf(' - ');
    if (dashIdx === -1) continue;
    const artist = artistTitle.substring(0, dashIdx).trim();
    const title  = artistTitle.substring(dashIdx + 3).trim();

    tracks.push({ pos, movement, artist, title, peak, streams, days });
  }

  return tracks;
}

// ── Format movement string ────────────────────────────────────────────────────

function formatMovement(raw, isNew, isReentry) {
  if (isNew)     return '(NEW)';
  if (isReentry) return '(Re-entry)';
  const n = parseInt(raw, 10);
  if (isNaN(n) || n === 0) return '(=)';
  return n > 0 ? `(+${n})` : `(${n})`;
}

// ── Get today KST date string ─────────────────────────────────────────────────

function getKSTDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// ── Load chart data into memory ───────────────────────────────────────────────

function buildChartMap(data) {
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const trackName = (data[i][0] || '').trim();
    if (trackName) map[trackName] = { idx: i, row: data[i] };
  }
  return map;
}

// ── Upsert row in Spotify Korea Chart ────────────────────────────────────────

async function upsertKoreaChartRow(sheets, chartMap, trackName, artist, pos, peak, days, isNew, isReentry, today) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const existing      = chartMap[trackName];

  if (!existing) {
    await appendSheetRow(sheets, SHEET_NAME, [
      trackName, artist, peak, today, today, today, '', days, pos
    ]);
    chartMap[trackName] = { idx: -1, row: [trackName, artist, peak, today, today, today, '', days, pos] };
    return;
  }

  const row         = existing.row;
  const currentPeak = parseInt((row[2] || '999').toString().replace(/,/g, ''), 10);
  const entryDate   = isReentry ? today : (row[5] || today);
  const reentryDate = isReentry ? today : (row[6] || '');
  const newPeak     = Math.min(currentPeak, peak);
  const peakDate    = newPeak < currentPeak ? today : (row[3] || today);
  const dayCount    = isReentry ? 1 : days;

  const updatedRow = [
    trackName, artist, newPeak, peakDate,
    today, entryDate, reentryDate, dayCount, pos
  ];

  existing.row = updatedRow;
  if (existing.idx === -1) return;

  const rowNumber = existing.idx + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A${rowNumber}:I${rowNumber}`,
    valueInputOption: 'RAW',
    resource: { values: [updatedRow] }
  });
}

// ── Build Discord post ────────────────────────────────────────────────────────

function buildKoreaChartPost(config, trackName, pos, movementStr, dayCount, peak, spotifyUrl, songHashtags) {
  const closingTags = buildClosingTags(config);

  const lines = [
    'Spotify Korea Daily Chart 🇰🇷',
    '',
    `#${pos} ${config.handle} - ${trackName} ${movementStr}`,
  ];

  if (dayCount > 1) {
    lines.push(`[DAY ${dayCount} since entry/re-entry | PEAK #${peak}]`);
  }

  lines.push('');

  if (spotifyUrl) {
    lines.push(`🔗 ${spotifyUrl}`);
    lines.push('');
  }
  if (songHashtags) lines.push(songHashtags);
  if (config.tags)  lines.push(config.tags);
  lines.push(closingTags);

  return lines.join('\n').trim();
}

// ── Send to Discord ───────────────────────────────────────────────────────────

async function sendChartPost(post) {
  const message = {
    embeds: [{
      title: '📊 SPOTIFY KOREA — Pending Approval',
      color: COLOR,
      description: post,
      footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
    }]
  };

  const response = await fetch(WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(message)
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    console.log(`Rate limited. Waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    await fetch(WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message)
    });
  } else if (!response.ok) {
    console.error(`Discord error: ${response.status}`);
  }

  await new Promise(r => setTimeout(r, 2000));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Spotify Korea daily chart scraper...');

  const sheets = await getSheetsClient();
  await ensureSheet(sheets);

  const registryData = await getRegistryData(sheets);
  const chartRawData = await getSheetData(sheets, SHEET_NAME);
  const chartMap     = buildChartMap(chartRawData);
  const today        = getKSTDateString();

  let html;
  try {
    html = await fetchKoreaChart();
  } catch (e) {
    console.error(`Fetch error: ${e.message}`);
    process.exit(1);
  }

  const allTracks = parseKoreaChart(html);
  console.log(`Parsed ${allTracks.length} tracks from Korea daily chart`);

  for (const track of allTracks) {
    const match = findMatchInRegistryVerified(track.title, track.artist, registryData);
    if (!match) continue;

    const matchedRow     = match.row;
    const trackName      = matchedRow[0];
    const activeTracking = (matchedRow[11] || '').toString().trim().toLowerCase();
    if (activeTracking !== 'yes') continue;

    const memberConfig = getMemberConfig(matchedRow);
    const songHashtags = (matchedRow[18] || '').trim(); // col S index 18
    const spotifyUri   = (matchedRow[12] || '').trim(); // col M index 12
    const spotifyUrl   = spotifyUri
      ? 'https://open.spotify.com/track/' + spotifyUri.replace('spotify:track:', '')
      : '';

    const isNew     = track.days === 1 && track.movement !== 'RE';
    const isReentry = track.movement === 'RE';
    const movementStr = formatMovement(track.movement, isNew, isReentry);
    const dayCount    = isReentry ? 1 : track.days;

    const existing  = chartMap[trackName];
    const sheetPeak = existing ? parseInt((existing.row[2] || '999').toString().replace(/,/g, ''), 10) : 999;
    const peak      = Math.min(track.peak, sheetPeak);

    console.log(`Match: ${trackName} | #${track.pos} ${movementStr} | Day ${dayCount}`);

    const prevPos = existing ? parseInt((existing.row[8] || '0').toString().replace(/,/g, ''), 10) : null;

    await upsertKoreaChartRow(
      sheets, chartMap, trackName, track.artist,
      track.pos, peak, track.days, isNew, isReentry, today
    );

    const isRising = isNew || isReentry || (prevPos !== null && track.pos < prevPos);
    if (track.pos > 100 || !isRising) {
      console.log(`Skip Discord: ${trackName} | #${track.pos} ${movementStr} | rising:${isRising}`);
      continue;
    }

    const post = buildKoreaChartPost(
      memberConfig, trackName, track.pos, movementStr,
      dayCount, peak, spotifyUrl, songHashtags
    );

    await sendChartPost(post);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('Spotify Korea daily chart scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
