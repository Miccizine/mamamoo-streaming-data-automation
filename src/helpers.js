const { google } = require('googleapis');
const fetch = require('node-fetch');

// ── PHT Timestamp ─────────────────────────────────────────────────────────────

function getPHTTimestamp() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type)?.value || '00';
  let hour = get('hour');
  if (hour === '24') hour = '00';

  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

// ── Google Sheets Auth ────────────────────────────────────────────────────────

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetData(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${sheetName}!A:Z`
  });
  return response.data.values || [];
}

async function appendSheetRow(sheets, sheetName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] }
  });
}

async function batchAppendRows(sheets, sheetName, rows, range = 'A:Z') {
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${sheetName}!${range}`,
    valueInputOption: 'RAW',
    resource: { values: rows }
  });
}

// ── Member Config ─────────────────────────────────────────────────────────────

function getMemberConfig(row) {
  const ot4      = row[5];
  const solar    = row[6];
  const moonbyul = row[7];
  const wheein   = row[8];
  const hwasa    = row[9];

  const memberTags = {
    solar:    { handle: '#SOLAR',    tags: '#솔라 #ソラ #金容仙',      label: '@RBW_MAMAMOO' },
    moonbyul: { handle: '#MOONBYUL', tags: '#문별 #ムンビョル #文星伊', label: '@RBW_MAMAMOO' },
    wheein:   { handle: '#WHEEIN',   tags: '#휘인 #フィイン #丁輝人',   label: '@WheeIn_0fficial' },
    hwasa:    { handle: '#HWASA',    tags: '#화사 #ファサ #華莎',       label: '@OfficialPnation' }
  };

  const activeMembers = [];
  if (solar    === true || solar    === 'TRUE') activeMembers.push('solar');
  if (moonbyul === true || moonbyul === 'TRUE') activeMembers.push('moonbyul');
  if (wheein   === true || wheein   === 'TRUE') activeMembers.push('wheein');
  if (hwasa    === true || hwasa    === 'TRUE') activeMembers.push('hwasa');

  if (ot4 === true || ot4 === 'TRUE' || activeMembers.length === 0 || activeMembers.length === 4) {
    return { handle: '#MAMAMOO', tags: '', label: '@RBW_MAMAMOO' };
  }

  if (activeMembers.length === 1) {
    return memberTags[activeMembers[0]];
  }

  // Special case — Mamamoo+ unit (Solar + Moonbyul)
  if (activeMembers.length === 2 &&
      activeMembers.includes('solar') &&
      activeMembers.includes('moonbyul')) {
    return {
      handle: 'MAMAMOO+',
      tags:   '#MAMAMOOplus #마마무플러스\n#SOLAR #솔라 #MOONBYUL #문별',
      label:  '@RBW_MAMAMOO'
    };
  }

  // Unit — combine handles, tags per line, labels deduplicated
  const handles = activeMembers.map(m => memberTags[m].handle).join(' & ');
  const tags    = activeMembers.map(m => memberTags[m].tags).join('\n');
  const labels  = [...new Set(activeMembers.map(m => memberTags[m].label))].join(' ');
  return { handle: handles, tags, label: labels };
}

// ── Closing Tags ──────────────────────────────────────────────────────────────

function buildClosingTags(config) {
  const isGroup = config.handle === '#MAMAMOO';
  if (isGroup) return '#마마무 #ママム #妈妈木\n@RBW_MAMAMOO';
  return `${config.label} #마마무`;
}

// ── Milestone Helpers ─────────────────────────────────────────────────────────

function formatMilestoneNumber(num) {
  if (num >= 1000000000) return (num / 1000000000).toFixed(0) + ' Billion';
  if (num >= 1000000)    return (num / 1000000).toFixed(0) + ' Million';
  if (num >= 1000)       return (num / 1000).toFixed(0) + ' Thousand';
  return num.toLocaleString();
}

function buildMilestoneLabel(platform, countType) {
  if (platform === 'Spotify') return '[SPOTIFY MILESTONE] 🎵';
  if (countType === 'Combined Views') return '[MV MILESTONE — COMBINED] 🔥';
  return '[MV MILESTONE] 🔥';
}

function buildMilestoneSentence(config, trackName, formattedMilestone, platform, countType) {
  if (platform === 'Spotify') {
    return `${config.handle}'s "${trackName}" has surpassed ${formattedMilestone} streams on Spotify!`;
  }
  if (countType === 'Combined Views') {
    return `${config.handle}'s "${trackName}" MV has surpassed ${formattedMilestone} combined views on YouTube!`;
  }
  return `${config.handle}'s "${trackName}" MV has surpassed ${formattedMilestone} views on YouTube!`;
}

// ── Milestone Detection ───────────────────────────────────────────────────────

