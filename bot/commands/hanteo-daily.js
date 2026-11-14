'use strict';
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hanteo-daily')
    .setDescription('Post Hanteo daily summary (run after midnight KST)')
    .addStringOption(o => o.setName('numbers').setDescription('Position,copies per day in order D1-D7 e.g. 2,24838,5,15897,0,24').setRequired(true))
    .addStringOption(o => o.setName('song_tags').setDescription('Song hashtags e.g. #Laundri_Is_Out_Now #Goodbyes_and_Sad_Eyes').setRequired(false)),

  async execute(interaction, sheets) {
    await interaction.deferReply({ ephemeral: true });

    const { getSheetData, getPHTTimestamp, appendSheetRow, updateSheetRow } = require('../../src/helpers');

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

    const artist   = cfg['COMEBACK_ARTIST'];
    const album    = cfg['COMEBACK_ALBUM'];

    if (!artist || !album) {
      await interaction.editReply({ content: '❌ COMEBACK_ARTIST or COMEBACK_ALBUM not set in Config.' });
      return;
    }

    // Calculate current day
    const rawDate = cfg['COMEBACK_RELEASE_DATE'].toString().trim();
    let release;
    if (rawDate.includes('/')) {
      const [m, d, y] = rawDate.split('/');
      release = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
    } else {
      const cleaned = rawDate.replace(/-/g, '');
      release = new Date(`${cleaned.slice(0,4)}-${cleaned.slice(4,6)}-${cleaned.slice(6,8)}`);
    }
    const now    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const curDay = Math.floor((now - release) / 86400000) + 1;

    if (isNaN(curDay) || curDay < 1) {
      await interaction.editReply({ content: '❌ Could not calculate current day from COMEBACK_RELEASE_DATE.' });
      return;
    }

    // Parse numbers — position,copies per day
    const numbersRaw = interaction.options.getString('numbers');
    const parts      = numbersRaw.split(',').map(p => p.trim());

    // Must be pairs — up to 7 days
    if (parts.length % 2 !== 0 || parts.length < 2) {
      await interaction.editReply({ content: '❌ Expected position,copies pairs e.g. 2,24838,5,15897' });
      return;
    }

    const days = [];
    let total  = 0;
    let parseError = false;

    for (let i = 0; i < parts.length; i += 2) {
      const pos    = parts[i];
      const copies = parseInt(parts[i + 1].replace(/,/g, ''), 10);
      if (isNaN(copies)) { parseError = true; break; }
      total += copies;
      days.push({ dayNum: Math.floor(i / 2) + 1, pos: pos === '0' || pos === '-' ? '#-' : `#${pos}`, copies });
    }

    if (parseError || days.length === 0) {
      await interaction.editReply({ content: '❌ Could not parse numbers. Format: position,copies,position,copies,...' });
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
    const tag      = memberTags[artist] || { tags: '#MAMAMOO #마마무', label: '@RBW_MAMAMOO' };
    const songTags = interaction.options.getString('song_tags') || '';

    const dayLines = days.map(d =>
      `D${d.dayNum} — ${d.pos} | ${d.copies.toLocaleString('en-US')} copies`
    ).join('\n');

    const postLines = [
      `Hanteo Daily — #${artist} '${album}'`,
      ``,
      dayLines,
      ``,
      `Total : ${total.toLocaleString('en-US')} copies`,
      ``,
    ];
    if (songTags) postLines.push(songTags, ``);
    postLines.push(tag.tags, tag.label);

    const post = postLines.join('\n');

    // Send to channel
    const channel = await interaction.client.channels.fetch(process.env.DISCORD_HANTEO_CHANNEL_ID);
    await channel.send(post);

    // Log to sheet
    const today = getPHTTimestamp().split(' ')[0].replace(/-/g, '');
    for (const d of days) {
      await appendSheetRow(sheets, 'Hanteo Tracker', [
        today,
        artist,
        album,
        `D${d.dayNum}`,
        'Daily Total',
        d.pos,
        d.copies,
        total,
        'Daily',
      ]);
    }

    await appendSheetRow(sheets, 'Physical Sales Log', [
      new Date().toLocaleString('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', ''),
      album,
      'Hanteo Daily',
      total,
      '',
    ]);

    // ── Update Hanteo Album Totals ────────────────────────────────────────
    // Previously only hanteo-hourly.js did this, so Album Totals (and the
    // 50K full-breakdown post, which reads from it) went stale on any day
    // where only /hanteo-daily was run.
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
    // Previously missing entirely from this command — a 10K/50K crossing
    // could be missed on any day staff only ran /hanteo-daily.
    // `total` here is already cumulative (sum of D1...Dn daily figures),
    // dedup against Milestones Achieved prevents double-posting if
    // /hanteo-hourly already caught the same threshold earlier that day.
    const { checkAndPostHanteoMilestones } = require('../../src/physical-sales');
    await checkAndPostHanteoMilestones(sheets, artist, album, total, tag);

    await interaction.editReply({ content: '✅ Daily summary posted and logged.' });
  },
};
