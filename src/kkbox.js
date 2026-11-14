'use strict';

const fetch = require('node-fetch');
const {
  getSheetsClient, getSheetData, getRegistryData, getPHTTimestamp,
  getMemberConfig, buildClosingTags, findMatchInRegistry
} = require('./helpers');

const SHEET_NAME = 'KKBOX Chart';
const WEBHOOK = process.env.DISCORD_CHARTS_WEBHOOK;

const TERRITORIES = [
  { code: 'tw', lang: 'en', flag: '🇹🇼', label: 'Taiwan' },
  { code: 'sg', lang: 'en', flag: '🇸🇬', label: 'Singapore' },
  { code: 'hk', lang: 'tc', flag: '🇭🇰', label: 'Hong Kong' },
];

const CHARTS = [
  { path: 'daily/newrelease', freq: 'daily',  label: 'New Singles' },
  { path: 'daily/song',       freq: 'daily',  label: 'Singles'     },
  { path: 'weekly/newrelease',freq: 'weekly', label: 'New Singles' },
  { path: 'weekly/song',      freq: 'weekly', label: 'Singles'     },
  { path: 'weekly/album',     freq: 'weekly', label: 'Albums'      },
];

// Sheet cols: A=TrackName B=Territory C=ChartType D=CurrentPos E=Movement
//             F=PeakPos G=PeakDate H=EntryDate I=LastSeen J=ReentryDate
const C = { TRACK:0, TERR:1, CTYPE:2, POS:3, MOV:4, PEAK:5, PEAK_DATE:6, ENTRY:7, LAST_SEEN:8, REENTRY:9 };

function isMamamooArtist(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return ['mamamoo','마마무','solar','솔라','moonbyul','문별',
          'wheein','휘인','hwasa','화사','mamamoo+','마마무플러스'].some(k => n.includes(k));
}

function getKSTDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // YYYY-MM-DD
}

function getKSTMonday() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const diff = now.getDay() === 0 ? -6 : 1 - now.getDay();
  now.setDate(now.getDate() + diff);
  return now.toISOString().slice(0, 10);
}

function toCompact(dateStr) {
  // "2026-06-05" → "20260605"
  return dateStr.replace(/-/g, '');
}

function weeklyDateLabel(chartDate) {
  // chartDate is week start; display is start+1 ~ start+7
  const start = new Date(chartDate);
  const d1 = new Date(start); d1.setDate(d1.getDate() + 1);
  const d2 = new Date(start); d2.setDate(d2.getDate() + 7);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  return `${fmt(d1)}~${fmt(d2)}`;
}

function movementStr(current, previous) {
  if (previous === null || previous === undefined || previous === '') return '(NEW)';
  const delta = parseInt(previous) - parseInt(current);
  if (delta === 0) return '(=)';
  return delta > 0 ? `(+${delta})` : `(${delta})`;
}

