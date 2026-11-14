'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { getSheetsClient, getSheetData, getRegistryData, findRegistryRowByName, getMemberConfig, getComebackMode } = require('./helpers');

const DISCORD_WEBHOOK = process.env.DISCORD_CHARTS_WEBHOOK;
const SHEETS_ID       = process.env.GOOGLE_SHEETS_ID;
const TRACKER_SHEET   = 'Korean Charts Tracker';
const DELAY_MS        = 2000;
const CHART_COLOR     = 16744272;

const GUYSOME_SLUG = {
  melon: { realtime: 'melon/top100',   daily: 'melon/daily',  weekly: 'melon/weekly' },
  genie: { realtime: 'genie/realtime', daily: 'genie/daily',  weekly: null },
  flo:   { realtime: 'flo/24hour',     daily: null,           weekly: null },
  vibe:  { realtime: null,             daily: 'vibe/daily',   weekly: null },
  bugs:  { realtime: 'bugs/realtime',  daily: 'bugs/daily',   weekly: null },
};

const PLATFORM_LABEL = { melon:'MelOn', genie:'Genie', flo:'Flo', vibe:'Vibe', bugs:'Bugs' };

const SENTINEL_WEEKLY = '__SENTINEL__|weekly|weekly';
function sentinelDailyKey(dateStr)           { return `__SENTINEL__|daily|${dateStr}`; }
function sentinelRealtimeKey(dateStr, hour)  { return `__SENTINEL__|realtime|${dateStr}${String(hour).padStart(2,'0')}`; }

// ─── KST Helpers ─────────────────────────────────────────────────────────────

function getKSTDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getKSTTimestamp() {
  const d = getKSTDate();
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} KST`;
}

function getKSTHour()   { return getKSTDate().getUTCHours(); }
function getKSTMinute() { return getKSTDate().getUTCMinutes(); }

function toDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
}

function dateStrToISO(s) {
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function getMostRecentMonday() {
  const kst = getKSTDate();
  const day = kst.getUTCDay();
  const back = day === 0 ? 6 : day - 1;
  const m = new Date(kst);
  m.setUTCDate(kst.getUTCDate() - back);
  return m;
}

// Previous Monday = the week that just ended (for weekly chart data)
function getPreviousMonday() {
  const monday = getMostRecentMonday();
  monday.setUTCDate(monday.getUTCDate() - 7);
  return monday;
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getMelonWeeklyKey(monday) {
  const week = getISOWeek(monday);
  return `${monday.getUTCFullYear()}_${String(week).padStart(2, '0')}`;
}

function weekRangeLabel(monday) {
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sun = new Date(monday);
  sun.setUTCDate(monday.getUTCDate() + 6);
  const start = `${mo[monday.getUTCMonth()]} ${monday.getUTCDate()}`;
  const end   = sun.getUTCMonth() === monday.getUTCMonth()
    ? `${sun.getUTCDate()}`
    : `${mo[sun.getUTCMonth()]} ${sun.getUTCDate()}`;
  return `${start}–${end}`;
}

function shortDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(-2)}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── guyso.me Scraper ────────────────────────────────────────────────────────

async function scrapeGuysome(slug, dateStr, hour) {
  const h   = hour !== null ? `/${String(hour).padStart(2,'0')}` : '';
  const url = `https://guyso.me/chart/${slug}/${dateStr}${h}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MamamooCharts/1.0)' }
  });
  if (!res.ok) throw new Error(`guyso.me ${res.status} — ${url}`);

  const html  = await res.text();
  const found = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!found) throw new Error(`No __NEXT_DATA__ at ${url}`);

  const json    = JSON.parse(found[1]);
  const entries = json?.props?.pageProps?.data?.data;

  if (!Array.isArray(entries) || entries.length === 0) {
    console.log(`  ${slug} — no data yet`);
    return [];
  }

  return entries.map(e => {
    const rank     = e.ranking ?? null;
    const previous = e.previous ?? null;
    const title    = (e.song?.name ?? '').trim();
    const artist   = (e.song?.artists?.[0]?.name ?? '').trim();

    let htmlMovement = null;
    let isNew        = false;
    if (previous === null || previous === 0) {
      isNew = true;
    } else {
      htmlMovement = previous - rank;
    }

    return { rank, title, artist, htmlMovement, isNew, isReNew: false };
  }).filter(e => e.rank !== null && e.title);
}

