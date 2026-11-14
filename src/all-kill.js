'use strict';

const {
  getSheetsClient, getSheetData, getPHTTimestamp,
  appendSheetRow, getComebackMode,
  getRegistryData, findMatchInRegistry
} = require('./helpers');
const fetch = require('node-fetch');

const ARTIST_TERMS = [
  'MAMAMOO', '마마무',
  'Solar', '솔라',
  'Moonbyul', '문별',
  'Wheein', '휘인',
  'Hwasa', '화사', 'HWASA',
];

const BASE_URL = 'https://api.instiz.net/v2/ichart/record/allkill';
const SHEET    = 'Milestones Achieved';

function isOurArtist(artist) {
  if (!artist) return false;
  const lower = artist.toLowerCase();
  return ARTIST_TERMS.some(t => lower.includes(t.toLowerCase()));
}

async function fetchAllKill(type) {
  const res = await fetch(`${BASE_URL}?type=${type}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer':    'https://www.ichart.kr/',
    },
  });
  if (!res.ok) throw new Error(`allkill API ${res.status} type=${type}`);
  return res.json();
}

async function sendEmbed(webhookUrl, embed) {
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
  if (res.status === 429) {
    const retry = (await res.json()).retry_after || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    await sendEmbed(webhookUrl, embed);
  }
}

async function alreadyPosted(sheets, songTitle, type) {
  const rows = await getSheetData(sheets, SHEET);
  const label = type === 2 ? 'PAK' : 'AK';
  return rows.some(r =>
    (r[1] || '').toLowerCase() === songTitle.toLowerCase() &&
    (r[3] || '') === 'iChart' &&
    (r[5] || '') === label
  );
}

async function main() {
  console.log('Starting iChart All Kill monitor...');

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);

  if (!isComeback) {
    console.log('Not in comeback mode. Exiting.');
    return;
  }

  const configData = await getSheetData(sheets, 'Config');
  const cfg = {};
  for (const row of configData) cfg[row[0]] = row[1] || '';

  const track = cfg['COMEBACK_TRACK'];
  const artist = cfg['COMEBACK_ARTIST'];

  if (!track || !artist) {
    console.log('COMEBACK_TRACK or COMEBACK_ARTIST not set. Exiting.');
    return;
  }

  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;
  const timestamp  = getPHTTimestamp();
  const registryData = await getRegistryData(sheets);

  // Check both AK (type=1) and PAK (type=2)
  for (const type of [1, 2]) {
    const label = type === 2 ? 'Perfect All Kill' : 'All Kill';
    const short = type === 2 ? 'PAK' : 'AK';
    console.log(`Checking ${label}...`);

    try {
      const records = await fetchAllKill(type);
      const active  = records.filter(r => r.isActive === 1 && isOurArtist(r.artist));

      for (const record of active) {
        const songTitle = record.song?.title || record.artist;
        console.log(`Active ${label}: ${songTitle} by ${record.artist}`);

        if (await alreadyPosted(sheets, songTitle, type)) {
          console.log(`Already posted: ${songTitle} ${short}`);
          continue;
        }

        const memberTags = {
          MAMAMOO:  { tags: '#MAMAMOO #마마무', label: '@RBW_MAMAMOO' },
          Solar:    { tags: '#SOLAR #솔라',     label: '@RBW_MAMAMOO' },
          Moonbyul: { tags: '#MOONBYUL #문별',  label: '@RBW_MAMAMOO' },
          Wheein:   { tags: '#WHEEIN #휘인',    label: '@WheeIn_0fficial' },
          Hwasa:    { tags: '#HWASA #화사',     label: '@OfficialPnation' },
        };
        const tag = memberTags[artist] || { tags: '#MAMAMOO', label: '@RBW_MAMAMOO' };

        const match         = findMatchInRegistry(songTitle, registryData);
        const songHashtags  = match ? (match.row[18] || '').trim() : '';
        const albumHashtags = match ? (match.row[19] || '').trim() : '';
        
        const description = [
          `🏆 **${record.artist}** has achieved a **${label}** on iChart!`,
          ``,
          `🎵 **${songTitle}**`,
          ``,
          ...[songHashtags, albumHashtags].filter(Boolean),
          tag.tags,
          tag.label,
        ].join('\n');

        await sendEmbed(webhookUrl, {
          title: `[iCHART] ${label.toUpperCase()} ACHIEVED`,
          color: type === 2 ? 15844367 : 3447003,
          description,
          footer: { text: timestamp },
        });

        await appendSheetRow(sheets, SHEET, [
          timestamp,
          songTitle,
          artist,
          'iChart',
          record.count || '',
          short,
          '',
          '',
          '',
        ]);

        console.log(`Posted: ${songTitle} ${short}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.error(`Failed ${label}: ${e.message}`);
    }
  }

  console.log('iChart All Kill monitor complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