async function fetchChart(terr, lang, path) {
  const url = `https://kma.kkbox.com/charts/${path}?cate=314&lang=${lang}&terr=${terr}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  const html = await res.text();

  const chartMatch = html.match(/var chart = (\[[\s\S]+?\]);\s*\n/);
  if (!chartMatch) throw new Error(`chart variable not found — ${url}`);

  const dateMatch = html.match(/var chartDate = "([^"]+)"/);
  const chartDate = dateMatch ? dateMatch[1] : getKSTDate();

  return { entries: JSON.parse(chartMatch[1]), chartDate };
}

async function ensureSheet(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Track Name','Territory','Chart Type','Current Position','Movement',
        'Peak Position','Peak Date','Entry Date','Last Seen','Re-entry Date']] }
    });
  }
}

async function loadTracker(sheets, spreadsheetId) {
  const rows = await getSheetData(sheets, SHEET_NAME);
  const map = new Map();
  rows.forEach((row, i) => {
    if (i === 0) return;
    const key = row[C.TRACK] === '**SENTINEL**'
      ? `__s__${row[C.TERR]}`
      : `${row[C.TRACK]}|${row[C.TERR]}|${row[C.CTYPE]}`;
    map.set(key, { rowIndex: i, row });
  });
  return map;
}

async function flushWrites(sheets, spreadsheetId, updates, appends) {
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map(({ rowIndex, values }) => ({
          range: `${SHEET_NAME}!A${rowIndex + 1}`,
          values: [values]
        }))
      }
    });
  }
  for (const values of appends) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${SHEET_NAME}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] }
    });
  }
}

async function sendEmbed(title, descLines) {
  const payload = {
    embeds: [{
      title,
      description: descLines.join('\n').trim(),
      color: 16711680,
      footer: { text: `${getPHTTimestamp()} • Pending approval` }
    }]
  };
  const post = () => fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const res = await post();
  if (res.status === 429) {
    const { retry_after } = await res.json();
    await new Promise(r => setTimeout(r, (retry_after || 2) * 1000));
    await post();
  }
  await new Promise(r => setTimeout(r, 2000));
}

async function main() {
  await new Promise(r => setTimeout(r, Math.random() * 30000));

  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const configRows = await getSheetData(sheets, 'Config');
  const kkboxEnabled = configRows.find(r => r[0] === 'KKBOX_TRACKING')?.[1]?.trim().toUpperCase();
  if (kkboxEnabled !== 'YES') {
    console.log('KKBOX_TRACKING is not YES — exiting.');
    return;
  }

  await ensureSheet(sheets, spreadsheetId);

  const [registryRows, tracker] = await Promise.all([
    getRegistryData(sheets),
    loadTracker(sheets, spreadsheetId)
  ]);

  const kstDate = getKSTDate();
  const kstMonday = getKSTMonday();
  const isMonday = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getDay() === 1;

  const updates = [];
  const appends = [];

  for (const territory of TERRITORIES) {
    const dailySentinel  = `daily_${territory.code}_${kstDate}`;
    const weeklySentinel = `weekly_${territory.code}_${kstMonday}`;
    const dailyDone  = tracker.has(`__s__${dailySentinel}`);
    const weeklyDone = tracker.has(`__s__${weeklySentinel}`);

    if (dailyDone && (!isMonday || weeklyDone)) {
      console.log(`[${territory.code}] skipped — sentinels set`);
      continue;
    }

    // Collect: configKey → { config, registryRow, songHashtags, albumHashtags,
    //                         daily: { chartLabel: [lines] }, weekly: { chartLabel: [lines] },
    //                         dailyChartDate, weeklyChartDate }
    const byConfig = new Map();

    for (const chart of CHARTS) {
      if (chart.freq === 'daily'  && dailyDone) continue;
      if (chart.freq === 'weekly' && (!isMonday || weeklyDone)) continue;

      let entries, chartDate;
      try {
        await new Promise(r => setTimeout(r, 2000));
        ({ entries, chartDate } = await fetchChart(territory.code, territory.lang, chart.path));
      } catch (e) {
        console.error(`[${territory.code}/${chart.path}]`, e.message);
        continue;
      }

      for (const entry of entries) {
        if (!isMamamooArtist(entry.artist_name || '')) continue;

        const trackName = entry.song_name || entry.album_name || '';
        const pos  = entry.rankings.this_period;
        const prev = entry.rankings.last_period;
        const mov  = movementStr(pos, prev);

        // Upsert tracker sheet
        const upsertKey = `${trackName}|${territory.code}|${chart.path}`;
        const existing  = tracker.get(upsertKey);
        const peak      = existing ? Math.min(pos, parseInt(existing.row[C.PEAK]) || pos) : pos;
        const peakDate  = existing
          ? (pos < parseInt(existing.row[C.PEAK] || pos + 1) ? kstDate : existing.row[C.PEAK_DATE])
          : kstDate;
        const entryDate   = existing ? existing.row[C.ENTRY] : kstDate;
        const reentryDate = (mov === '(RE)' && existing && !existing.row[C.REENTRY])
          ? kstDate : (existing ? existing.row[C.REENTRY] || '' : '');

        const rowValues = [trackName, territory.code, chart.path, pos, mov,
          peak, peakDate, entryDate, kstDate, reentryDate];

        if (existing && existing.rowIndex >= 0) {
          updates.push({ rowIndex: existing.rowIndex, values: rowValues });
        } else if (!existing) {
          appends.push(rowValues);
          tracker.set(upsertKey, { rowIndex: -1, row: rowValues });
        }

        // Group by member config for Discord embeds
        const match       = findMatchInRegistry(trackName, registryRows);
        const registryRow = match ? match.row : null;
        const config      = registryRow ? getMemberConfig(registryRow) : { handle: '#MAMAMOO', tags: '', label: '@RBW_MAMAMOO' };
        const configKey   = config.handle;

        if (!byConfig.has(configKey)) {
          byConfig.set(configKey, {
            config,
            registryRow,
            songHashtags:  registryRow ? (registryRow[18] || '') : '',
            albumHashtags: registryRow ? (registryRow[19] || '') : '',
            daily:   {},
            weekly:  {},
            dailyChartDate:  null,
            weeklyChartDate: null,
          });
        }

        const bucket = byConfig.get(configKey);
        const freqBucket = bucket[chart.freq];
        if (!freqBucket[chart.label]) freqBucket[chart.label] = [];
        freqBucket[chart.label].push(`#${pos} ${trackName} ${mov}`);

        if (chart.freq === 'daily'  && !bucket.dailyChartDate)  bucket.dailyChartDate  = chartDate;
        if (chart.freq === 'weekly' && !bucket.weeklyChartDate) bucket.weeklyChartDate = chartDate;
      }
    }

    // Send one embed per config per frequency
    for (const [, bucket] of byConfig) {
      const { config, songHashtags, albumHashtags } = bucket;
      const closing = buildClosingTags(config);

      for (const freq of ['daily', 'weekly']) {
        const sections = bucket[freq];
        if (Object.keys(sections).length === 0) continue;

        const chartDate = freq === 'daily' ? bucket.dailyChartDate : bucket.weeklyChartDate;
        const dateLabel = freq === 'daily'
          ? toCompact(chartDate)
          : weeklyDateLabel(chartDate);

        const title = `${territory.flag} KKBOX ${territory.label} — ${freq.charAt(0).toUpperCase() + freq.slice(1)} (${dateLabel})`;

        const lines = [];
        for (const [label, entries] of Object.entries(sections)) {
          lines.push(label);
          lines.push(...entries);
          lines.push('');
        }
        const hashtagLine = [songHashtags, albumHashtags].filter(Boolean).join(' ');
        if (hashtagLine)   lines.push(hashtagLine);
        if (config.tags)   lines.push(config.tags);
        lines.push(closing);

        await sendEmbed(title, lines);
      }
    }

    // Write sentinels
    if (!dailyDone) {
      appends.push(['**SENTINEL**', dailySentinel, '', '', '', '', '', kstDate, kstDate, '']);
    }
    if (isMonday && !weeklyDone) {
      appends.push(['**SENTINEL**', weeklySentinel, '', '', '', '', '', kstDate, kstDate, '']);
    }
  }

  await flushWrites(sheets, spreadsheetId, updates, appends);
  console.log('KKBOX scraper complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
