'use strict';

const {
  getSheetsClient, getSheetData, appendSheetRow,
  updateSheetRow, getPHTTimestamp,
  getComebackMode, getRegistryData, findRegistryRowByName
} = require('./helpers');
const fetch = require('node-fetch');

const SHEET    = 'Melon Search Tracker';
const BASE_URL = 'https://www.melon.com';

const COL = {
  TERM:          0,
  FIRST_SEEN:    1,
  PEAK_POS:      2,
  PEAK_DATE:     3,
  LAST_SEEN:     4,
  LAST_POS:      5,
};

// ── Fetch trending list ───────────────────────────────────────────────────────

async function fetchTrending() {
  // Step 1 — get session cookie from main page
  const mainRes = await fetch(`${BASE_URL}/search/total/index.htm`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    },
  });
  const cookie = mainRes.headers.get('set-cookie') || '';

  // Step 2 — fetch trending with cookie
  const res = await fetch(`${BASE_URL}/search/side/keywordChart.htm`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      'Referer': `${BASE_URL}/search/total/index.htm`,
      'Cookie': cookie,
    },
  });
  if (!res.ok) throw new Error(`Melon fetch error: ${res.status}`);
  return res.text();
}

// ── Match against search terms ────────────────────────────────────────────────

function matchesTerms(trendingTerm, searchTerms) {
  const lower = trendingTerm.toLowerCase();
  return searchTerms.some(t => lower.includes(t.toLowerCase().trim()));
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function sendEmbed(embed) {
  const res = await fetch(process.env.DISCORD_MILESTONE_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (res.status === 429) {
    const retry = (await res.json()).retry_after || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    await sendEmbed(embed);
  }
}

async function postTrendingAlert(term, pos, isNew, prevPeak) {
  const now    = new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' });
  const title  = isNew
    ? `📈 MELON TRENDING — New Entry`
    : `🔝 MELON TRENDING — New Peak`;
  const desc   = isNew
    ? `**${term}** is trending at **#${pos}** on Melon Realtime Search!\n\n📅 ${now} KST`
    : `**${term}** has reached a new peak of **#${pos}** on Melon Realtime Search! (Previous peak: #${prevPeak})\n\n📅 ${now} KST`;

  await sendEmbed({ title, color: 15844367, description: desc });
}

// ── Sheet init ────────────────────────────────────────────────────────────────

async function ensureSheet(sheets) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET } } }] },
    });
    await appendSheetRow(sheets, SHEET, [
      'Term', 'First Seen', 'Peak Position', 'Peak Date', 'Last Seen', 'Last Position',
    ]);
    console.log(`Created sheet: ${SHEET}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting Melon Search tracker...');

  const sheets     = await getSheetsClient();
  const configData = await getSheetData(sheets, 'Config');
  const cfg        = {};
  for (const row of configData) cfg[row[0]] = row[1] || '';

  if (cfg['MELON_SEARCH_TRACKING'] !== 'YES') {
    console.log('Melon search tracking is OFF. Exiting.');
    return;
  }

    let searchTerms = (cfg['MELON_SEARCH_TERMS'] || '')
    .split(',').map(t => t.trim()).filter(Boolean);

  if (await getComebackMode(sheets)) {
    const row = findRegistryRowByName(await getRegistryData(sheets), cfg['COMEBACK_TRACK']);
    const extra = [row?.[21], row?.[20], cfg['COMEBACK_TRACK'], cfg['COMEBACK_ALBUM']]
      .map(v => (v || '').toString().trim()).filter(v => v.length >= 3);
    searchTerms = [...new Set([...searchTerms, ...extra])];
    console.log(`Search terms (with comeback names): ${searchTerms.join(' | ')}`);
  }

  if (searchTerms.length === 0) {
    console.log('No search terms configured. Exiting.');
    return;
  }

  await ensureSheet(sheets);

  const html     = await fetchTrending();
  const trending = parseTrending(html);

  if (trending.length === 0) {
    console.log('Could not parse trending list — HTML structure may have changed.');
    return;
  }

  console.log(`Trending list: ${trending.map(t => `#${t.pos} ${t.term}`).join(', ')}`);

  const sheetRows  = await getSheetData(sheets, SHEET);
  const today      = getPHTTimestamp().split(' ')[0].replace(/-/g, '');
  const nowPHT     = getPHTTimestamp();

  for (const entry of trending) {
    if (!matchesTerms(entry.term, searchTerms)) continue;

    console.log(`Match: #${entry.pos} ${entry.term}`);

    const existingIdx = sheetRows.findIndex((r, i) =>
      i > 0 && (r[COL.TERM] || '').toLowerCase() === entry.term.toLowerCase()
    );

    if (existingIdx === -1) {
      // New entry
      await postTrendingAlert(entry.term, entry.pos, true, null);
      await appendSheetRow(sheets, SHEET, [
        entry.term, today, entry.pos, today, today, entry.pos,
      ]);
      console.log(`New entry: ${entry.term} at #${entry.pos}`);
    } else {
      const row      = sheetRows[existingIdx];
      const prevPeak = parseInt(row[COL.PEAK_POS], 10) || 999;
      const isNewPeak = entry.pos < prevPeak;

      if (isNewPeak) {
        await postTrendingAlert(entry.term, entry.pos, false, prevPeak);
      }

      const updatedRow = [...row];
      updatedRow[COL.LAST_SEEN] = today;
      updatedRow[COL.LAST_POS]  = entry.pos;
      if (isNewPeak) {
        updatedRow[COL.PEAK_POS]  = entry.pos;
        updatedRow[COL.PEAK_DATE] = today;
      }
      await updateSheetRow(sheets, SHEET, existingIdx + 1, updatedRow);
      console.log(`Updated: ${entry.term} at #${entry.pos}${isNewPeak ? ' (new peak)' : ''}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Melon Search tracker complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
