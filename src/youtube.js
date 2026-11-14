'use strict';

const {
  getSheetsClient,
  getSheetData,
  getRegistryData,
  findRegistryRowByName,
  batchAppendRows,
  appendSheetRow,
  getMemberConfig,
  getComebackMode,
  getPHTTimestamp,
  buildClosingTags,
  formatMilestoneNumber
} = require('./helpers');

const fetch = require('node-fetch');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3/videos';
const MAX_IDS_PER_CALL = 50;

// ── Interval logic ────────────────────────────────────────────────────────────

function getMilestoneInterval(currentCount) {
  return currentCount >= 100000000 ? 5000000 : 10000000;
}

function getLastMilestone(currentCount, interval) {
  return Math.floor(currentCount / interval) * interval;
}

// ── YouTube API fetch (batch 50) ──────────────────────────────────────────────

async function fetchYouTubeStats(videoIds) {
  const key = process.env.YOUTUBE_API_KEY;
  const ids = videoIds.join(',');
  const url = `${YOUTUBE_API_BASE}?part=statistics&id=${ids}&key=${key}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`YouTube API error: ${response.status}`);

  const data = await response.json();
  const result = {};
  for (const item of (data.items || [])) {
    result[item.id] = {
      views: parseInt(item.statistics.viewCount || '0', 10),
      likes: parseInt(item.statistics.likeCount || '0', 10)
    };
  }
  return result;
}

// ── Extract video ID from URL ─────────────────────────────────────────────────

function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ── Format likes for display (round down to nearest 100) ─────────────────────

function formatLikesDisplay(likes) {
  if (likes >= 1000000) return Math.floor(likes / 100000) / 10 + 'M';
  if (likes >= 1000)    return Math.floor(likes / 100) * 100 / 1000 + 'K';
  return likes.toString();
}

// ── Resolve milestone label from Video Type ───────────────────────────────────

function getMilestoneLabel(videoType) {
  if ((videoType || '').trim().toLowerCase() === 'audio') return '[AUDIO MILESTONE] 🎵';
  return '[MV MILESTONE] 🔥';
}

// ── Milestone dedup ───────────────────────────────────────────────────────────

function isMilestoneLogged(existingMilestones, trackName, platform, milestoneValue, countType) {
  for (let i = 1; i < existingMilestones.length; i++) {
    if (
      existingMilestones[i][1] === trackName &&
      existingMilestones[i][3] === platform &&
      parseInt((existingMilestones[i][4] || '').toString().replace(/,/g, ''), 10) === milestoneValue &&
      existingMilestones[i][5] === countType
    ) return true;
  }
  return false;
}

function cacheMilestone(existingMilestones, trackName, album, platform, milestoneValue, countType, sourceUrl) {
  existingMilestones.push([
    '', trackName, album, platform, milestoneValue, countType, sourceUrl, '', ''
  ]);
}

async function persistMilestone(sheets, trackName, album, platform, milestoneValue, countType, sourceUrl) {
  await appendSheetRow(sheets, 'Milestones Achieved', [
    getPHTTimestamp(),
    trackName, album, platform, milestoneValue, countType, sourceUrl, '', ''
  ]);
}

// ── Build milestone Discord embed ─────────────────────────────────────────────
// URL 1 (official/main channel) only — URL 2 is distributor channels (1theK,
// Stone Entertainment etc.) that inflate view counts; removed from all paths.

function buildYouTubeMilestoneEmbed(config, trackName, views, likes, countType, sourceUrl, songHashtags, albumHashtags, videoType) {
  const closingTags    = buildClosingTags(config);
  const formattedViews = formatMilestoneNumber(views);
  const formattedLikes = formatLikesDisplay(likes);
  const milestoneLabel = getMilestoneLabel(videoType);

  let sentence;
  if (countType === 'Likes') {
    sentence = `${config.handle}'s "${trackName}" MV has surpassed ${formattedLikes} likes on YouTube!`;
  } else {
    // Views — URL 1 only, no distributor inflation
    sentence = `${config.handle}'s "${trackName}" MV has surpassed ${formattedViews} views on YouTube!`;
  }

  const tweetLines = [milestoneLabel, '', sentence, '', `📺 ${sourceUrl}`, ''];
  if (songHashtags)  tweetLines.push(songHashtags);
  if (albumHashtags) tweetLines.push(albumHashtags);
  if (config.tags)   tweetLines.push(config.tags);
  tweetLines.push(closingTags);

  return {
    embeds: [{
      title: '🎯 MILESTONE ALERT — Pending Approval',
      color: 16711680,
      description: tweetLines.join('\n').trim(),
      footer: { text: '✅ Approve and post manually to X | ❌ Discard' }
    }]
  };
}