// ─── Genie Weekly ─────────────────────────────────────────────────────────────

async function scrapeGenieWeekly() {
  const ymd = toDateStr(getPreviousMonday());
  const url = `https://genie.co.kr/chart/top200?ditc=W&rtm=N&ymd=${ymd}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MamamooCharts/1.0)' } });
  if (!res.ok) throw new Error(`Genie weekly ${res.status}`);
  const $ = cheerio.load(await res.text());
  const results = [];

  $('tr.list').each((_, row) => {
    const rank = parseInt($(row).find('td.number').text().replace(/[^0-9]/g,''), 10);
    if (!rank) return;
    const title  = $(row).find('a.title.ellipsis').text().trim();
    const artist = $(row).find('a.artist.ellipsis').text().trim();

    let htmlMovement = null;
    const $mv = $(row).find('[class*="rank-"]').first();
    const cls = $mv.attr('class') || '';
    if (cls.includes('rank-up'))        htmlMovement = parseInt($mv.text().replace(/[^0-9]/g,''), 10) || null;
    else if (cls.includes('rank-down')) htmlMovement = -(parseInt($mv.text().replace(/[^0-9]/g,''), 10) || 0);
    else if (cls.includes('rank-none')) htmlMovement = 0;

    results.push({ rank, title, artist, htmlMovement, isNew: false, isReNew: false });
  });

  return results;
}

// ─── Bugs Weekly ─────────────────────────────────────────────────────────────

async function scrapeBugsWeekly() {
  const url = 'https://music.bugs.co.kr/chart/track/week/total';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MamamooCharts/1.0)' } });
  if (!res.ok) throw new Error(`Bugs weekly ${res.status}`);
  const $ = cheerio.load(await res.text());
  const results = [];

  $('table.list.trackList tr[trackId]').each((_, row) => {
    const rank = parseInt($(row).find('div.ranking strong').text().trim(), 10);
    if (!rank || rank > 200) return;

    const title  = $(row).find('input[type="checkbox"][title]').attr('title') || '';
    const artist = $(row).find('p.artist a').first().text().trim();

    const $ch  = $(row).find('p.change');
    const cls  = $ch.attr('class') || '';
    const val  = parseInt($ch.find('em').text(), 10) || 0;

    let htmlMovement = null;
    if      (cls.includes('up'))                               htmlMovement = val;
    else if (cls.includes('down'))                             htmlMovement = -val;
    else if (cls.includes('none') || cls.includes('duration')) htmlMovement = 0;

    const isNew   = cls.includes('new') && !cls.includes('renew');
    const isReNew = cls.includes('renew');

    results.push({ rank, title, artist, htmlMovement, isNew, isReNew });
  });

  return results;
}

// ─── Tracker Sheet ────────────────────────────────────────────────────────────

async function ensureTrackerSheet(sheets) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === TRACKER_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEETS_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TRACKER_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: `${TRACKER_SHEET}!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Track Name','Platform','Chart Type','Current Position','Movement',
                               'Peak Position','Peak Date','Entry Date','Last Seen','Re-entry Date']] },
    });
    console.log(`Created sheet: ${TRACKER_SHEET}`);
  }
}