async function checkMilestone(sheets, trackName, album, platform, countType, currentCount, sourceUrl, memberConfig) {
  const interval = 10000000;
  const lastMilestone = Math.floor(currentCount / interval) * interval;
  if (lastMilestone === 0) return null;

  const existing = await getSheetData(sheets, 'Milestones Achieved');
  for (let i = 1; i < existing.length; i++) {
    if (existing[i][1] === trackName &&
        existing[i][3] === platform &&
        parseInt((existing[i][4] || '').toString().replace(/,/g, ''), 10) === lastMilestone) {
      return null;
    }
  }

  console.log(`New milestone: ${trackName} | ${platform} | ${lastMilestone}`);

  await appendSheetRow(sheets, 'Milestones Achieved', [
    getPHTTimestamp(),
    trackName,
    album,
    platform,
    lastMilestone,
    countType,
    sourceUrl,
    '',
    ''
  ]);

  return {
    trackName,
    album,
    platform,
    milestone: lastMilestone,
    countType,
    sourceUrl,
    memberConfig
  };
}

// ── Discord Delivery ──────────────────────────────────────────────────────────

async function sendDiscordDraft(milestones) {
  if (milestones.length === 0) return;
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;

  for (const m of milestones) {
    const config             = m.memberConfig;
    const formattedMilestone = formatMilestoneNumber(m.milestone);
    const sourceUrl          = m.sourceUrl || '';
    const closingTags        = buildClosingTags(config);
    const headerLabel        = buildMilestoneLabel(m.platform, m.countType);
    const sentence           = buildMilestoneSentence(config, m.trackName, formattedMilestone, m.platform, m.countType);

    const tweetLines = [
      headerLabel,
      '',
      sentence,
      '',
      `🔗 ${sourceUrl}`,
      ''
    ];

    if (m.songHashtags)  tweetLines.push(m.songHashtags);
    if (m.albumHashtags) tweetLines.push(m.albumHashtags);
    if (config.tags)     tweetLines.push(config.tags);
    tweetLines.push(closingTags);

    const draftTweet = tweetLines.join('\n').trim();

    const message = {
      embeds: [{
        title: '🎯 MILESTONE ALERT — Pending Approval',
        color: m.platform === 'Spotify' ? 1947988 : 5814783,
        description: draftTweet,
        footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
      }]
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after') || 5;
      console.log(`Rate limited. Waiting ${retryAfter} seconds...`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      });
    } else if (!response.ok) {
      console.error(`Discord error ${response.status} for ${m.trackName}`);
    } else {
      console.log(`Sent: ${m.trackName} — ${m.platform} ${formatMilestoneNumber(m.milestone)}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Log to Raw Scrape Log ─────────────────────────────────────────────────────

async function logToSheet(sheets, trackName, album, platform, countType, rawCount, source, combinedViews) {
  await appendSheetRow(sheets, 'Raw Scrape Log', [
    getPHTTimestamp(),
    trackName,
    album,
    platform,
    countType,
    rawCount,
    combinedViews || '',
    source
  ]);
}

// ── Comeback Mode ─────────────────────────────────────────────────────────────

async function getComebackMode(sheets) {
  const config = await getSheetData(sheets, 'Config');
  for (let i = 1; i < config.length; i++) {
    if (config[i][0] === 'COMEBACK_MODE') {
      return config[i][1].toString().trim().toUpperCase() === 'ON';
    }
  }
  return false;
}

// ── Title Normalization ───────────────────────────────────────────────────────

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/\(feat\..*?\)/gi, '')
    .replace(/\(ft\..*?\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Registry (header-based) ───────────────────────────────────────────────────
// Reads 'Master Registry' by header name and returns rows in the legacy layout:
// 0 name (EN, else KR) | 1 Artist | 2 Album | 3 Release | 4 Type | 5-9 OT4..Hwasa
// 10 Active | 11 Effective | 12 Spotify URI | 13 Apple URL | 14 Video Type
// 15-17 YouTube 1-3 | 18 Song Hashtags | 19 Album Hashtags | 20 Name (KR) | 21 Name (EN)
// Row order is unchanged, so sheet row numbers still line up.
const REGISTRY_FIELDS = [
  'Artist', 'Album', 'Release Date', 'Type', 'OT4', 'Solar', 'Moonbyul', 'Wheein', 'Hwasa',
  'Active Tracking', 'Effective Tracking', 'Spotify URI', 'Apple Music URL', 'Video Type',
  'YouTube URL 1', 'YouTube URL 2', 'YouTube URL 3', 'Song Hashtags', 'Album Hashtags'
];

async function getRegistryData(sheets) {
  const raw = await getSheetData(sheets, 'Master Registry');
  if (!raw.length) return raw;
  const headers = raw[0].map(h => (h || '').toString().trim().toLowerCase());
  const col     = name => headers.indexOf(name.toLowerCase());
  const en = col('Track Name (EN)'), kr = col('Track Name (KR)');
  if (en < 0 && kr < 0) throw new Error('Master Registry: no "Track Name (EN)" / "Track Name (KR)" header found');

  const cols    = REGISTRY_FIELDS.map(col);
  const missing = REGISTRY_FIELDS.filter((_, i) => cols[i] < 0);
  if (missing.length) console.warn(`Master Registry missing headers: ${missing.join(', ')}`);

  return raw.map((r, i) => {
    if (i === 0) return ['Track Name', ...REGISTRY_FIELDS, 'Track Name (KR)', 'Track Name (EN)'];
    const get    = c => (c < 0 || r[c] === undefined ? '' : r[c]);
    const enName = get(en).toString().trim();
    const krName = get(kr).toString().trim();
    return [enName || krName, ...cols.map(get), krName, enName];
  });
}

const isLatin = s => /^[a-z0-9 ]+$/.test(s);

// All normalized names a row can be matched by (EN, KR)
function getNameVariants(row) {
  return [...new Set([row[21], row[20], row[0]]
    .map(v => normalizeTitle((v || '').toString())).filter(Boolean))];
}

// Find a row by either name (used for Config's COMEBACK_TRACK)
function findRegistryRowByName(registryData, name) {
  const n = normalizeTitle((name || '').toString());
  if (!n) return null;
  for (let i = 1; i < registryData.length; i++) {
    if (getNameVariants(registryData[i]).includes(n)) return registryData[i];
  }
  return null;
}

// ── Registry Match ────────────────────────────────────────────────────────────
//
// Two-pass: exact match first, then partial.
// Partial match requires both normalized titles to be >= 5 chars to prevent
// short registry titles ("O", "NA", "EGO", "HIP") from matching any chart
// title containing those substrings. Empty normalized titles are skipped.

function findMatchInRegistry(chartTitle, registryData) {
  const n = normalizeTitle((chartTitle || '').toString());
  if (!n) return null;

  // Pass 1: exact match on EN or KR name
  for (let i = 1; i < registryData.length; i++) {
    if (getNameVariants(registryData[i]).includes(n)) {
      return { rowIndex: i, row: registryData[i], matchType: 'exact' };
    }
  }

  // Pass 2: partial, Latin text only, both sides >= 5 chars (Korean = exact only)
  if (!isLatin(n) || n.length < 5) return null;
  for (let i = 1; i < registryData.length; i++) {
    for (const v of getNameVariants(registryData[i])) {
      if (isLatin(v) && v.length >= 5 && (n.includes(v) || v.includes(n))) {
        return { rowIndex: i, row: registryData[i], matchType: 'partial' };
      }
    }
  }
  return null;
}

// ── New Release Flag ──────────────────────────────────────────────────────────

async function flagNewRelease(sheets, trackName, artist, source, sourceUrl) {
  const sheetId   = process.env.GOOGLE_SHEETS_ID;
  const flagsData = await getSheetData(sheets, 'New Release Flags');

  for (let i = 1; i < flagsData.length; i++) {
    if (normalizeTitle(flagsData[i][1] || '') === normalizeTitle(trackName)) {
      return;
    }
  }

  await appendSheetRow(sheets, 'New Release Flags', [
    getPHTTimestamp(),
    trackName,
    artist || '',
    source,
    sourceUrl,
    'Pending'
  ]);

  const webhookUrl = process.env.DISCORD_FLAGS_WEBHOOK;
  if (!webhookUrl) return;

  const message = {
    embeds: [{
      title: '🆕 NEW RELEASE DETECTED — Needs Review',
      color: 16776960,
      fields: [
        { name: '🎵 Track',  value: trackName,           inline: true },
        { name: '🎤 Artist', value: artist || 'Unknown', inline: true },
        { name: '📊 Source', value: source,               inline: true },
        { name: '🔗 URL',    value: sourceUrl,            inline: false }
      ],
      description: 'This track appeared on a chart but is not in the Master Registry.\nReview and add manually if relevant.',
      footer: { text: '✅ Add to Registry | ❌ Mark as Not Relevant' }
    }]
  };

  try {
    const response = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message)
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after') || 5;
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(message)
      });
    }
  } catch(e) {
    console.error(`Flag webhook error: ${e.message}`);
  }

  console.log(`🆕 Flagged new release: ${trackName}`);
}

// ── Update Sheet Row ──────────────────────────────────────────────────────────

async function updateSheetRow(sheets, sheetName, rowIndex, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${sheetName}!A${rowIndex}:Z${rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getPHTTimestamp,
  getSheetsClient,
  getSheetData,
  appendSheetRow,
  batchAppendRows,
  updateSheetRow,
  getMemberConfig,
  buildClosingTags,
  formatMilestoneNumber,
  buildMilestoneLabel,
  buildMilestoneSentence,
  checkMilestone,
  sendDiscordDraft,
  logToSheet,
  getComebackMode,
  normalizeTitle,
  findMatchInRegistry,
  flagNewRelease
};