// ── Send to Discord ───────────────────────────────────────────────────────────

async function sendToMilestoneWebhook(payload) {
  const webhookUrl = process.env.DISCORD_MILESTONE_WEBHOOK;
  const response = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
    console.log(`Rate limited. Waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
  } else if (!response.ok) {
    console.error(`Discord webhook error: ${response.status}`);
  }

  await new Promise(r => setTimeout(r, 2000));
}

// ── Process milestones (normal mode + non-comeback tracks) ────────────────────
// Always uses URL 1 views only. Combined views path removed.

async function processMilestones(sheets, existingMilestones, trackName, album, memberConfig, primaryUrl, primaryViews, primaryLikes, rawLogBuffer, songHashtags, albumHashtags, videoType, isComeback) {
  rawLogBuffer.push([
    getPHTTimestamp(), trackName, album, 'YouTube', 'Views',
    primaryViews, '', primaryUrl
  ]);

  // ── View milestone ────────────────────────────────────────────────────────
  const viewInterval  = getMilestoneInterval(primaryViews);
  const viewMilestone = getLastMilestone(primaryViews, viewInterval);
  let viewMilestoneFired = false;

  if (viewMilestone > 0) {
    if (!isMilestoneLogged(existingMilestones, trackName, 'YouTube', viewMilestone, 'Views')) {
      cacheMilestone(existingMilestones, trackName, album, 'YouTube', viewMilestone, 'Views', primaryUrl);
      await persistMilestone(sheets, trackName, album, 'YouTube', viewMilestone, 'Views', primaryUrl);
      const embed = buildYouTubeMilestoneEmbed(memberConfig, trackName, viewMilestone, primaryLikes, 'Views', primaryUrl, songHashtags, albumHashtags, videoType);
      await sendToMilestoneWebhook(embed);
      viewMilestoneFired = true;
      console.log(`View milestone: ${trackName} | ${viewMilestone}`);
    }
  }

  // ── Likes milestone ───────────────────────────────────────────────────────
  if (!viewMilestoneFired || isComeback) {
    const likeMilestone = getLastMilestone(primaryLikes, 100000);
    if (likeMilestone > 0) {
      if (!isMilestoneLogged(existingMilestones, trackName, 'YouTube', likeMilestone, 'Likes')) {
        cacheMilestone(existingMilestones, trackName, album, 'YouTube', likeMilestone, 'Likes', primaryUrl);
        await persistMilestone(sheets, trackName, album, 'YouTube', likeMilestone, 'Likes', primaryUrl);
        const embed = buildYouTubeMilestoneEmbed(memberConfig, trackName, primaryViews, likeMilestone, 'Likes', primaryUrl, songHashtags, albumHashtags, videoType);
        await sendToMilestoneWebhook(embed);
        console.log(`Likes milestone: ${trackName} | ${likeMilestone}`);
      }
    }
  }
}

// ── Fetch comeback config ─────────────────────────────────────────────────────

async function getComebackConfig(sheets) {
  const data = await getSheetData(sheets, 'Config');
  const cfg  = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) cfg[data[i][0]] = (data[i][1] || '').toString().trim();
  }
  return cfg;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting YouTube scraper...');

  const sheets     = await getSheetsClient();
  const isComeback = await getComebackMode(sheets);
  console.log(`Mode: ${isComeback ? 'COMEBACK' : 'NORMAL'}`);

  const registryData       = await getRegistryData(sheets);
  const existingMilestones = await getSheetData(sheets, 'Milestones Achieved');
  const rawLogBuffer       = [];

  const trackQueue = [];

  for (let i = 1; i < registryData.length; i++) {
    const row            = registryData[i];
    const trackName      = (row[0] || '').trim();
    const album          = row[2];
    const activeTracking = (row[11] || '').toString().trim().toLowerCase();

    if (activeTracking !== 'yes') continue;

    const videoType  = (row[14] || '').trim();
    const primaryUrl = (row[15] || '').trim();
    // URL 2 (row[16]) and URL 3 (row[17]) are distributor channels — not fetched

    if (!primaryUrl) continue;

    const primaryId = extractVideoId(primaryUrl);
    if (!primaryId) continue;

    trackQueue.push({
      row, trackName, album,
      videoType,
      primaryUrl, primaryId,
      memberConfig:  getMemberConfig(row),
      songHashtags:  (row[18] || '').trim(),
      albumHashtags: (row[19] || '').trim()
    });
  }

  console.log(`Tracks to process: ${trackQueue.length}`);

  // Batch fetch URL 1 IDs only
  const allIds = [...new Set(trackQueue.map(t => t.primaryId))];
  const statsMap = {};

  for (let i = 0; i < allIds.length; i += MAX_IDS_PER_CALL) {
    const batch = allIds.slice(i, i + MAX_IDS_PER_CALL);
    console.log(`Fetching YouTube batch ${Math.floor(i / MAX_IDS_PER_CALL) + 1}: ${batch.length} IDs`);
    const batchStats = await fetchYouTubeStats(batch);
    Object.assign(statsMap, batchStats);
    if (i + MAX_IDS_PER_CALL < allIds.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ── Comeback mode ─────────────────────────────────────────────────────────
  if (isComeback) {
    const cfg           = await getComebackConfig(sheets);
    const cbRow         = findRegistryRowByName(registryData, cfg['COMEBACK_TRACK']);
    const comebackTrack = cbRow ? cbRow[0] : (cfg['COMEBACK_TRACK'] || '');

    for (const track of trackQueue) {
      const primaryStats = statsMap[track.primaryId] || { views: 0, likes: 0 };

      if (track.trackName !== comebackTrack) {
        // Non-comeback tracks use normal 10M/5M intervals
        await processMilestones(sheets, existingMilestones, track.trackName, track.album, track.memberConfig, track.primaryUrl, primaryStats.views, primaryStats.likes, rawLogBuffer, track.songHashtags, track.albumHashtags, track.videoType, isComeback);
        continue;
      }

      // ── Comeback track: 1M intervals, URL 1 only ──────────────────────
      rawLogBuffer.push([
        getPHTTimestamp(), track.trackName, track.album, 'YouTube', 'Views',
        primaryStats.views, '', track.primaryUrl
      ]);

      const milestone1M = getLastMilestone(primaryStats.views, 1000000);
      let viewMilestoneFired = false;

      if (milestone1M > 0) {
        if (!isMilestoneLogged(existingMilestones, track.trackName, 'YouTube', milestone1M, 'Views')) {
          cacheMilestone(existingMilestones, track.trackName, track.album, 'YouTube', milestone1M, 'Views', track.primaryUrl);
          await persistMilestone(sheets, track.trackName, track.album, 'YouTube', milestone1M, 'Views', track.primaryUrl);
          const embed = buildYouTubeMilestoneEmbed(track.memberConfig, track.trackName, milestone1M, primaryStats.likes, 'Views', track.primaryUrl, track.songHashtags, track.albumHashtags, track.videoType);
          await sendToMilestoneWebhook(embed);
          viewMilestoneFired = true;
          console.log(`Comeback 1M milestone: ${track.trackName} | ${milestone1M}`);
        }
      }

      // Likes milestone — fires alongside view milestone in comeback mode
      const likeMilestone = getLastMilestone(primaryStats.likes, 100000);
      if (likeMilestone > 0) {
        if (!isMilestoneLogged(existingMilestones, track.trackName, 'YouTube', likeMilestone, 'Likes')) {
          cacheMilestone(existingMilestones, track.trackName, track.album, 'YouTube', likeMilestone, 'Likes', track.primaryUrl);
          await persistMilestone(sheets, track.trackName, track.album, 'YouTube', likeMilestone, 'Likes', track.primaryUrl);
          const embed = buildYouTubeMilestoneEmbed(track.memberConfig, track.trackName, primaryStats.views, likeMilestone, 'Likes', track.primaryUrl, track.songHashtags, track.albumHashtags, track.videoType);
          await sendToMilestoneWebhook(embed);
          console.log(`Likes milestone: ${track.trackName} | ${likeMilestone}`);
        }
      }
    }

  // ── Normal mode ───────────────────────────────────────────────────────────
  } else {
    for (const track of trackQueue) {
      const primaryStats = statsMap[track.primaryId] || { views: 0, likes: 0 };
      await processMilestones(sheets, existingMilestones, track.trackName, track.album, track.memberConfig, track.primaryUrl, primaryStats.views, primaryStats.likes, rawLogBuffer, track.songHashtags, track.albumHashtags, track.videoType, isComeback);
    }
  }

  console.log(`Writing ${rawLogBuffer.length} rows to Raw Scrape Log...`);
  await batchAppendRows(sheets, 'Raw Scrape Log', rawLogBuffer, 'A:H');

  console.log('YouTube scraper complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