async function loadTracker(sheets) {
  const rows = await getSheetData(sheets, TRACKER_SHEET);
  const map  = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const key = `${r[0]}|${r[1]}|${r[2]}`;
    map.set(key, {
      rowIndex:    i + 1,
      trackName:   r[0] || '',
      platform:    r[1] || '',
      chartType:   r[2] || '',
      currentPos:  parseInt((r[3]||'').toString().replace(/,/g,''), 10) || null,
      movement:    r[4] || '',
      peakPos:     parseInt((r[5]||'').toString().replace(/,/g,''), 10) || null,
      peakDate:    r[6] || '',
      entryDate:   r[7] || '',
      lastSeen:    r[8] || '',
      reentryDate: r[9] || '',
    });
  }
  return map;
}

async function persistTracker(sheets, dirtyKeys, trackerMap) {
  if (dirtyKeys.size === 0) return;
  const newRows = [], updates = [];

  for (const key of dirtyKeys) {
    const r = trackerMap.get(key);
    if (!r) continue;
    const row = [r.trackName, r.platform, r.chartType,
                 r.currentPos, r.movement,
                 r.peakPos, r.peakDate,
                 r.entryDate, r.lastSeen, r.reentryDate];
    if (r.rowIndex === null) newRows.push(row);
    else updates.push({ range: `${TRACKER_SHEET}!A${r.rowIndex}:J${r.rowIndex}`, values: [row] });
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEETS_ID,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
  }
  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: `${TRACKER_SHEET}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
  }
  console.log(`Tracker persisted: ${updates.length} updated, ${newRows.length} new`);
}

// ─── Sentinel ─────────────────────────────────────────────────────────────────

function sentinelAlreadyRan(trackerMap, key, dateStr, hour) {
  const rec = trackerMap.get(key);
  if (!rec) return false;
  const prefix = hour !== undefined
    ? `${dateStrToISO(dateStr)} ${String(hour).padStart(2,'0')}`
    : dateStrToISO(dateStr);
  return (rec.lastSeen || '').startsWith(prefix);
}

function setSentinel(trackerMap, dirtyKeys, key) {
  const ex = trackerMap.get(key);
  trackerMap.set(key, {
    rowIndex:   ex ? ex.rowIndex : null,
    trackName:  '__SENTINEL__',
    platform:   key.split('|')[1],
    chartType:  key.split('|')[2],
    currentPos: 0, movement: '',
    peakPos: 0, peakDate: '',
    entryDate: '', lastSeen: getKSTTimestamp(), reentryDate: '',
  });
  dirtyKeys.add(key);
}

// Check if all daily platforms have data for today in the tracker (across runs)
function dailyPlatformsHaveData(trackerMap, dateStr) {
  const required  = ['melon', 'genie', 'vibe', 'bugs'];
  const isoDate   = dateStrToISO(dateStr);
  const found     = new Set();

  for (const [key, rec] of trackerMap.entries()) {
    if (rec.trackName.startsWith('__SENTINEL__')) continue;
    if ((rec.chartType || '') !== 'daily') continue;
    if (!(rec.lastSeen || '').startsWith(isoDate)) continue;
    const platform = rec.platform;
    if (required.includes(platform)) found.add(platform);
  }

  return required.every(p => found.has(p));
}

// ─── Registry ─────────────────────────────────────────────────────────────────

function norm(s) {
  return s.toLowerCase()
    .replace(/\(feat\..*?\)/gi, '').replace(/\(ft\..*?\)/gi, '')
    .replace(/[^\w\s가-힣]/g, '').replace(/\s+/g, ' ').trim();
}

const MAMAMOO_ARTISTS = [
  'mamamoo','마마무','solar','솔라','moonbyul','문별',
  'wheein','휘인','hwasa','화사','mamamoo+','마마무플러스',
];

function isMamamooArtist(s) {
  const n = norm(s);
  return MAMAMOO_ARTISTS.some(a => n.includes(a));
}

function findInRegistry(chartTitle, chartArtist, registryData) {
  const nc = norm(chartTitle);
  const na = norm(chartArtist);

  if (!nc || !isMamamooArtist(na)) return null;

  for (const row of registryData.slice(1)) {
    if (!row[0]) continue;
    if ((row[11] || '').toLowerCase() === 'no') continue;
    if (!isMamamooArtist(norm(row[1] || ''))) continue;

    // display name + Korean + English names of the row
    const names = [row[0], row[20], row[21]]
      .map(v => norm((v || '').toString())).filter(Boolean);

    const titleMatch = names.some(nr => nr === nc ||
      (nc.length >= 5 && nr.length >= 5 && (nr.includes(nc) || nc.includes(nr))));
    if (!titleMatch) continue;

    return {
      memberConfig: getMemberConfig(row),
      trackName:    row[0],
      songHashtags: (row[18] || '').trim(),
    };
  }
  return null;
}

// ─── Movement ─────────────────────────────────────────────────────────────────

function computeMovement(rank, prevPos, htmlMovement, isNew, isReNew) {
  if (isReNew) return '(Re-entry)';
  if (isNew || prevPos === null) return '(NEW)';

  if (htmlMovement !== null) {
    if (htmlMovement === 0)  return '(=)';
    if (htmlMovement > 0)   return `(+${htmlMovement})`;
    return `(${htmlMovement})`;
  }

  const delta = prevPos - rank;
  if (delta === 0) return '(=)';
  if (delta > 0)   return `(+${delta})`;
  return `(${delta})`;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

function upsertRecord(trackerMap, dirtyKeys, trackName, platform, chartType, rank, movementStr, dateStr) {
  const key = `${trackName}|${platform}|${chartType}`;
  const ex  = trackerMap.get(key);
  const isNewPeak = ex != null && ex.peakPos !== null && rank < ex.peakPos;

  let reentryDate = ex ? ex.reentryDate : '';
  if (ex && ex.lastSeen) {
    const lastMs = new Date(ex.lastSeen.replace(' KST','') + '+09:00').getTime();
    if (!isNaN(lastMs) && (Date.now() - lastMs) > 25 * 3600 * 1000) {
      reentryDate = getKSTTimestamp();
    }
  }

  trackerMap.set(key, {
    rowIndex:    ex ? ex.rowIndex : null,
    trackName, platform, chartType,
    currentPos:  rank,
    movement:    movementStr,
    peakPos:     isNewPeak ? rank : (ex ? ex.peakPos : rank),
    peakDate:    isNewPeak ? dateStr : (ex ? ex.peakDate : dateStr),
    entryDate:   ex ? ex.entryDate : dateStr,
    lastSeen:    getKSTTimestamp(),
    reentryDate,
  });
  dirtyKeys.add(key);

  return { prevPos: ex ? ex.currentPos : null, isNewPeak };
}

// ─── Process Results ──────────────────────────────────────────────────────────

function processResults(chartResults, chartType, dateStr, registryData, trackerMap, dirtyKeys, cfg) {
  const trackMap      = new Map();
  const comebackTrack = (cfg?.COMEBACK_TRACK || '').toLowerCase().trim();
  const comebackMode  = cfg?.COMEBACK_MODE === 'ON';
  const isComebackName = n => {
    const a = norm(n), b = norm(comebackTrack);
    return !!b && (a.includes(b) || b.includes(a));
  };

  for (const [platform, entries] of chartResults) {
    for (const entry of entries) {
      if (chartType === 'realtime' && entry.rank > 50) continue;

      const match = findInRegistry(entry.title, entry.artist, registryData);
      if (!match) continue;

      if (chartType === 'realtime' && comebackMode && comebackTrack) {
        if (!isComebackName(match.trackName)) continue;
      }

      const { prevPos, isNewPeak } = upsertRecord(
        trackerMap, dirtyKeys,
        match.trackName, platform, chartType,
        entry.rank, '', dateStr
      );

      const movementStr = computeMovement(
        entry.rank, prevPos,
        entry.htmlMovement, entry.isNew, entry.isReNew
      );

      const key = `${match.trackName}|${platform}|${chartType}`;
      trackerMap.get(key).movement = movementStr;

      const isComeback = comebackMode && comebackTrack &&
        (norm(match.trackName).includes(norm(comebackTrack)) ||
         norm(comebackTrack).includes(norm(match.trackName)));

      const isRising = (chartType === 'realtime' && isComeback)
        ? true
        : entry.isNew || entry.isReNew ||
          (entry.htmlMovement !== null
            ? entry.htmlMovement > 0
            : (prevPos !== null && entry.rank < prevPos));

      if (!trackMap.has(match.trackName)) {
        trackMap.set(match.trackName, { match, entries: [] });
      }
      trackMap.get(match.trackName).entries.push({
        platform, rank: entry.rank, movementStr, isNewPeak, isRising,
      });
    }
  }

  if (chartType === 'realtime') {
    const required = ['melon', 'genie', 'flo', 'bugs'];
    for (const [trackName, data] of trackMap.entries()) {
      const platforms = new Set(data.entries.map(e => e.platform));
      if (!required.every(p => platforms.has(p))) { trackMap.delete(trackName); continue; }
      if (!data.entries.some(e => e.isRising))    { trackMap.delete(trackName); }
    }
  }

  if (chartType === 'daily') {
    const required = ['melon', 'genie', 'vibe', 'bugs'];
    for (const [trackName, data] of trackMap.entries()) {
      const isComeback = comebackMode && comebackTrack &&
        (norm(trackName).includes(norm(comebackTrack)) || norm(comebackTrack).includes(norm(trackName)));
      if (isComeback) continue;
      const platforms = new Set(data.entries.map(e => e.platform));
      if (!required.every(p => platforms.has(p))) trackMap.delete(trackName);
    }
  }

  return trackMap;
}

// ─── Discord ──────────────────────────────────────────────────────────────────

async function sendToDiscord(payload) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await delay((j.retry_after || 5) * 1000);
    } else return;
  }
  console.error('Discord send failed after 3 attempts');
}

async function sendChartDraft(match, label, entries) {
  const { memberConfig, trackName, songHashtags } = match;
  const header = `${memberConfig.handle}'s '${trackName}' — ${label}`;

  let chartLines = entries.map(e => {
    let line = `#${e.rank} ${PLATFORM_LABEL[e.platform]} ${e.movementStr}`;
    if (e.isNewPeak) line += ' NEW PEAK 🔥';
    return line;
  });

  const hashLine    = songHashtags
    ? songHashtags.split('\n').map(h => h.trim()).filter(Boolean).join(' ')
    : '';
  const closingTags = memberConfig.handle === '#MAMAMOO'
    ? '#마마무 #ママム #妈妈木\n@RBW_MAMAMOO'
    : `#마마무 ${memberConfig.label}`;

  const buildBody = (lines) => {
    const parts = [header, '', ...lines];
    if (hashLine)          parts.push('', hashLine);
    if (memberConfig.tags) parts.push(memberConfig.tags);
    parts.push(closingTags);
    return parts.join('\n');
  };

  let body = buildBody(chartLines);
  while (body.length > 280 && chartLines.length > 1) {
    chartLines = chartLines.slice(0, -1);
    body = buildBody(chartLines);
  }

  await sendToDiscord({
    embeds: [{ description: body, color: CHART_COLOR,
               footer: { text: `Korean Charts • ${getKSTTimestamp()}` } }],
  });
}

