'use strict';

const {
  getSheetsClient,
  getSheetData,
  batchAppendRows,
  getPHTTimestamp,
  getComebackMode,
  getRegistryData,
  findRegistryRowByName
} = require('./helpers');

const fetch = require('node-fetch');

// ── Startup jitter — prevents concurrent workflow Sheets quota collisions ─────
const JITTER_MS = Math.floor(Math.random() * 20000); // 0–20s random delay

// ── RSS Sources ───────────────────────────────────────────────────────────────

const RSS_SOURCES = [
  {
    url:      'https://www.soompi.com/feed',
    label:    'Soompi',
    language: 'EN',
    keywords: ['mamamoo', 'solar', 'moonbyul', 'wheein', 'hwasa', 'mamamoo+']
  },
  {
    url:      'https://en.yna.co.kr/RSS/news.xml',
    label:    'Yonhap',
    language: 'EN',
    keywords: ['mamamoo', 'solar', 'moonbyul', 'wheein', 'hwasa', 'mamamoo+']
  },
  {
    url:      'https://koreajoongangdaily.joins.com/rss/news.xml',
    label:    'JoongAng Daily',
    language: 'EN',
    keywords: ['mamamoo', 'solar', 'moonbyul', 'wheein', 'hwasa', 'mamamoo+']
  },
  {
    url:      'https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml',
    label:    'Chosun',
    language: 'KR',
    keywords: ['마마무', '솔라', '문별', '휘인', '화사', '김용선', '안혜진', '정휘인', '문별이', '마마무플러스']
  },
  {
    url:      'https://news.google.com/rss/search?q=%EB%A7%88%EB%A7%88%EB%AC%B4+when:1d&hl=ko&gl=KR&ceid=KR:ko',
    label:    'Google News KR - 마마무',
    language: 'KR',
    keywords: ['마마무', '솔라', '문별', '휘인', '화사', '마마무플러스']
  },
  {
    url:      'https://news.google.com/rss/search?q=%EC%86%94%EB%9D%BC+%EB%A7%88%EB%A7%88%EB%AC%B4+when:1d&hl=ko&gl=KR&ceid=KR:ko',
    label:    'Google News KR - 솔라',
    language: 'KR',
    keywords: ['솔라', '마마무', '김용선', '마마무플러스']
  },
  {
    url:      'https://news.google.com/rss/search?q=%EB%AC%B8%EB%B3%84+%EB%A7%88%EB%A7%88%EB%AC%B4+when:1d&hl=ko&gl=KR&ceid=KR:ko',
    label:    'Google News KR - 문별',
    language: 'KR',
    keywords: ['문별', '마마무', '문별이', '마마무플러스']
  },
  {
    url:      'https://news.google.com/rss/search?q=%ED%9C%98%EC%9D%B8+%EB%A7%88%EB%A7%88%EB%AC%B4+when:1d&hl=ko&gl=KR&ceid=KR:ko',
    label:    'Google News KR - 휘인',
    language: 'KR',
    keywords: ['휘인', '마마무', '정휘인', '마마무플러스']
  },
  {
    url:      'https://news.google.com/rss/search?q=%ED%99%94%EC%82%AC+%EB%A7%88%EB%A7%88%EB%AC%B4+when:1d&hl=ko&gl=KR&ceid=KR:ko',
    label:    'Google News KR - 화사',
    language: 'KR',
    keywords: ['화사', '마마무', '안혜진', '마마무플러스']
  }
];

// ── DeepL Translation ─────────────────────────────────────────────────────────

async function translateText(text, targetLang = 'EN') {
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) return text;

  try {
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method:  'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        text:        [text],
        target_lang: targetLang,
        source_lang: 'KO'
      })
    });

    if (!response.ok) {
      console.error(`DeepL error: ${response.status}`);
      return text;
    }

    const data = await response.json();
    return data.translations?.[0]?.text || text;
  } catch (e) {
    console.error(`Translation error: ${e.message}`);
    return text;
  }
}

// ── RSS Fetch + Parse ─────────────────────────────────────────────────────────

async function fetchRSS(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (e) {
    console.error(`RSS fetch error for ${url}: ${e.message}`);
    return null;
  }
}

function parseRSSItems(xml) {
  const items  = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title   = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     block.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '';
    const link    = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                     block.match(/<link\s+href="([^"]+)"/))?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
    const rawDesc = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     block.match(/<description>([\s\S]*?)<\/description>/))?.[1] || '';

    const desc = rawDesc
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;[^&]*&gt;/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (!title || !link) continue;
    items.push({ title, link, pubDate, description: desc });
  }

  return items;
}

function isRecent(pubDate, hoursBack = 24) {
  if (!pubDate) return true;
  const pub  = new Date(pubDate);
  const now  = new Date();
  const diff = (now - pub) / (1000 * 60 * 60);
  return diff <= hoursBack;
}

function containsKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

// ── Discord News Draft ────────────────────────────────────────────────────────

async function sendNewsDiscord(articles) {
  if (articles.length === 0) return;
  const webhookUrl = process.env.DISCORD_NEWS_WEBHOOK;

  for (const article of articles) {
    const message = {
      embeds: [{
        title:  '📰 NEWS — Pending Approval',
        color:  3447003,
        fields: [
          { name: '📌 Title',   value: article.title,                       inline: false },
          { name: '📝 Summary', value: article.summary.substring(0, 500) || 'No summary', inline: false },
          { name: '🌐 Source',  value: article.source,                      inline: true  },
          { name: '🔗 URL',     value: article.url,                         inline: false }
        ],
        footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
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
      console.error(`Discord error ${response.status} for: ${article.title}`);
    } else {
      console.log(`Sent: ${article.title}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const HANGUL = /[가-힣]/;

function googleNewsFeed(name) {
  const kr = HANGUL.test(name);
  const q  = encodeURIComponent(`${name} ${kr ? '마마무' : 'MAMAMOO'}`) + '+when:1d';
  return {
    url:      kr
      ? `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`
      : `https://news.google.com/rss/search?q=${q}&hl=en&gl=US&ceid=US:en`,
    label:    `Google News ${kr ? 'KR' : 'EN'} - ${name}`,
    language: kr ? 'KR' : 'EN',
    keywords: [name]
  };
}

async function main() {
  console.log(`Starting news pipeline... (jitter delay: ${JITTER_MS}ms)`);
  await new Promise(r => setTimeout(r, JITTER_MS));

  const sheets  = await getSheetsClient();
  const newsLog = await getSheetData(sheets, 'News Log');

    const isComeback = await getComebackMode(sheets);
  let comebackNames = [];
  if (isComeback) {
    const cfgRows = await getSheetData(sheets, 'Config');
    const cfg = {};
    for (const r of cfgRows) cfg[r[0]] = (r[1] || '').toString().trim();
    const row = findRegistryRowByName(await getRegistryData(sheets), cfg['COMEBACK_TRACK']);
    comebackNames = [...new Set([row?.[21], row?.[20], cfg['COMEBACK_TRACK'], cfg['COMEBACK_ALBUM']]
      .map(v => (v || '').toString().trim()).filter(v => v.length >= 3))];
    console.log(`Comeback search names: ${comebackNames.join(' | ')}`);
  }
  const sources = [
    ...RSS_SOURCES.map(s => ({ ...s, keywords: [...s.keywords, ...comebackNames] })),
    ...comebackNames.map(googleNewsFeed)
  ];

  // Build dedup sets from in-memory news log
  const loggedUrls   = new Set();
  const loggedTitles = new Set();

  for (let i = 1; i < newsLog.length; i++) {
    if (newsLog[i][4]) loggedUrls.add(newsLog[i][4]);
    if (newsLog[i][1]) loggedTitles.add(newsLog[i][1].toLowerCase().trim());
  }

  const newArticles = [];
  const logBuffer   = [];

  for (const source of sources) {
    console.log(`Fetching: ${source.label}`);

    const xml = await fetchRSS(source.url);
    if (!xml) continue;

    const items = parseRSSItems(xml);
    console.log(`  Found ${items.length} items`);

    for (const item of items) {
      if (loggedUrls.has(item.link)) continue;

      const normalizedTitle = item.title.toLowerCase().trim();
      if (loggedTitles.has(normalizedTitle)) continue;
      loggedTitles.add(normalizedTitle);

      if (!isRecent(item.pubDate, 24)) continue;

      const fullText = `${item.title} ${item.description}`;
      if (!containsKeyword(fullText, source.keywords)) continue;

      let title   = item.title;
      let summary = item.description.substring(0, 300);

      if (source.language === 'KR') {
        console.log(`  Translating: ${title.substring(0, 50)}...`);
        title   = await translateText(title);
        summary = await translateText(summary);
        await new Promise(r => setTimeout(r, 500));
      }

      logBuffer.push([
        getPHTTimestamp(),
        title,
        summary,
        source.label,
        item.link,
        source.language,
        'Pending'
      ]);

      newArticles.push({ title, summary, source: source.label, url: item.link });
      loggedUrls.add(item.link);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  // Batch write to News Log (RAW to avoid number formatting issues)
  if (logBuffer.length > 0) {
    console.log(`Logging ${logBuffer.length} articles...`);
    await batchAppendRows(sheets, 'News Log', logBuffer);
  }

  console.log(`Sending ${newArticles.length} articles to Discord...`);
  await sendNewsDiscord(newArticles);

  console.log(`News pipeline complete. Articles found: ${newArticles.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
