'use strict';

const fetch = require('node-fetch');
const {
  getSheetsClient, getSheetData, appendSheetRow, getPHTTimestamp,
  getComebackMode, getRegistryData, findRegistryRowByName
} = require('./helpers');

const DISCORD_CHARTS_WEBHOOK = process.env.DISCORD_CHARTS_WEBHOOK;
const RSSHUB_BASE            = 'https://rsshub.app/twitter/user';

const SOURCES = [
  { handle: 'Billboard_JAPAN', label: 'BILLBOARD JAPAN', color: 16711680 },
  { handle: 'HTSChart',        label: 'HTS CHART',       color: 16744272 }
];

const MAMAMOO_KEYWORDS = [
  'mamamoo', '마마무', 'solar', 'solarsolar', 'moonbyul', 'wheein', 'hwasa'
];

function isMamamooRelated(text, extraNames = []) {
  const lower = text.toLowerCase();
  return [...MAMAMOO_KEYWORDS, ...extraNames].some(kw => lower.includes(kw.toLowerCase()));
}
  
// ── Parse RSS feed ────────────────────────────────────────────────────────────

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title    = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)   || block.match(/<title>([\s\S]*?)<\/title>/))?.[1]   || '';
    const link     = (block.match(/<link>([\s\S]*?)<\/link>/))?.[1]                                                                      || '';
    const pubDate  = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/))?.[1]                                                                 || '';
    const desc     = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || block.match(/<description>([\s\S]*?)<\/description>/))?.[1] || '';

    // Use description if available (fuller text), else title
    const rawText = desc || title;
    // Strip HTML tags
    const text = rawText.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

    if (text && link) items.push({ text, link, pubDate });
  }
  return items;
}

// ── Dedup against Raw Scrape Log ──────────────────────────────────────────────

function isAlreadyLogged(scrapeLog, sourceUrl) {
  for (let i = 1; i < scrapeLog.length; i++) {
    if ((scrapeLog[i][7] || '') === sourceUrl) return true;
  }
  return false;
}

// ── Send to Discord ───────────────────────────────────────────────────────────

async function sendToChartsWebhook(payload) {
  const response = await fetch(DISCORD_CHARTS_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    console.log(`Rate limited. Waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    await fetch(DISCORD_CHARTS_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
  } else if (!response.ok) {
    console.error(`Discord webhook error: ${response.status}`);
  }

  await new Promise(r => setTimeout(r, 2000));
}

// ── Build embed ───────────────────────────────────────────────────────────────

function buildEmbed(label, color, text, sourceUrl) {
  return {
    content: `🔗 ${sourceUrl}`,
    embeds: [{
      title:       `[${label}]`,
      color,
      description: text,
      footer:      { text: '✅ Approve and post manually to X | ❌ Discard\nSource link above is for reference only — do not include when posting.' }
    }]
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting X Charts scraper...');

  const sheets    = await getSheetsClient();
  const scrapeLog = await getSheetData(sheets, 'Raw Scrape Log');
  const logBuffer = [];

    let comebackNames = [];
  if (await getComebackMode(sheets)) {
    const cfgRows = await getSheetData(sheets, 'Config');
    const cfg = {};
    for (const r of cfgRows) cfg[r[0]] = (r[1] || '').toString().trim();
    const row = findRegistryRowByName(await getRegistryData(sheets), cfg['COMEBACK_TRACK']);
    comebackNames = [...new Set([row?.[21], row?.[20], cfg['COMEBACK_TRACK'], cfg['COMEBACK_ALBUM']]
      .map(v => (v || '').toString().trim()).filter(v => v.length >= 3))];
    console.log(`Comeback names: ${comebackNames.join(' | ')}`);
  }

  for (const source of SOURCES) {
    const url = `${RSSHUB_BASE}/${source.handle}`;
    console.log(`Fetching RSS: ${url}`);

    let xml;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'MMMcharts/1.0' } });
      if (!res.ok) {
        console.error(`RSS fetch failed for ${source.handle}: ${res.status}`);
        continue;
      }
      xml = await res.text();
    } catch (e) {
      console.error(`RSS fetch error for ${source.handle}:`, e.message);
      continue;
    }

    const items = parseRSS(xml);
    console.log(`${source.handle}: ${items.length} items parsed`);

    for (const item of items) {
      if (!isMamamooRelated(item.text, comebackNames)) continue;
      if (isAlreadyLogged(scrapeLog, item.link)) {
        console.log(`Already logged: ${item.link}`);
        continue;
      }

      console.log(`New item: ${item.link}`);

      // Log to Raw Scrape Log — cols A:H
      // A: Timestamp | B: Track Name | C: Album | D: Platform | E: Count Type | F: Raw Count | G: Combined | H: Source
      const logRow = [getPHTTimestamp(), '', '', source.label, 'Chart Post', '', '', item.link];
      logBuffer.push(logRow);
      // Add to in-memory dedup immediately
      scrapeLog.push(logRow);

      await sendToChartsWebhook(buildEmbed(source.label, source.color, item.text, item.link));
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  if (logBuffer.length > 0) {
    const { batchAppendRows } = require('./helpers');
    await batchAppendRows(sheets, 'Raw Scrape Log', logBuffer, 'A:H');
    console.log(`Logged ${logBuffer.length} new items.`);
  } else {
    console.log('No new Mamamoo-related items found.');
  }

  console.log('X Charts scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
