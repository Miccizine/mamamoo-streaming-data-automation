'use strict';

const {
  getSheetsClient,
  getSheetData,
  getRegistryData,
  findRegistryRowByName,
  appendSheetRow,
  batchAppendRows,
  getMemberConfig,
  buildClosingTags,
  findMatchInRegistry,
  getComebackMode,
  getPHTTimestamp,
  flagNewRelease
} = require('./helpers');

const fetch = require('node-fetch');

// ── Startup jitter ────────────────────────────────────────────────────────────
const JITTER_MS = Math.floor(Math.random() * 20000);

const ARTIST_PAGES = [
  { url: 'https://kworb.net/itunes/artist/mamamoo.html',  label: 'MAMAMOO' },
  { url: 'https://kworb.net/itunes/artist/solar.html',    label: 'Solar' },
  { url: 'https://kworb.net/itunes/artist/moonbyul.html', label: 'Moonbyul' },
  { url: 'https://kworb.net/itunes/artist/wheein.html',   label: 'Wheein' },
  { url: 'https://kworb.net/itunes/artist/hwasa.html',    label: 'Hwasa' }
];

const WORLDWIDE_SONG_URLS = [
  'https://kworb.net/ww/index.html',
  'https://kworb.net/ww/index_full.html'
];

const WORLDWIDE_ALBUM_URL = 'https://kworb.net/aww/';

const MAMAMOO_KEYWORDS = [
  'mamamoo', 'solar', 'moonbyul', 'wheein', 'hwasa',
  '마마무', '솔라', '문별', '휘인', '화사'
];

// ── HTML Parsing ──────────────────────────────────────────────────────────────

function parseTableRows(html) {
  const results = [];
  const rows    = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells       = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length >= 3) results.push(cells);
  }
  return results;
}

// ── Match Artist helpers ──────────────────────────────────────────────────────

const MAMAMOO_ARTISTS_LIST = [
  'mamamoo','마마무','solar','솔라','moonbyul','문별',
  'wheein','휘인','hwasa','화사','mamamoo+','마마무플러스'
];

function isMamamooRelated(artistStr) {
  const n = (artistStr || '').toLowerCase();
  return MAMAMOO_ARTISTS_LIST.some(a => n.includes(a));
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function getPHTHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', hour: 'numeric', hour12: false
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  return h === 24 ? 0 : h;
}

function getPHTDateHourKey() {
  const now = new Date();
  const d   = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const h   = getPHTHour();
  return `${d}T${String(h).padStart(2, '0')}`;
}

function getKSTDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function getKSTHour() {
  return parseInt(new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false
  }), 10);
}

// ── Peak Map ──────────────────────────────────────────────────────────────────

function buildPeakMap(peakData) {
  const map = {};
  for (let i = 1; i < peakData.length; i++) {
    const row = peakData[i];
    if (!row[0] || !row[1]) continue;
    const key  = `${row[0]}|${row[1]}`;
    map[key] = {
      rowIndex:     i + 1,
      peakPosition: parseInt((row[2] || '999').toString().replace(/,/g, ''), 10),
      dateAchieved: row[3] || '',
      lastSeen:     row[4] || '',
      entryDate:    row[5] || '',
      reentryDate:  row[6] || '',
      countOne:     parseInt((row[7] || '0').toString().replace(/,/g, ''), 10),
      countriesOne: (row[8] || '').toString().trim(),
      lastPosition: row[9] ? parseInt(row[9].toString().replace(/,/g, ''), 10) : null
    };
  }
  return map;
}

// ── Peak Tracker Helpers ──────────────────────────────────────────────────────

