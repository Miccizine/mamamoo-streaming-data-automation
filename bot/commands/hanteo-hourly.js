'use strict';
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hanteo-hourly')
    .setDescription('Log Hanteo real-time chart snapshot')
    .addStringOption(o => o.setName('timestamp').setDescription('Time only e.g. 1920 KST').setRequired(true))
    .addStringOption(o => o.setName('numbers').setDescription('Rank,copies,delta per version e.g. 4,22876,+633,9,12180,+69').setRequired(true))
    .addStringOption(o => o.setName('song_tags').setDescription('Song/trending hashtags e.g. #Laundri_Is_Out_Now').setRequired(false)),

  async execute(interaction, sheets) {
    await interaction.deferReply({ ephemeral: true });

    const { getSheetData } = require('../../src/helpers');

    // Read Config
    const configData = await getSheetData(sheets, 'Config');
    const cfg = {};
    for (const row of configData) cfg[row[0]] = row[1] || '';

    if (cfg['COMEBACK_MODE'] !== 'ON') {
      await interaction.editReply({ content: '❌ Comeback mode is not active.' });
      return;
    }

    if ((cfg['COMEBACK_HANTEO_TRACKER'] || '').toUpperCase() !== 'ON') {
      await interaction.editReply({ content: '❌ Hanteo tracker is OFF. Enable COMEBACK_HANTEO_TRACKER in Config.' });
      return;
    }

    if (!cfg['COMEBACK_RELEASE_DATE']) {
      await interaction.editReply({ content: '❌ COMEBACK_RELEASE_DATE not set in Config.' });
      return;
    }

    const artist    = cfg['COMEBACK_ARTIST'];
    const album     = cfg['COMEBACK_ALBUM'];
    const versNames = (cfg['COMEBACK_VERSIONS'] || '').split(',').map(v => v.trim()).filter(Boolean);

    if (!artist || !album || versNames.length === 0) {
      await interaction.editReply({ content: '❌ COMEBACK_ARTIST, COMEBACK_ALBUM, or COMEBACK_VERSIONS not set in Config.' });
      return;
    }

    const rawDate = cfg['COMEBACK_RELEASE_DATE'].toString().trim();
    let release;
    if (rawDate.includes('/')) {
      // M/D/YYYY or MM/DD/YYYY — Google Sheets auto-format
      const [m, d, y] = rawDate.split('/');
      release = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    } else if (rawDate.match(/^\d{2}-\d{2}-\d{4}$/)) {
      // MM-DD-YYYY
      const [m, d, y] = rawDate.split('-');
      release = new Date(`${y}-${m}-${d}`);
    } else {
      // YYYYMMDD or YYYY-MM-DD
      const cleaned = rawDate.replace(/-/g, '');
      release = new Date(`${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`);
    }

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const day = Math.floor((now - release) / 86400000) + 1;

    if (isNaN(day)) {
      await interaction.editReply({ content: '❌ Could not calculate day — check COMEBACK_RELEASE_DATE format in Config (expected YYYYMMDD or YYYY-MM-DD).' });
      return;
    }

    if (day < 1 || day > 7) {
      await interaction.editReply({ content: '❌ Today is not within the D1-D7 sales window.' });
      return;
    }

    const timeInput  = interaction.options.getString('timestamp');
    const kstDate    = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).replace(/-/g, '').slice(2); // YYMMDD
    const timestamp  = `${kstDate} — ${timeInput}`;
    const numbersRaw = interaction.options.getString('numbers');
    const songTags   = interaction.options.getString('song_tags') || '';

    const parts = numbersRaw.split(',').map(p => p.trim());
    if (parts.length !== versNames.length * 3) {
      await interaction.editReply({ content: `❌ Expected ${versNames.length * 3} values (rank,copies,delta per version), got ${parts.length}.` });
      return;
    }

    const versions = [];
    let total = 0;
    let parseError = false;

    for (let i = 0; i < versNames.length; i++) {
      const rank   = parts[i * 3];
      const copies = parseInt(parts[i * 3 + 1].replace(/,/g, ''), 10);
      const delta  = parts[i * 3 + 2];
      if (isNaN(copies)) { parseError = true; break; }
      total += copies;
      versions.push({ name: versNames[i], rank: rank === '-' ? '#-' : `#${rank}`, copies, delta });
    }

    if (parseError || versions.length === 0) {
      await interaction.editReply({ content: '❌ Could not parse numbers. Format: rank,copies,delta,rank,copies,delta,...' });
      return;
    }

    // Build post
    const memberTags = {
      MAMAMOO:  { tags: '#MAMAMOO #마마무', label: '@RBW_MAMAMOO' },
      Solar:    { tags: '#SOLAR #솔라',     label: '@RBW_MAMAMOO' },
      Moonbyul: { tags: '#MOONBYUL #문별',  label: '@RBW_MAMAMOO' },
      Wheein:   { tags: '#WHEEIN #휘인',    label: '@WheeIn_0fficial' },
      Hwasa:    { tags: '#HWASA #화사',     label: '@OfficialPnation' },
    };
    const tag = memberTags[artist] || { tags: '#MAMAMOO #마마무', label: '@RBW_MAMAMOO' };

    const versionLines = versions.map(v => {
      const deltaStr = v.delta && v.delta !== '0' ? ` (${v.delta})` : '';
      return `${v.rank} ${v.name} — ${v.copies.toLocaleString('en-US')} copies${deltaStr}`;
    }).join('\n');

    const totalDelta = versions.reduce((sum, v) => {
      const n = parseInt((v.delta || '0').replace('+', ''), 10);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
    const totalDeltaStr = totalDelta > 0
      ? ` (+${totalDelta.toLocaleString('en-US')})`
      : totalDelta < 0
        ? ` (${totalDelta.toLocaleString('en-US')})`
        : '';

    const postLines = [
      `Hanteo Chart (${timestamp})`,
      ``,
      versionLines,
      ``,
      `Total — ${total.toLocaleString('en-US')} copies${totalDeltaStr}`,
      ``,
    ];
    if (songTags) postLines.push(songTags, ``);
    postLines.push(tag.tags, tag.label);
    const post = postLines.join('\n');

    // Send to Hanteo channel
    const channel = await interaction.client.channels.fetch(process.env.DISCORD_HANTEO_CHANNEL_ID);
    await channel.send(post);

    // Log to sheet
    const { getPHTTimestamp, appendSheetRow, updateSheetRow } = require('../../src/helpers');
    const today = getPHTTimestamp().split(' ')[0].replace(/-/g, '');

    for (const v of versions) {
      await appendSheetRow(sheets, 'Hanteo Tracker', [
        today,
        artist,
        album,
        `D${day}`,
        v.name,
        v.rank,
        v.copies,
        total,
        timestamp,
      ]);
    }

    // Log cumulative to Physical Sales Log
    await appendSheetRow(sheets, 'Physical Sales Log', [
      new Date().toLocaleString('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).replace(',', ''),
      album,
      'Hanteo',
      total,
      '',
    ]);

    // ── Update Hanteo Album Totals ────────────────────────────────────────
    const albumTotals = await getSheetData(sheets, 'Hanteo Album Totals');
    const albumRowIdx = albumTotals.findIndex((r, i) => i > 0 &&
      (r[0] || '').toLowerCase() === artist.toLowerCase() &&
      (r[1] || '').toLowerCase() === album.toLowerCase()
    );

    if (albumRowIdx > -1) {
      const existingRow = albumTotals[albumRowIdx];
      const updatedRow  = [...existingRow];
      updatedRow[2] = total;
      updatedRow[3] = 'yes';
      await updateSheetRow(sheets, 'Hanteo Album Totals', albumRowIdx + 1, updatedRow);
    } else {
      await appendSheetRow(sheets, 'Hanteo Album Totals', [artist, album, total, 'yes']);
    }

    // ── Milestone detection ───────────────────────────────────────────────
    // `total` (computed above) is already the correct cumulative figure —
    // each Hanteo snapshot reports cumulative copies per version, so summing
    // versions gives the true running total. Previously this block re-summed
    // every past row in Physical Sales Log, which double/triple-counted the
    // same cumulative number on every repeat run. Fixed by passing `total`
    // straight through to the shared checker.
    const { checkAndPostHanteoMilestones } = require('../../src/physical-sales');
    await checkAndPostHanteoMilestones(sheets, artist, album, total, tag);

    await interaction.editReply({ content: '✅ Posted and logged.' });
  },
};