// ─── Label ────────────────────────────────────────────────────────────────────

function buildLabel(chartType, weekMonday) {
  const kst = getKSTDate();
  if (chartType === 'realtime') return `${String(getKSTHour()).padStart(2,'00')}KST`;
  if (chartType === 'daily')    return `Daily (${shortDate(kst)})`;
  if (chartType === 'weekly')   return `Weekly (${weekRangeLabel(weekMonday)})`;
  return chartType;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await delay(Math.floor(Math.random() * 30000));

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  const kstHour    = getKSTHour();
  const kstMinute  = getKSTMinute();
  const kstDate    = getKSTDate();
  const dateStr    = toDateStr(kstDate);
  const mondayStr  = toDateStr(getMostRecentMonday()); // this Monday — used for weekly sentinel key

  console.log(`Korean charts — comeback:${isComeback} hour:${kstHour}KST date:${dateStr}`);

  const runRealtime = isComeback && (kstHour < 3 || kstHour >= 6);
  const runDaily    = kstHour >= 18;
  const runWeekly   = kstDate.getUTCDay() === 1 && kstHour >= 18;

  if (!runRealtime && !runDaily && !runWeekly) {
    console.log('Nothing to run. Exiting.'); return;
  }

  await ensureTrackerSheet(sheets);
  const [registryData, trackerMap] = await Promise.all([
    getRegistryData(sheets),
    loadTracker(sheets),
  ]);
  const dirtyKeys  = new Set();
  const configData = await getSheetData(sheets, 'Config');
  const cfg = {};
  for (const row of configData) cfg[row[0]] = row[1] || '';
  const cbRow = findRegistryRowByName(registryData, cfg.COMEBACK_TRACK);
  if (cbRow) cfg.COMEBACK_TRACK = cbRow[0];   // Config can hold EN or KR; use the Registry's display name

  // ── REALTIME ──────────────────────────────────────────────────────────────
  if (runRealtime) {
    const sentinelKey = sentinelRealtimeKey(dateStr, kstHour);
    if (sentinelAlreadyRan(trackerMap, sentinelKey, dateStr, kstHour)) {
      console.log('Realtime already ran this hour. Skipping.');
    } else {
      console.log('Realtime...');
      const results = new Map();
      for (const p of ['melon','genie','flo','bugs']) {
        const slug = GUYSOME_SLUG[p].realtime;
        if (!slug) continue;
        // Genie updates late — use previous hour if within first 5 minutes
        const hourToFetch = (p === 'genie' && kstMinute < 5 && kstHour > 0)
          ? kstHour - 1
          : kstHour;
        try {
          await delay(DELAY_MS);
          const data = await scrapeGuysome(slug, dateStr, hourToFetch);
          if (data.length) results.set(p, data);
          console.log(`  ${p}: ${data.length}`);
        } catch (e) { console.error(`  ${p}:`, e.message); }
      }
      if (results.size) {
        const tmRealtime = processResults(results, 'realtime', dateStr, registryData, trackerMap, dirtyKeys, cfg);
        const lb = buildLabel('realtime');
        for (const { match, entries } of tmRealtime.values()) {
          entries.sort((a,b) => a.rank - b.rank);
          await sendChartDraft(match, lb, entries);
          await delay(DELAY_MS);
        }
        setSentinel(trackerMap, dirtyKeys, sentinelKey);
      } else {
        console.log('Realtime returned no data.');
      }
    }
  }

  // ── DAILY ─────────────────────────────────────────────────────────────────
  if (runDaily) {
    const dailySentinelKey = sentinelDailyKey(dateStr);
    if (sentinelAlreadyRan(trackerMap, dailySentinelKey, dateStr)) {
      console.log('Daily already ran today. Skipping.');
    } else {
      console.log('Daily...');
      const results = new Map();
      for (const p of ['melon','genie','vibe','bugs']) {
        const slug = GUYSOME_SLUG[p].daily;
        if (!slug) continue;
        try {
          await delay(DELAY_MS);
          const data = await scrapeGuysome(slug, dateStr, null);
          if (data.length) results.set(p, data);
          console.log(`  ${p}: ${data.length ? data.length : 'no data yet'}`);
        } catch (e) { console.error(`  ${p}:`, e.message); }
      }

      if (results.size) {
        const tmDaily = processResults(results, 'daily', dateStr, registryData, trackerMap, dirtyKeys, cfg);

        // Write tracker first so concurrent runs see updated state
        await persistTracker(sheets, dirtyKeys, trackerMap);
        dirtyKeys.clear();

        // Check if all 4 platforms now have data for today (this run + previous runs)
        const allPlatformsReady = dailyPlatformsHaveData(trackerMap, dateStr);

        if (allPlatformsReady) {
          // Set sentinel before posting to prevent concurrent duplicate posts
          setSentinel(trackerMap, dirtyKeys, dailySentinelKey);
          await persistTracker(sheets, dirtyKeys, trackerMap);
          dirtyKeys.clear();

          const lb = buildLabel('daily');
          for (const { match, entries } of tmDaily.values()) {
            entries.sort((a,b) => a.rank - b.rank);
            await sendChartDraft(match, lb, entries);
            await delay(DELAY_MS);
          }
          console.log('Daily posted and sentinel set.');
        } else {
          const missing = ['melon','genie','vibe','bugs'].filter(p => {
            const isoDate = dateStrToISO(dateStr);
            for (const [key, rec] of trackerMap.entries()) {
              if (rec.trackName.startsWith('__SENTINEL__')) continue;
              if (rec.chartType !== 'daily') continue;
              if (rec.platform === p && (rec.lastSeen || '').startsWith(isoDate)) return false;
            }
            return true;
          });
          console.log(`Daily: waiting for ${missing.join(', ')} — will retry next run.`);
        }
      } else {
        console.log('Daily data not available yet. Will retry next run.');
      }
    }
  }

  // ── WEEKLY ────────────────────────────────────────────────────────────────
  if (runWeekly) {
    if (sentinelAlreadyRan(trackerMap, SENTINEL_WEEKLY, mondayStr)) {
      console.log('Weekly already ran this Monday. Skipping.');
    } else {
      console.log('Weekly...');
      const results  = new Map();
      // Use previous Monday's data — the week that just ended
      const monday   = getPreviousMonday();
      const melonKey = getMelonWeeklyKey(monday);

      try {
        await delay(DELAY_MS);
        const data = await scrapeGuysome('melon/weekly', melonKey, null);
        if (data.length) results.set('melon', data);
        console.log(`  melon: ${data.length}`);
      } catch (e) { console.error('  melon weekly:', e.message); }

      try {
        await delay(DELAY_MS);
        const data = await scrapeGenieWeekly();
        if (data.length) results.set('genie', data);
        console.log(`  genie: ${data.length}`);
      } catch (e) { console.error('  genie weekly:', e.message); }

      try {
        await delay(DELAY_MS);
        const data = await scrapeBugsWeekly();
        if (data.length) results.set('bugs', data);
        console.log(`  bugs: ${data.length}`);
      } catch (e) { console.error('  bugs weekly:', e.message); }

      if (results.size) {
        const weeklyExpected = ['melon', 'genie', 'bugs'];
        if (weeklyExpected.every(p => results.has(p))) {
          // Set sentinel before posting
          setSentinel(trackerMap, dirtyKeys, SENTINEL_WEEKLY);
          await persistTracker(sheets, dirtyKeys, trackerMap);
          dirtyKeys.clear();

          const tmWeekly = processResults(results, 'weekly', toDateStr(monday), registryData, trackerMap, dirtyKeys, cfg);
          const lb = buildLabel('weekly', monday);
          for (const { match, entries } of tmWeekly.values()) {
            entries.sort((a,b) => a.rank - b.rank);
            await sendChartDraft(match, lb, entries);
            await delay(DELAY_MS);
          }
          console.log('Weekly posted and sentinel set.');
        } else {
          console.log('Not all weekly platforms available yet — will retry next run.');
        }
      } else {
        console.log('Weekly data not available yet. Will retry next run.');
      }
    }
  }

  await persistTracker(sheets, dirtyKeys, trackerMap);
  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