function getDayCount(entryDate, reentryDate) {
  const baseDate = reentryDate || entryDate;
  if (!baseDate) return 1;
  const dateOnly = baseDate.toString().slice(0, 10);
  const todayKST = getKSTDateString();
  const start = new Date(dateOnly + 'T00:00:00Z');
  const end   = new Date(todayKST + 'T00:00:00Z');
  const diff  = Math.floor((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(1, diff + 1);
}

function isReentry(lastSeen) {
  if (!lastSeen) return false;
  const hoursDiff = (new Date() - new Date(lastSeen)) / (1000 * 60 * 60);
  return hoursDiff > 12;
}

function isRecentRelease(releaseDate) {
  if (!releaseDate) return false;
  const daysDiff = (new Date() - new Date(releaseDate)) / (1000 * 60 * 60 * 24);
  return daysDiff <= 30;
}

// ── Peak Tracker Writer ───────────────────────────────────────────────────────

async function updatePeakTracker(sheets, peakMap, updates) {
  if (updates.length === 0) return;
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  for (const u of updates) {
    const key      = `${u.trackName}|${u.country}`;
    const existing = peakMap[key];
    const now      = getPHTTimestamp();

    if (!existing) {
      const countOne     = u.position === 1 ? 1 : 0;
      const countriesOne = u.position === 1 ? u.country : '';
      await appendSheetRow(sheets, 'iTunes Peak Tracker', [
        u.trackName, u.country, u.position, now, now, now, '', countOne, countriesOne, u.position
      ]);
      peakMap[key] = {
        rowIndex:     -1,
        peakPosition: u.position,
        dateAchieved: now,
        lastSeen:     now,
        entryDate:    now,
        reentryDate:  '',
        countOne,
        countriesOne,
        lastPosition: u.position
      };
    } else {
      const newPeak     = Math.min(u.position, existing.peakPosition);
      const newPeakDate = u.position < existing.peakPosition ? now : existing.dateAchieved;
      const newReentry  = u.isReentry ? now : existing.reentryDate;

      let newCountOne     = existing.countOne;
      let newCountriesOne = existing.countriesOne;
      if (u.position === 1) {
        const listed = newCountriesOne.split(',').map(c => c.trim()).filter(Boolean);
        if (!listed.includes(u.country)) {
          newCountOne++;
          newCountriesOne = listed.length > 0
            ? `${newCountriesOne}, ${u.country}`
            : u.country;
        }
      }

      peakMap[key].peakPosition  = newPeak;
      peakMap[key].dateAchieved  = newPeakDate;
      peakMap[key].lastSeen      = now;
      peakMap[key].reentryDate   = newReentry;
      peakMap[key].countOne      = newCountOne;
      peakMap[key].countriesOne  = newCountriesOne;
      peakMap[key].lastPosition  = u.position;

      if (existing.rowIndex === -1) continue;

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range:            `iTunes Peak Tracker!C${existing.rowIndex}:J${existing.rowIndex}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[
            newPeak, newPeakDate, now,
            existing.entryDate, newReentry,
            newCountOne, newCountriesOne, u.position
          ]]
        }
      });
    }
  }
}

// ── Notification Builder ──────────────────────────────────────────────────────

function buildItunesNotification({
  trackName, position, country, prevPosition,
  dayCount, peakPosition, memberConfig,
  appleUrl, songHashtags, albumHashtags,
  isNew, isReentryFlag,
  countOne, comebackConfig, isAlbumChart
}) {
  const config        = memberConfig;
  const closingTags   = buildClosingTags(config);
  const effectivePeak = Math.min(position, peakPosition);

  const movement = isNew || isReentryFlag
    ? isReentryFlag ? '(Re-entry)' : '(NEW)'
    : prevPosition
      ? position < prevPosition
        ? `(+${prevPosition - position})`
        : position > prevPosition
          ? `(-${position - prevPosition})`
          : '(=)'
      : '(NEW)';

  const isWorldwide = country === 'Worldwide' || country === 'Worldwide-Album';
  let header;
  if (isAlbumChart)      header = 'Worldwide iTunes Album Chart 🌐';
  else if (isWorldwide)  header = 'Worldwide iTunes Song Chart 🌐';
  else                   header = `iTunes Song Chart - ${country}`;

  const lines = [header, ''];
  lines.push(`#${position} ${isWorldwide ? `${config.handle} - ${trackName} ${movement}` : `${config.handle} - ${trackName} ${movement}`}`);

  if (position === 1 && countOne > 0) {
    lines.push('');
    lines.push(`${countOne}${getOrdinalSuffix(countOne)} #1 (${isAlbumChart ? 'Album' : 'Song'})`);
  }

  if (dayCount > 1) {
    lines.push(`\n[DAY ${dayCount}${isReentryFlag ? ' since re-entry' : ''} | PEAK #${effectivePeak}]`);
  }

  if (
    position === 1 &&
    comebackConfig &&
    comebackConfig.isAlbum &&
    comebackConfig.trackName &&
    comebackConfig.goal
  ) {
    const goalNum = parseInt((comebackConfig.goal || '').replace(/,/g, ''), 10);
    lines.push('');
    lines.push(`✅ BUY ${comebackConfig.trackName} FIRST`);
    lines.push(`➡️ Then complete Album`);
    if (goalNum > 0) lines.push(`🏁 Goal: #1 in ${goalNum} countries`);
  }

  if (appleUrl) lines.push('', `🔗 ${appleUrl}`);
  lines.push('');
  if (songHashtags)  lines.push(songHashtags);
  if (albumHashtags) lines.push(albumHashtags);
  if (config.tags)   lines.push(config.tags);
  lines.push(closingTags);

  return lines.join('\n').trim();
}

function getOrdinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ── Close-to-#1 Post Builder ──────────────────────────────────────────────────

function buildCloseToOnePost(trackName, entries, appleUrl, memberConfig, songHashtags, albumHashtags, isContinued) {
  const config      = memberConfig;
  const closingTags = buildClosingTags(config);
  const MAX_CHARS   = 280;

  const footer = [`🔗 ${appleUrl}`, songHashtags, albumHashtags, config.tags, closingTags]
    .filter(Boolean).join('\n');

  const posts   = [];
  let current   = [];

  function assemblePost(lines, cont) {
    const h = `iTunes Song Chart - ${trackName}\n\nCountries close to #1${cont ? '\n(Continued)' : ''}`;
    return [h, '', ...lines, '', footer].join('\n').trim();
  }

  for (const entry of entries) {
    const line = `#${entry.position} ${entry.country}`;
    current.push(line);
    const assembled = assemblePost(current, posts.length > 0 || isContinued);
    if (assembled.length > MAX_CHARS) {
      current.pop();
      if (current.length > 0) {
        posts.push(assemblePost(current, posts.length > 0 || isContinued));
      }
      current = [line];
    }
  }

  if (current.length > 0) {
    posts.push(assemblePost(current, posts.length > 0 || isContinued));
  }

  return posts;
}

// ── Sentinel checks ───────────────────────────────────────────────────────────

function wasCloseToOnePostedThisHour(rawScrapeLog, trackName) {
  const hourKey = getPHTDateHourKey();
  for (let i = rawScrapeLog.length - 1; i >= 1; i--) {
    const row = rawScrapeLog[i];
    if (
      (row[1] || '') === trackName &&
      (row[3] || '') === 'iTunes' &&
      (row[4] || '') === 'Close-to-#1 Sentinel' &&
      (row[0] || '').startsWith(hourKey.replace('T', ' '))
    ) return true;
  }
  return false;
}

function wasPostedTodayKST(rawScrapeLog, trackName, sentinelType) {
  const todayKST = getKSTDateString();
  for (let i = rawScrapeLog.length - 1; i >= 1; i--) {
    const row = rawScrapeLog[i];
    if (
      (row[1] || '') === trackName &&
      (row[3] || '') === 'iTunes' &&
      (row[4] || '') === sentinelType &&
      (row[6] || '') === todayKST
    ) return true;
  }
  return false;
}

// ── Discord Sender ────────────────────────────────────────────────────────────

async function sendItunesDiscord(notifications) {
  if (notifications.length === 0) return;
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;

  for (const n of notifications) {
    const message = {
      embeds: [{
        title:       n.title || '📊 CHART UPDATE — Pending Approval',
        color:       3067903,
        description: n.draft,
        footer:      { text: n.needsValidation
          ? '⚠️ Needs team validation before posting'
          : '✅ Approve and post manually to X | ❌ Discard'
        }
      }]
    };

    const response = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message)
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
      console.log(`Rate limited. Waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(message)
      });
    } else if (!response.ok) {
      console.error(`Discord error ${response.status}`);
    } else {
      console.log(`Sent: ${n.trackName} — ${n.country || ''} #${n.position || ''}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Comeback config loader ────────────────────────────────────────────────────

async function getComebackConfig(sheets) {
  const data = await getSheetData(sheets, 'Config');
  const cfg  = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) cfg[data[i][0]] = (data[i][1] || '').toString().trim();
  }
  return cfg;
}

// ── Country Chart Scraper ─────────────────────────────────────────────────────

async function scrapeCountryCharts(
  sheets, registryData, peakMap,
  rawLogBuffer, peakUpdates, notifications,
  isComeback, comebackConfig, closeToOneEntries
) {
  const processedKeys = new Set();

  for (const artist of ARTIST_PAGES) {
    let html;
    try {
      const res = await fetch(artist.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      console.error(`Fetch error for ${artist.label}: ${e.message}`);
      continue;
    }

    if (html.includes('not charting anywhere at the moment')) {
      console.log(`${artist.label} not charting on iTunes`);
      continue;
    }

    const rows = parseTableRows(html);

    for (const cells of rows) {
      if (cells.length < 3) continue;

      const kworbTitle = cells[0].trim();
      const country    = cells[1].trim();
      const position   = parseInt(cells[2].replace(/,/g, ''), 10) || 0;

      if (!kworbTitle || !country || position === 0) continue;

      const entryKey = `${kworbTitle}|${country}`;
      if (processedKeys.has(entryKey)) continue;
      processedKeys.add(entryKey);

      const match = findMatchInRegistry(kworbTitle, registryData);
      if (!match) {
        await flagNewRelease(sheets, kworbTitle, artist.label, 'iTunes/kworb', artist.url);
        continue;
      }

      const matchedRow     = match.row;
      const trackName      = matchedRow[0];
      const album          = matchedRow[2];
      const releaseDate    = matchedRow[3];
      const activeTracking = (matchedRow[11] || '').toString().trim().toLowerCase();
      const appleUrl       = (matchedRow[13] || '').trim();   // col N(13)
      const songHashtags   = (matchedRow[18] || '').trim();   // col S(18)
      const albumHashtags  = (matchedRow[19] || '').trim();   // col T(19)

      if (activeTracking !== 'yes') continue;

      const memberConfig  = getMemberConfig(matchedRow);
      const peakKey       = `${trackName}|${country}`;
      const existing      = peakMap[peakKey];
      const reentryFlag   = existing ? isReentry(existing.lastSeen) : false;
      const recentRelease = isRecentRelease(releaseDate);
      const isNew         = !existing;
      const isNewPeak     = existing && position < existing.peakPosition;
      const dayCount      = existing
        ? getDayCount(existing.entryDate, existing.reentryDate || '')
        : 1;
      const prevPosition  = existing ? existing.lastPosition : null;
      const countOne      = existing
        ? (position === 1
            ? (() => {
                const listed = (existing.countriesOne || '').split(',').map(c => c.trim()).filter(Boolean);
                return listed.includes(country) ? existing.countOne : existing.countOne + 1;
              })()
            : existing.countOne)
        : position === 1 ? 1 : 0;

      rawLogBuffer.push([
        getPHTTimestamp(), trackName, album, 'iTunes', 'Chart Position',
        position, '', artist.url
      ]);

      peakUpdates.push({ trackName, country, position, isReentry: reentryFlag });

      if (isComeback && position <= 50 && position > 1) {
        if (comebackConfig && trackName === comebackConfig.trackName) {
          closeToOneEntries.push({ position, country });
        }
      }

      const lastPosition = existing ? existing.lastPosition : null;
      const isEqual      = !isNew && !reentryFlag && lastPosition !== null && lastPosition === position;
      const isWorse      = !isNew && !reentryFlag && lastPosition !== null && position > lastPosition;
      const isAlreadyOne = position === 1;

      const shouldNotify = (isNew || reentryFlag || isNewPeak) && !isEqual && !isWorse && !isAlreadyOne;
      if (!shouldNotify) continue;

      const draft = buildItunesNotification({
        trackName, position, country, prevPosition,
        dayCount,
        peakPosition:  existing ? existing.peakPosition : position,
        memberConfig, appleUrl, songHashtags, albumHashtags,
        isNew, isReentryFlag: reentryFlag,
        countOne,
        comebackConfig: null,
        isAlbumChart: false
      });

      notifications.push({
        draft, trackName, country, position,
        title: '📊 CHART UPDATE — Pending Approval',
        needsValidation: isNew && !recentRelease
      });
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Worldwide Song Chart Scraper ──────────────────────────────────────────────

async function scrapeWorldwideSongChart(
  registryData, peakMap,
  rawLogBuffer, peakUpdates, notifications,
  rawScrapeLog
) {
  const processedWorldwide = new Set();

  for (const url of WORLDWIDE_SONG_URLS) {
    let html;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      console.error(`Worldwide song fetch error: ${e.message}`);
      continue;
    }

    const rows = parseTableRows(html);

    for (const cells of rows) {
      const rowText   = cells.join(' ').toLowerCase();
      const isMamamoo = MAMAMOO_KEYWORDS.some(kw => rowText.includes(kw));
      if (!isMamamoo) continue;

      const position    = parseInt(cells[0].replace(/,/g, ''), 10) || 0;
      const artistTitle = cells[2] || cells[1] || '';
      if (position === 0 || !artistTitle) continue;

      const parts       = artistTitle.split(' - ');
      const chartArtist = parts.length > 1 ? parts[0].trim() : '';
      const trackName   = parts.length > 1 ? parts.slice(1).join(' - ').trim() : artistTitle.trim();

      if (!isMamamooRelated(chartArtist)) {
        console.log(`Skip WW: chart artist "${chartArtist}" not Mamamoo-related`);
        continue;
      }

      const wwKey = `${trackName}|${position}`;
      if (processedWorldwide.has(wwKey)) continue;
      processedWorldwide.add(wwKey);

      const match = findMatchInRegistry(trackName, registryData);
      if (!match) continue;

      const registryArtist = (match.row[1] || '').trim();
      if (!isMamamooRelated(registryArtist)) {
        console.log(`Skip WW: "${trackName}" matched non-Mamamoo registry row (${registryArtist})`);
        continue;
      }

      const appleUrl      = (match.row[13] || '').trim();   // col N(13)
      const songHashtags  = (match.row[18] || '').trim();   // col S(18)
      const albumHashtags = (match.row[19] || '').trim();   // col T(19)
      const album         = (match.row[2]  || '').trim();
      const releaseDate   = match.row[3];
      const memberConfig  = getMemberConfig(match.row);

      const peakKey      = `${trackName}|Worldwide`;
      const existing     = peakMap[peakKey];
      const reentryFlag  = existing ? isReentry(existing.lastSeen) : false;
      const recentRelease = isRecentRelease(releaseDate);
      const isNew        = !existing;
      const isNewPeak    = existing && position < existing.peakPosition;
      const dayCount     = existing
        ? getDayCount(existing.entryDate, existing.reentryDate || '')
        : 1;
      const prevPosition = existing ? existing.lastPosition : null;
      const countOne     = existing
        ? (position === 1
            ? (() => {
                const listed = (existing.countriesOne || '').split(',').map(c => c.trim()).filter(Boolean);
                return listed.includes('Worldwide') ? existing.countOne : existing.countOne + 1;
              })()
            : existing.countOne)
        : position === 1 ? 1 : 0;

      rawLogBuffer.push([
        getPHTTimestamp(), trackName, album, 'iTunes', 'Worldwide Position',
        position, '', url
      ]);

      peakUpdates.push({ trackName, country: 'Worldwide', position, isReentry: reentryFlag });

      const alreadyPostedToday = wasPostedTodayKST(rawScrapeLog, trackName, 'WW-Daily-Sentinel');
      if (alreadyPostedToday) {
        console.log(`WW song already posted today for ${trackName}, skipping.`);
        continue;
      }

      const draft = buildItunesNotification({
        trackName, position, country: 'Worldwide', prevPosition,
        dayCount,
        peakPosition:  existing ? existing.peakPosition : position,
        memberConfig, appleUrl, songHashtags, albumHashtags,
        isNew, isReentryFlag: reentryFlag,
        countOne,
        comebackConfig: null,
        isAlbumChart: false
      });

      notifications.push({
        draft, trackName, country: 'Worldwide', position,
        title: '📊 CHART UPDATE — Pending Approval',
        needsValidation: isNew && !recentRelease
      });

      rawLogBuffer.push([
        getPHTTimestamp(), trackName, album, 'iTunes', 'WW-Daily-Sentinel',
        position, getKSTDateString(), 'worldwide-daily'
      ]);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Worldwide Album Chart Scraper ─────────────────────────────────────────────

async function scrapeWorldwideAlbumChart(
  sheets, registryData, peakMap,
  rawLogBuffer, peakUpdates, notifications,
  rawScrapeLog
) {
  let html;
  try {
    const res = await fetch(WORLDWIDE_ALBUM_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error(`Worldwide album fetch error: ${e.message}`);
    return;
  }

  const rows = parseTableRows(html);
  const processedAlbums = new Set();

  for (const cells of rows) {
    const rowText   = cells.join(' ').toLowerCase();
    const isMamamoo = MAMAMOO_KEYWORDS.some(kw => rowText.includes(kw));
    if (!isMamamoo) continue;

    const position    = parseInt(cells[0].replace(/,/g, ''), 10) || 0;
    const artistTitle = cells[2] || cells[1] || '';
    if (position === 0 || !artistTitle) continue;

    const parts     = artistTitle.split(' - ');
    const albumName = parts.length > 1
      ? parts.slice(1).join(' - ').trim()
      : artistTitle.trim();

    const albumKey = `${albumName}|${position}`;
    if (processedAlbums.has(albumKey)) continue;
    processedAlbums.add(albumKey);

    let matchedRow = null;
    const normAlbum = albumName.toLowerCase();
    for (let i = 1; i < registryData.length; i++) {
      const regAlbum = (registryData[i][2] || '').trim().toLowerCase();
      if (!regAlbum) continue;
      if ((registryData[i][11] || '').toString().trim().toLowerCase() !== 'yes') continue;
      if (regAlbum === normAlbum || regAlbum.includes(normAlbum) || normAlbum.includes(regAlbum)) {
        matchedRow = registryData[i];
        break;
      }
    }

    if (!matchedRow) {
      await flagNewRelease(sheets, albumName, '', 'iTunes Album Worldwide/kworb', WORLDWIDE_ALBUM_URL);
      continue;
    }

    const registryArtist = (matchedRow[1] || '').trim();
    if (!isMamamooRelated(registryArtist)) {
      console.log(`Skip WW Album: "${albumName}" matched non-Mamamoo registry row (${registryArtist})`);
      continue;
    }

    const album         = matchedRow[2];
    const releaseDate   = matchedRow[3];
    const appleUrl      = (matchedRow[13] || '').trim();   // col N(13)
    const songHashtags  = (matchedRow[18] || '').trim();   // col S(18)
    const albumHashtags = (matchedRow[19] || '').trim();   // col T(19)
    const memberConfig  = getMemberConfig(matchedRow);

    const peakKey      = `${albumName}|Worldwide-Album`;
    const existing     = peakMap[peakKey];
    const reentryFlag  = existing ? isReentry(existing.lastSeen) : false;
    const recentRelease = isRecentRelease(releaseDate);
    const isNew        = !existing;
    const dayCount     = existing
      ? getDayCount(existing.entryDate, existing.reentryDate || '')
      : 1;
    const prevPosition = existing ? existing.lastPosition : null;
    const countOne     = existing
      ? (position === 1
          ? (() => {
              const listed = (existing.countriesOne || '').split(',').map(c => c.trim()).filter(Boolean);
              return listed.includes('Worldwide') ? existing.countOne : existing.countOne + 1;
            })()
          : existing.countOne)
      : position === 1 ? 1 : 0;

    rawLogBuffer.push([
      getPHTTimestamp(), albumName, album, 'iTunes', 'Worldwide Album Position',
      position, '', WORLDWIDE_ALBUM_URL
    ]);

    peakUpdates.push({ trackName: albumName, country: 'Worldwide-Album', position, isReentry: reentryFlag });

    const alreadyPostedToday = wasPostedTodayKST(rawScrapeLog, albumName, 'WWA-Daily-Sentinel');
    if (alreadyPostedToday) {
      console.log(`WW album already posted today for ${albumName}, skipping.`);
      continue;
    }

    const draft = buildItunesNotification({
      trackName: albumName, position, country: 'Worldwide-Album', prevPosition,
      dayCount,
      peakPosition:  existing ? existing.peakPosition : position,
      memberConfig, appleUrl, songHashtags, albumHashtags,
      isNew, isReentryFlag: reentryFlag,
      countOne,
      comebackConfig: null,
      isAlbumChart: true
    });

    notifications.push({
      draft, trackName: albumName, country: 'Worldwide-Album', position,
      title: '📊 ALBUM CHART UPDATE — Pending Approval',
      needsValidation: isNew && !recentRelease
    });

    rawLogBuffer.push([
      getPHTTimestamp(), albumName, album, 'iTunes', 'WWA-Daily-Sentinel',
      position, getKSTDateString(), 'worldwide-album-daily'
    ]);
  }

  await new Promise(r => setTimeout(r, 2000));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Starting iTunes scraper... (jitter: ${JITTER_MS}ms)`);
  await new Promise(r => setTimeout(r, JITTER_MS));

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  const kstHour    = getKSTHour();
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'} | KST hour: ${kstHour}`);

  if (!isComeback) {
    const currentMinute = new Date().getMinutes();
    const isTwentyMinCron = [6, 21, 36, 51].includes(currentMinute);
    if (isTwentyMinCron) {
      console.log('Normal mode — 20-min cron suppressed. Exiting.');
      return;
    }
  }

  const registryData = await getRegistryData(sheets);
  const peakData     = await getSheetData(sheets, 'iTunes Peak Tracker');
  const rawScrapeLog = await getSheetData(sheets, 'Raw Scrape Log');
  const peakMap      = buildPeakMap(peakData);

  let comebackConfig = null;
  if (isComeback) {
    const cfg = await getComebackConfig(sheets);
    comebackConfig = {
      trackName: (findRegistryRowByName(registryData, cfg['COMEBACK_TRACK']) || [cfg['COMEBACK_TRACK'] || ''])[0],
      isAlbum:   cfg['COMEBACK_IS_ALBUM']?.toUpperCase() === 'YES',
      goal:      cfg['COMEBACK_ITUNES_COUNTRY_GOAL'] || ''
    };
  }

  const rawLogBuffer      = [];
  const peakUpdates       = [];
  const notifications     = [];
  const closeToOneEntries = [];

  await scrapeCountryCharts(
    sheets, registryData, peakMap,
    rawLogBuffer, peakUpdates, notifications,
    isComeback, comebackConfig, closeToOneEntries
  );

  if (kstHour >= 4) {
    await scrapeWorldwideSongChart(
      registryData, peakMap,
      rawLogBuffer, peakUpdates, notifications,
      rawScrapeLog
    );

    await scrapeWorldwideAlbumChart(
      sheets, registryData, peakMap,
      rawLogBuffer, peakUpdates, notifications,
      rawScrapeLog
    );
  } else {
    console.log(`KST hour ${kstHour} — skipping worldwide charts (updates after 4AM KST).`);
  }

  // ── Close-to-#1 post ─────────────────────────────────────────────────────
  if (isComeback && closeToOneEntries.length > 0 && comebackConfig?.trackName) {
    const alreadyPosted = wasCloseToOnePostedThisHour(rawScrapeLog, comebackConfig.trackName);

    if (!alreadyPosted) {
      closeToOneEntries.sort((a, b) => a.position - b.position);

      const comebackRow = (() => {
        for (let i = 1; i < registryData.length; i++) {
          if ((registryData[i][0] || '').trim() === comebackConfig.trackName) return registryData[i];
        }
        return null;
      })();

      if (comebackRow) {
        const memberConfig  = getMemberConfig(comebackRow);
        const appleUrl      = (comebackRow[13] || '').trim();   // col N(13)
        const songHashtags  = (comebackRow[18] || '').trim();   // col S(18)
        const albumHashtags = (comebackRow[19] || '').trim();   // col T(19)

        const posts = buildCloseToOnePost(
          comebackConfig.trackName,
          closeToOneEntries,
          appleUrl,
          memberConfig,
          songHashtags,
          albumHashtags,
          false
        );

        for (const post of posts) {
          notifications.push({
            draft: post,
            trackName: comebackConfig.trackName,
            country: 'Close-to-#1',
            position: null,
            title: '📊 CLOSE TO #1 — Pending Approval',
            needsValidation: false
          });
        }

        rawLogBuffer.push([
          getPHTTimestamp(),
          comebackConfig.trackName,
          '',
          'iTunes',
          'Close-to-#1 Sentinel',
          closeToOneEntries.length,
          '',
          'comeback-close-to-one'
        ]);

        console.log(`Close-to-#1 post queued: ${closeToOneEntries.length} countries`);
      }
    } else {
      console.log('Close-to-#1 already posted this hour, skipping.');
    }
  }

  console.log(`Writing ${rawLogBuffer.length} rows to Raw Scrape Log...`);
  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer, 'A:H');

  console.log(`Updating peak tracker: ${peakUpdates.length} entries...`);
  await updatePeakTracker(sheets, peakMap, peakUpdates);

  const validationNeeded = notifications.filter(n => n.needsValidation);
  if (validationNeeded.length > 0) {
    console.log(`${validationNeeded.length} entries need team validation`);
  }

  console.log(`Sending ${notifications.length} notifications...`);
  await sendItunesDiscord(notifications);

  console.log('iTunes scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
