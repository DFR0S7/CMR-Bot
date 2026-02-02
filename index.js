// index.js - fully updated for Supabase + Discord
require('dotenv').config();
const http = require('http');

// health server for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

// ---------------------------------------------------------
// SELF-PINGER (optional: keeps service warm on idle platforms)
// ---------------------------------------------------------
const httpGet = (url) => {
  return new Promise((resolve) => {
    try {
      const req = require('http').get(url, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.setTimeout(5000, () => { req.abort(); resolve({ error: 'timeout' }); });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
};

if (process.env.SELF_PING_URL) {
  setInterval(async () => {
    try {
      const r = await httpGet(process.env.SELF_PING_URL);
      if (r.error) console.debug('self-ping failed:', r.error);
      else console.debug('self-ping status:', r.status);
    } catch (e) {
      console.debug('self-ping exception:', e);
    }
  }, 4 * 60 * 1000); // every 4 minutes
  console.log('Self-pinger enabled for', process.env.SELF_PING_URL);
}

// ---------------------------------------------------------
// DISCORD + SUPABASE
// ---------------------------------------------------------

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  ChannelType,
  PermissionFlagsBits,
  Partials
} = require('discord.js');

const { createClient } = require('@supabase/supabase-js');

// Create Supabase client (make sure RENDER env vars are set)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [ Partials.Message, Partials.Channel, Partials.Reaction ]
});

const jobOfferUsed = new Set(); // soft-lock so users don't spam requests
if (!globalThis.jobOfferUsedGlobal) globalThis.jobOfferUsedGlobal = jobOfferUsed; // aid debugging across reloads

// ---------------------------------------------------------
// REGISTER GUILD (TESTING) COMMANDS
// ---------------------------------------------------------
// Note: only register in your testing guild to iterate quickly
const commands = [
  new SlashCommandBuilder()
    .setName('joboffers')
    .setDescription('Get your CMR Dynasty job offers')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('resetteam')
    .setDescription('Reset a user\'s team')
    .addStringOption(o => o.setName('userid').setDescription('The Discord user ID of the coach to reset').setRequired(true))
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('listteams')
    .setDescription('Post a list of taken and available teams')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('game-result')
    .setDescription('Submit a game result')
    .addStringOption(option => option.setName('opponent').setDescription('Opponent team').setRequired(true).setAutocomplete(true))
    .addIntegerOption(option => option.setName('your_score').setDescription('Your team score').setRequired(true))
    .addIntegerOption(option => option.setName('opponent_score').setDescription('Opponent score').setRequired(true))
    .addStringOption(option => option.setName('summary').setDescription('Game summary').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('press-release')
    .setDescription('Post a press release')
    .addStringOption(option => option.setName('text').setDescription('Text to post').setRequired(true))
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('advance')
    .setDescription('Advance to next week (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('season-advance')
    .setDescription('Advance to next season (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Show current season rankings (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(opt => opt
      .setName('public')
      .setDescription('Post to #general (default: private)')
      .setRequired(false)),

  new SlashCommandBuilder()
    .setName('ranking-all-time')
    .setDescription('Show all-time rankings across seasons (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(opt => opt
      .setName('public')
      .setDescription('Post to #general (default: private)')
      .setRequired(false)),

  new SlashCommandBuilder()
    .setName('move-coach')
    .setDescription('Move a coach to a new team (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt => opt
      .setName('coach')
      .setDescription('Select the coach to move')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption(opt => opt
      .setName('new_team')
      .setDescription('Select the new team')
      .setRequired(true)
      .setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('any-game-result')
    .setDescription('Enter a game result for any team (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('home_team').setDescription('Home team').setRequired(true).setAutocomplete(true))
    .addStringOption(option => option.setName('away_team').setDescription('Away team').setRequired(true).setAutocomplete(true))
    .addIntegerOption(option => option.setName('home_score').setDescription('Home team score').setRequired(true))
    .addIntegerOption(option => option.setName('away_score').setDescription('Away team score').setRequired(true))
    .addIntegerOption(option => option.setName('week').setDescription('Week number').setRequired(true))
    .addStringOption(option => option.setName('summary').setDescription('Game summary').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Clearing old global commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log("Registering guild commands...");
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log("Slash commands registered to guild.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

// ---------------------------------------------------------
// BOT READY
// ---------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Set up role-based permissions after bot is ready
  // If CLIENT_SECRET isn't provided we cannot obtain an OAuth2 application
  // bearer token required for the application permissions endpoint. In
  // that case skip automatic permission setup and ask the user to set
  // command permissions manually in the Discord UI.
  if (!process.env.CLIENT_SECRET) {
    console.log("Skipping automatic command-permission setup: no CLIENT_SECRET provided. Configure command permissions manually in your server settings if needed.");
    return;
  }

  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.warn("No guild found in cache. Skipping permission setup.");
      return;
    }

    const headCoachRole = guild.roles.cache.find(r => r.name === 'head coach');
    if (!headCoachRole) {
      console.warn("'head coach' role not found. Skipping permission setup.");
      return;
    }

    // Fetch all guild commands
    const guildCommands = await guild.commands.fetch();
    
    if (guildCommands.size === 0) {
      console.warn("No guild commands found.");
      return;
    }

    // Commands that should be visible to 'head coach' only
    const publicCommands = ['game-result', 'press-release'];

    for (const cmd of guildCommands.values()) {
      if (publicCommands.includes(cmd.name)) {
        // Set permissions using REST API (requires bot token, not OAuth2)
        try {
          await rest.put(
            Routes.applicationCommandPermissions(process.env.CLIENT_ID, process.env.GUILD_ID, cmd.id),
            {
              body: {
                permissions: [
                  {
                    id: headCoachRole.id,
                    type: 1, // ROLE
                    permission: true
                  },
                  {
                    id: guild.id, // @everyone
                    type: 1, // ROLE
                    permission: false
                  }
                ]
              }
            }
          );
          console.log(`✓ Set permissions for /${cmd.name}: head coach only`);
        } catch (permErr) {
          console.error(`Failed to set permissions for /${cmd.name}:`, permErr.message);
        }
      }
    }

    console.log("Command permissions configured.");
  } catch (err) {
    console.error("Failed to set command permissions:", err);
  }
});
// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

/**
 * Pick N random items from an array (non-destructive copy)
 */
function pickRandom(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Build a DM message grouped by conference for offers
 * offers: array of team rows from supabase
 */
function buildOffersGroupedByConference(offers) {
  // Group
  const map = {};
  for (const t of offers) {
    const conf = t.conference || 'Independent';
    if (!map[conf]) map[conf] = [];
    map[conf].push(t);
  }

  // Build string
  let out = '';
  for (const conf of Object.keys(map)) {
    out += `**${conf}**\n`;
    for (let i = 0; i < map[conf].length; i++) {
      const t = map[conf][i];
      out += `${i + 1}. ${t.name}\n`;
    }
    out += '\n';
  }
  return out.trim();
}

/**
 * Run the listteams display logic (posts to member-list channel)
 * Called both by /listteams command and by team claim/reset flows
 */
async function runListTeamsDisplay() {
  try {
    const { data: teamsData, error } = await supabase
      .from('teams')
      .select('*')
      .order('conference', { ascending: true })
      .limit(1000);

    if (error) throw error;

    console.log(`[listteams] Fetched ${teamsData?.length || 0} total teams`);

    const confMap = {};
    for (const t of teamsData || []) {
      const conf = t.conference || 'Independent';
      if (!confMap[conf]) confMap[conf] = [];
      confMap[conf].push(t);
    }

    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error('[listteams] No guild in cache');
      return false;
    }

    const channel = guild.channels.cache.find(c => c.name === 'team-lists' && c.isTextBased());
    if (!channel) {
      console.error('[listteams] team-lists channel not found');
      return false;
    }

    // Clean old bot messages
    try {
      const messages = await channel.messages.fetch({ limit: 100 });
      const botMessages = messages.filter(m => m.author.id === client.user.id);
      for (const m of botMessages.values()) {
        await m.delete().catch(() => {});
      }
      console.log(`[listteams] Deleted ${botMessages.size} old messages`);
    } catch (err) {
      console.error('[listteams] Error cleaning messages:', err);
    }

    let text = "";
    for (const [conf, tList] of Object.entries(confMap)) {
      const filtered = tList.filter(t => {
        const hasTakenBy = t.taken_by && t.taken_by.trim() !== '' && t.taken_by !== 'null';

        let isExactly25 = false;
        if (t.stars != null) {
          const starsNum = parseFloat(t.stars);
          isExactly25 = Math.abs(starsNum - 2.5) < 0.0001;
        }

        return isExactly25 || hasTakenBy;
      });

      console.log(`[listteams] ${conf}: ${tList.length} total → ${filtered.length} matched filter`);

      if (filtered.length === 0) continue;

      filtered.sort((a, b) => a.name.localeCompare(b.name));

      text += `\n__**${conf}**__\n`;
      for (const t of filtered) {
        if (t.taken_by) {
          text += `🏈 **${t.name}** — <@${t.taken_by}> (${t.taken_by_name || 'Coach'})\n`;
        } else {
          text += `🟢 **${t.name}** — Available (2.5★)\n`;
        }
      }
    }

    if (!text) text = "No 2.5★ teams or taken teams available at this time.";

    const embed = {
      title: "2.5★ Teams + All Taken Teams",
      description: text,
      color: 0x2b2d31,
      timestamp: new Date()
    };

    await channel.send({ embeds: [embed] });
    console.log('[listteams] Posted successfully');

    return true;
  } catch (err) {
    console.error("[listteams] Error:", err);
    return false;
  }
}

/**
 * Send job offers DM to user (used by slash and reaction flows)
 * returns the array of offered teams (objects) or throws.
 */
async function sendJobOffersToUser(user, count = 3) {
  // Query Supabase for teams with stars = 2.5 and not taken (assumes numeric column 'stars' and 'taken_by' col)
  const { data: available, error } = await supabase
    .from('teams')
    .select('*')
    .eq ('stars', 2.5)
    .is('taken_by', null);

  if (error) throw error;
  if (!available || available.length === 0) return [];

  const offers = pickRandom(available, count);

  // save into ephemeral in-memory map for DM accept flow
  if (!client.userOffers) client.userOffers = {};
  client.userOffers[user.id] = offers;

  // Build grouped message by conference
  // We want the numbered list per message; because we used pickRandom across conferences,
  // create a unified list with numbers 1..N but still show conferences headers.
  // To make numbering consistent with user's reply, flatten offers and show number prefix.
  let dmText = `Your CMR Dynasty job offers:\n\n`;
  // group for visual context
  const grouped = {};
  for (let idx = 0; idx < offers.length; idx++) {
    const t = offers[idx];
    const conf = t.conference || 'Independent';
    if (!grouped[conf]) grouped[conf] = [];
    grouped[conf].push({ number: idx + 1, team: t });
  }
  for (const conf of Object.keys(grouped)) {
    dmText += `**${conf}**\n`;
    for (const item of grouped[conf]) {
      dmText += `${item.number}️⃣ ${item.team.name}\n`;
    }
    dmText += `\n`;
  }
  dmText += `Reply with the number of the team you want to accept.`;

  await user.send(dmText);
  return offers;
}

// ---------------------------------------------------------
// AUTOCOMPLETE & COMMAND HANDLING
// ---------------------------------------------------------
client.on('interactionCreate', async interaction => {
  // ───────────────────────────────────────────────────────
  // 1. Handle autocomplete (no defer needed)
  // ───────────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);

    // /game-result opponent
    if (focused.name === 'opponent') {
      const search = (focused.value || '').toLowerCase();
      try {
        const { data: teamsData, error } = await supabase.from('teams').select('name').limit(200);
        if (error) throw error;
        const list = (teamsData || []).map(r => r.name).filter(n => n.toLowerCase().includes(search));
        list.sort((a, b) => a.localeCompare(b));
        await interaction.respond(list.slice(0, 25).map(n => ({ name: n, value: n })));
      } catch (err) {
        console.error('Autocomplete /opponent error:', err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    // /move-coach coach
    if (focused.name === 'coach') {
      const search = (focused.value || '').toLowerCase();
      try {
        const { data: teamsData, error } = await supabase
          .from('teams')
          .select('taken_by_name')
          .not('taken_by', 'is', null)
          .limit(200);
        if (error) throw error;
        const coachList = (teamsData || []).map(r => r.taken_by_name).filter(n => n && n.toLowerCase().includes(search));
        const uniqueCoaches = [...new Set(coachList)];
        uniqueCoaches.sort((a, b) => a.localeCompare(b));
        await interaction.respond(uniqueCoaches.slice(0, 25).map(n => ({ name: n, value: n })));
      } catch (err) {
        console.error('Autocomplete /coach error:', err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    // /move-coach new_team
    if (focused.name === 'new_team') {
      const search = (focused.value || '').toLowerCase();
      try {
        const { data: teamsData, error } = await supabase
          .from('teams')
          .select('id, name, taken_by_name')
          .limit(200);
        if (error) throw error;
        const list = (teamsData || []).filter(t => t.name.toLowerCase().includes(search)).map(t => {
          const status = t.taken_by_name ? ` (${t.taken_by_name})` : ' (available)';
          return { name: `${t.name}${status}`, value: t.id };
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        await interaction.respond(list.slice(0, 25));
      } catch (err) {
        console.error('Autocomplete /new_team error:', err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    // /any-game-result home_team & away_team
    if (focused.name === 'home_team' || focused.name === 'away_team') {
      const search = (focused.value || '').toLowerCase();
      try {
        const { data: teamsData, error } = await supabase.from('teams').select('name').limit(200);
        if (error) throw error;
        const list = (teamsData || []).map(r => r.name).filter(n => n.toLowerCase().includes(search));
        list.sort((a, b) => a.localeCompare(b));
        await interaction.respond(list.slice(0, 25).map(n => ({ name: n, value: n })));
      } catch (err) {
        console.error('Autocomplete any-game-result error:', err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    return;
  }

  // ───────────────────────────────────────────────────────
  // 2. IMMEDIATELY defer ALL slash commands (prevents 10062 timeout)
  // ───────────────────────────────────────────────────────
 if (interaction.isChatInputCommand()) {
    try {
      await interaction.deferReply(); // public by default (no flags needed unless ephemeral)
      console.log(`[DEFER SUCCESS] Deferred /${interaction.commandName} for ${interaction.user.tag}`);
    } catch (err) {
      console.error(`[DEFER FAILED] for /${interaction.commandName}:`, err);
      try {
        await interaction.reply({ content: "Sorry — I took too long. Try again!", flags: 64 });
      } catch {}
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  // ───────────────────────────────────────────────
  // /joboffers
  // ───────────────────────────────────────────────
  if (name === 'joboffers') {
    if (jobOfferUsed.has(interaction.user.id)) {
      return interaction.editReply({ content: "⛔ You already received a job offer.", flags: 64 });
    }
    jobOfferUsed.add(interaction.user.id);

    let offers;
    try {
      offers = await sendJobOffersToUser(interaction.user, 3);
    } catch (err) {
      jobOfferUsed.delete(interaction.user.id);
      return interaction.editReply({ content: `Error fetching offers: ${err.message}`, flags: 64 });
    }

    if (!offers || offers.length === 0) {
      jobOfferUsed.delete(interaction.user.id);
      return interaction.editReply({ content: "No teams available at the moment.", flags: 64 });
    }

    await interaction.editReply({ content: "Check your DMs for job offers!", flags: 64 });
    return;
  }

  // ───────────────────────────────────────────────
  // /resetteam
  // ───────────────────────────────────────────────
  if (name === 'resetteam') {
    const userId = interaction.options.getString('userid');

    if (!/^\d+$/.test(userId)) {
      return interaction.editReply('Invalid user ID. Please provide a valid Discord user ID (numbers only).');
    }

    const { data: teamData, error } = await supabase.from('teams').select('*').eq('taken_by', userId).limit(1).maybeSingle();
    if (error) {
      console.error("resetteam query error:", error);
      return interaction.editReply(`Error: ${error.message}`);
    }
    if (!teamData) {
      return interaction.editReply(`User ID ${userId} has no team.`);
    }

    await supabase.from('teams').update({ taken_by: null, taken_by_name: null }).eq('id', teamData.id);
    jobOfferUsed.delete(userId);

    const guild = client.guilds.cache.first();
    if (guild) {
      try {
        const teamChannelsCategory = guild.channels.cache.find(c => c.name === 'Team Channels' && c.type === ChannelType.GuildCategory);
        if (teamChannelsCategory) {
          const teamChannel = guild.channels.cache.find(
            c => c.name.toLowerCase() === teamData.name.toLowerCase().replace(/\s+/g, '-') && c.isTextBased() && c.parentId === teamChannelsCategory.id
          );
          if (teamChannel) {
            await teamChannel.delete("Team reset - removing team");
          }
        }
      } catch (err) {
        console.error(`Failed to delete channel for ${teamData.name}:`, err);
      }

      try {
        const member = await guild.members.fetch(userId);
        const headCoachRole = guild.roles.cache.find(r => r.name === 'head coach');
        if (headCoachRole && member) {
          await member.roles.remove(headCoachRole, "Team reset - removing coach role");
        }
      } catch (err) {
        console.log(`Could not remove Head Coach role from ${userId}:`, err.message);
      }
    }

    await runListTeamsDisplay();

    return interaction.editReply(`Reset team ${teamData.name}. Channel deleted and role removed.`);
  }

  // ───────────────────────────────────────────────
  // /listteams
  // ───────────────────────────────────────────────
  if (name === 'listteams') {
    try {
      const success = await runListTeamsDisplay();
      await interaction.editReply(
        success ? "Team list posted to #team-lists." : "Error posting team list."
      );
    } catch (err) {
      console.error('listteams error:', err);
      await interaction.editReply('An error occurred while listing teams.');
    }
    return;
  }

  // ───────────────────────────────────────────────
  // /game-result (example – add your full logic here)
  // ───────────────────────────────────────────────
  if (name === 'game-result') {
    // ... your full game-result code ...
    // At the end:
    await interaction.editReply({ content: `Result recorded: ${userTeam.name} vs ${opponentTeam.name}` });
    return;
  }

  // ───────────────────────────────────────────────
  // /any-game-result
  // ───────────────────────────────────────────────
  if (name === 'any-game-result') {
    // Commissioner check
    if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: "Only the commissioner can use this command.", flags: 64 });
    }

    // ... your full any-game-result logic ...
    // At the end:
    await interaction.editReply({
      content: `Result recorded for Week ${week}: ${homeTeam.name} ${homeScore} - ${awayTeam.name} ${awayScore}`
    });
    return;
  }

  // ───────────────────────────────────────────────
  // /press-release
  // ───────────────────────────────────────────────
  if (name === 'press-release') {
    const text = interaction.options.getString('text');
    const seasonResp = await supabase.from('meta').select('value').eq('key','current_season').maybeSingle();
    const weekResp = await supabase.from('meta').select('value').eq('key','current_week').maybeSingle();
    const season = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
    const week = weekResp.data?.value != null ? Number(weekResp.data.value) : 0;

    const insert = await supabase.from('news_feed').insert([{ season, week, text }]);
    if (insert.error) {
      return interaction.editReply({ content: `Error: ${insert.error.message}`, flags: 64 });
    }

    const guild = client.guilds.cache.first();
    if (guild) {
      const newsChannel = guild.channels.cache.find(c => c.name === 'news-feed' && c.isTextBased());
      if (newsChannel) {
        const embed = {
          title: `Press Release`,
          color: 0xffa500,
          description: text,
          timestamp: new Date()
        };
        await newsChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }

    await interaction.editReply({ content: "Press release posted." });
    return;
  }

  // ───────────────────────────────────────────────
  // /advance
  // ───────────────────────────────────────────────
  if (name === 'advance') {
  console.log('[advance] Started');

  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "Only the commissioner can advance the week.", flags: 64 });
  }

  try {
    console.log('[advance] Fetching week & season...');
    const weekResp = await supabase.from('meta').select('value').eq('key', 'current_week').maybeSingle();
    const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();

    const currentWeek = weekResp.data?.value != null ? Number(weekResp.data.value) : 0;
    const currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
    console.log('[advance] Current:', { week: currentWeek, season: currentSeason });

    console.log('[advance] Fetching press releases...');
    const { data: pressData } = await supabase
      .from('news_feed')
      .select('text')
      .eq('week', currentWeek)
      .eq('season', currentSeason);
    console.log('[advance] Press count:', pressData?.length || 0);

    console.log('[advance] Fetching weekly results...');
    const { data: weeklyResults } = await supabase
      .from('results')
      .select('*')
      .eq('season', currentSeason)
      .eq('week', currentWeek);
    console.log('[advance] Results count:', weeklyResults?.length || 0);

    // ... your embed building, channel sending, etc. logic here ...
    // (add console.log('[advance] Sending embeds...') before sends if you want)

    const newWeek = currentWeek + 1;
    console.log('[advance] Updating meta to week', newWeek);
    await supabase.from('meta').update({ value: newWeek }).eq('key', 'current_week');

    console.log('[advance] Sending final reply');
    await interaction.editReply(`Week advanced to **${newWeek}**. Summary posted.`);
  } catch (err) {
    console.error('[advance] Error:', err);
    await interaction.editReply({ content: `Error advancing week: ${err.message}`, flags: 64 });
  }
}
  // ───────────────────────────────────────────────
  // /season-advance
  // ───────────────────────────────────────────────
  if (name === 'season-advance') {
    if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: "Only the commissioner can advance the season.", flags: 64 });
    }

    const seasonResp = await supabase.from('meta').select('value').eq('key','current_season').maybeSingle();
    const currentSeason = seasonResp.data?.value ? Number(seasonResp.data.value) : 1;

    await supabase.from('meta').update({ value: currentSeason + 1 }).eq('key','current_season');
    await supabase.from('meta').update({ value: 0 }).eq('key','current_week');

    const guild = client.guilds.cache.first();
    if (guild) {
      const advanceChannel = guild.channels.cache.find(c => c.name === 'advance-tracker' && c.isTextBased());
      if (advanceChannel) {
        await advanceChannel.send(`We have advanced to Season ${currentSeason + 1}`).catch(() => {});
      }
    }

    await interaction.editReply({ content: `Season advanced to ${currentSeason + 1}, week reset to 0.` });
    return;
  }

    // ---------------------------
    // /ranking (current season)
    // ---------------------------
    if (name === 'ranking') {
    if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: "Only the commissioner can view rankings.", flags: 64 });
    }

    const isPublic = interaction.options.getBoolean('public') || false;

    try {
      const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();
      const currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
      
        // Fetch current users (only those with teams)
        const { data: currentUsers, error: usersErr } = await supabase.from('teams').select('taken_by').not('taken_by', 'is', null);
        if (usersErr) throw usersErr;
        const currentUserIds = new Set((currentUsers || []).map(u => u.taken_by));

        // Filter records to only include current users
        const filteredRecords = (records || []).filter(r => currentUserIds.has(r.taken_by));

        // Fetch all user vs user results for H2H tiebreaking
        const { data: results, error: resultsErr } = await supabase.from('results').select('*').eq('season', currentSeason);
        if (resultsErr) throw resultsErr;

        // Build map of H2H records: "userA_vs_userB" => wins for userA
        const h2hMap = {};
        if (results) {
          for (const r of results) {
            // Only count user vs user matches
            if (r.taken_by && r.opponent_team_id) {
              // Try to find opponent's taken_by from records
              const oppRecord = (records || []).find(rec => rec.team_id === r.opponent_team_id);
              if (oppRecord && oppRecord.taken_by) {
                const key = `${r.taken_by}_vs_${oppRecord.taken_by}`;
                if (!h2hMap[key]) h2hMap[key] = { wins: 0, losses: 0 };
                if (r.result === 'W') h2hMap[key].wins++;
                else h2hMap[key].losses++;
              }
            }
          }
        }

        // Helper to calculate H2H win% between two users
        const getH2HWinPct = (userAId, userBId) => {
          const key = `${userAId}_vs_${userBId}`;
          if (!h2hMap[key]) return 0;
          const { wins, losses } = h2hMap[key];
          return (wins + losses) > 0 ? wins / (wins + losses) : 0;
        };

        // Sort by: total wins (unless within 1 win, then win%), then user-vs-user win%, then H2H win%
        const sorted = filteredRecords.sort((a, b) => {
          // First: check if wins are within 1 of each other
          const winDiff = Math.abs(a.wins - b.wins);
          
          if (winDiff <= 1) {
            // Within 1 win: use win percentage as primary
            const aWinPct = (a.wins + a.losses) > 0 ? a.wins / (a.wins + a.losses) : 0;
            const bWinPct = (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) : 0;
            if (aWinPct !== bWinPct) return bWinPct - aWinPct;
          } else {
            // More than 1 win difference: use total wins
            return b.wins - a.wins;
          }

          // Third: user-vs-user win percentage (descending)
          const aUserPct = (a.user_wins + a.user_losses) > 0 ? a.user_wins / (a.user_wins + a.user_losses) : 0;
          const bUserPct = (b.user_wins + b.user_losses) > 0 ? b.user_wins / (b.user_wins + b.user_losses) : 0;
          if (aUserPct !== bUserPct) return bUserPct - aUserPct;

          // Fourth: H2H tiebreaker (between the two users)
          const aH2H = getH2HWinPct(a.taken_by, b.taken_by);
          const bH2H = getH2HWinPct(b.taken_by, a.taken_by);
          if (aH2H !== bH2H) return bH2H - aH2H;

          // Fallback: stability
          return 0;
        });

        // Build embed description (3 lines per team for mobile-friendly display)
        let description = '';
        for (let i = 0; i < sorted.length; i++) {
          const r = sorted[i];
          const rank = i + 1;
          const record = `${r.wins}-${r.losses}`;
          const userRecord = `${r.user_wins}-${r.user_losses}`;
          const displayName = r.taken_by_name || r.team_name;
          const teamName = r.team_name;
          
          // Format (3 lines per entry):
          // 1.  DisplayName
          //     Team Name
          //     10-2 (8-1)
          description += `${rank.toString().padStart(2, ' ')}.  ${displayName}\n`;
          description += `    ${teamName}\n`;
          description += `    ${record} (${userRecord})\n\n`;
        }

        if (!description) description = 'No user teams found.';
        else description += `*Record in parentheses is vs user teams only*`;

        const embed = {
          title: `🏆 CMR Dynasty Rankings – Season ${currentSeason}`,
          description: '```\n' + description + '\n```',
          color: 0xffd700,
          timestamp: new Date()
        };

        if (isPublic) {
        const generalChannel = interaction.guild.channels.cache.find(ch => ch.name === 'main-chat');
        if (generalChannel) {
          await generalChannel.send({ embeds: [embed] });
          return interaction.editReply({ content: 'Rankings posted to #general.' });
        }
      } else {
        return interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('ranking error:', err);
      await interaction.editReply(`Error generating rankings: ${err.message}`);
    }
    return;
  }

    // ---------------------------
    // /ranking-all-time
    // ---------------------------
    if (name === 'ranking-all-time') {
      if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.editReply({ flags: 64, content: "Only the commissioner can view rankings." });
      }

      const isPublic = interaction.options.getBoolean('public') || false;
      try {
        await interaction.deferReply({ flags: isPublic ? 0 : 64 }); // 64 = ephemeral
      } catch (err) {
        console.error("Failed to defer /ranking-all-time reply (interaction may have expired):", err);
        return;
      }

      try {
        // Fetch all records (all seasons) and aggregate by user
        const { data: allRecords, error: recordsErr } = await supabase.from('records').select('*');
        if (recordsErr) throw recordsErr;

        // Fetch all results (all seasons) for H2H
        const { data: results, error: resultsErr } = await supabase.from('results').select('*');
        if (resultsErr) throw resultsErr;

        // Build map of H2H records by user
        const h2hMap = {};
        if (results) {
          for (const r of results) {
            if (r.taken_by) {
              // Try to find opponent's taken_by from records
              const oppRecord = (allRecords || []).find(rec => rec.team_id === r.opponent_team_id);
              if (oppRecord && oppRecord.taken_by) {
                const key = `${r.taken_by}_vs_${oppRecord.taken_by}`;
                if (!h2hMap[key]) h2hMap[key] = { wins: 0, losses: 0 };
                if (r.result === 'W') h2hMap[key].wins++;
                else h2hMap[key].losses++;
              }
            }
          }
        }

        // Helper to calculate H2H win%
        const getH2HWinPct = (userAId, userBId) => {
          const key = `${userAId}_vs_${userBId}`;
          if (!h2hMap[key]) return 0;
          const { wins, losses } = h2hMap[key];
          return (wins + losses) > 0 ? wins / (wins + losses) : 0;
        };

        // Fetch current users (only those with teams) and their current team names
        const { data: currentUsers, error: usersErr } = await supabase.from('teams').select('taken_by, name').not('taken_by', 'is', null);
        if (usersErr) throw usersErr;
        const currentUserIds = new Set((currentUsers || []).map(u => u.taken_by));
        
        // Create a map of userId -> current team name
        const userTeamMap = {};
        if (currentUsers) {
          for (const u of currentUsers) {
            userTeamMap[u.taken_by] = u.name;
          }
        }

        // Aggregate records by user (sum across all seasons) - only for current users
        const userAggregates = {};
        if (allRecords) {
          for (const r of allRecords) {
            const userId = r.taken_by;
            // Only include users who currently have a team
            if (!currentUserIds.has(userId)) continue;
            
            if (!userAggregates[userId]) {
              userAggregates[userId] = {
                taken_by: userId,
                taken_by_name: r.taken_by_name || 'Unknown',
                team_name: userTeamMap[userId] || 'No Team',
                wins: 0,
                losses: 0,
                user_wins: 0,
                user_losses: 0
              };
            }
            userAggregates[userId].wins += r.wins;
            userAggregates[userId].losses += r.losses;
            userAggregates[userId].user_wins += r.user_wins;
            userAggregates[userId].user_losses += r.user_losses;
          }
        }

        // Sort by: total wins (unless within 1 win, then win%), then user-vs-user win%, then H2H
        const sorted = Object.values(userAggregates).sort((a, b) => {
          // First: check if wins are within 1 of each other
          const winDiff = Math.abs(a.wins - b.wins);
          
          if (winDiff <= 1) {
            // Within 1 win: use win percentage as primary
            const aWinPct = (a.wins + a.losses) > 0 ? a.wins / (a.wins + a.losses) : 0;
            const bWinPct = (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) : 0;
            if (aWinPct !== bWinPct) return bWinPct - aWinPct;
          } else {
            // More than 1 win difference: use total wins
            return b.wins - a.wins;
          }

          // Third: user-vs-user win percentage (descending)
          const aUserPct = (a.user_wins + a.user_losses) > 0 ? a.user_wins / (a.user_wins + a.user_losses) : 0;
          const bUserPct = (b.user_wins + b.user_losses) > 0 ? b.user_wins / (b.user_wins + b.user_losses) : 0;
          if (aUserPct !== bUserPct) return bUserPct - aUserPct;

          // Fourth: H2H tiebreaker
          const aH2H = getH2HWinPct(a.taken_by, b.taken_by);
          const bH2H = getH2HWinPct(b.taken_by, a.taken_by);
          if (aH2H !== bH2H) return bH2H - aH2H;

          return 0;
        });

        // Build embed (3 lines per user for mobile-friendly display)
        let description = '';
        for (let i = 0; i < sorted.length; i++) {
          const r = sorted[i];
          const rank = i + 1;
          const record = `${r.wins}-${r.losses}`;
          const userRecord = `${r.user_wins}-${r.user_losses}`;
          const displayName = r.taken_by_name || 'Unknown';
          const teamName = r.team_name || 'No Team';
          
          // Format (3 lines per entry):
          // 1.  DisplayName
          //     Team Name
          //     50-20 (45-15)
          description += `${rank.toString().padStart(2, ' ')}. ${displayName}\n`;
          description += `    ${teamName}\n`;
          description += `    ${record} (${userRecord})\n\n`;
        }

        if (!description) description = 'No user teams found.';
        else description += `*Record in parentheses is vs user teams only*`;

        const embed = {
          title: `👑 CMR Dynasty All-Time Rankings`,
          description: '```\n' + description + '\n```',
          color: 0xffd700,
          timestamp: new Date()
        };

        if (isPublic) {
          const generalChannel = interaction.guild.channels.cache.find(ch => ch.name === 'main-chat');
          if (generalChannel && generalChannel.isTextBased()) {
            await generalChannel.send({ embeds: [embed] });
            return interaction.editReply({ content: 'All-time rankings posted to #general.' });
          } else {
            return interaction.editReply({ content: 'Error: Could not find #general channel.' });
          }
        } else {
          return interaction.editReply({ embeds: [embed] });
        }
      } catch (err) {
        console.error('ranking-all-time command error:', err);
        return interaction.editReply(`Error generating all-time rankings: ${err.message}`);
      }
    }

    // ---------------------------
    // /move-coach
    // ---------------------------
    if (name === 'move-coach') {
    if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: "Only the commissioner can move coaches.", flags: 64 });
    }

    try {
      const coachName = interaction.options.getString('coach');
      const newTeamId = interaction.options.getString('new_team');

      const { data: coachTeams, error: coachErr } = await supabase
        .from('teams')
        .select('*')
        .eq('taken_by_name', coachName);
      if (coachErr) throw coachErr;
      if (!coachTeams || coachTeams.length === 0) {
        return interaction.editReply(`Coach "${coachName}" not found.`);
      }

      const oldTeam = coachTeams[0];
      const coachUserId = oldTeam.taken_by;

      const { data: newTeam, error: newTeamErr } = await supabase
        .from('teams')
        .select('*')
        .eq('id', newTeamId)
        .maybeSingle();
      if (newTeamErr) throw newTeamErr;
      if (!newTeam) {
        return interaction.editReply(`New team not found.`);
      }

      await supabase.from('teams').update({ taken_by: null, taken_by_name: null }).eq('id', oldTeam.id);
      await supabase.from('teams').update({ taken_by: coachUserId, taken_by_name: coachName }).eq('id', newTeamId);

      const guild = interaction.guild;
      if (guild) {
        const teamChannelCategory = guild.channels.cache.find(ch => ch.name === 'Team Channels' && ch.type === ChannelType.GuildCategory);
        if (teamChannelCategory) {
          const oldChannel = guild.channels.cache.find(
            ch => ch.parent?.id === teamChannelCategory.id && ch.name.toLowerCase() === oldTeam.name.toLowerCase()
          );
          if (oldChannel) {
            await oldChannel.setName(newTeam.name);
          }
        }
      }

      await interaction.editReply(
        `✅ Moved **${coachName}** from **${oldTeam.name}** to **${newTeam.name}**. Channel renamed.`
      );
    } catch (err) {
      console.error('move-coach error:', err);
      await interaction.editReply(`Error moving coach: ${err.message}`);
    }
    return;
  }

  // ───────────────────────────────────────────────
  // Catch-all for unhandled commands
  // ───────────────────────────────────────────────
  console.warn(`Unhandled command: /${name}`);
  await interaction.editReply({ content: "Command not implemented yet.", flags: 64 }).catch(() => {});
});
// ---------------------------------------------------------
// REACTION HANDLER (for rules reaction -> trigger job offers)
// ---------------------------------------------------------
// Behavior: when a user reacts with :saluting_face: in the "rules" channel, send them job offers
// Adjust channel name or message id if you prefer a different trigger
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    // only watch for :saluting_face: 
    if (reaction.emoji.name !== ':saluting_face:') return;

    // optionally restrict to a specific message ID or channel name
    // if you want to restrict to the rules channel, check:
    const channel = reaction.message.channel;
    // CHANGE 'rules' to the exact channel name you use for the rules message
    if (!channel || channel.name !== 'front-desk') return;

    // soft-lock
    if (jobOfferUsed.has(user.id)) {
      // optionally DM user about why they didn't get offers
      try { await user.send("⛔ You've already received your job offers."); } catch (e) {}
      return;
    }

    jobOfferUsed.add(user.id);

    try {
      const offers = await sendJobOffersToUser(user, 5);
      if (!offers || offers.length === 0) {
        jobOfferUsed.delete(user.id);
        try { await user.send("No teams available right now."); } catch (e) {}
      }
    } catch (err) {
      console.error("sendJobOffersToUser error:", err);
      jobOfferUsed.delete(user.id);
      try { await user.send(`Error fetching offers: ${err.message}`); } catch (e) {}
    }
  } catch (err) {
    console.error("messageReactionAdd handler error:", err);
  }
});

// ---------------------------------------------------------
// DM ACCEPT OFFER (user replies to bot DM with a number)
// ---------------------------------------------------------
client.on('messageCreate', async msg => {
  try {
    if (msg.guild || msg.author.bot) return;

    const userId = msg.author.id;
    if (!client.userOffers || !client.userOffers[userId]) return;

    const offers = client.userOffers[userId];
    const choice = parseInt(msg.content);
    if (isNaN(choice) || choice < 1 || choice > offers.length) {
      return msg.editReply("Reply with the number of the team you choose (from the DM list).");
    }

    const team = offers[choice - 1];

    // Write taken_by and taken_by_name into supabase teams table
    const updateResp = await supabase.from('teams').update({
      taken_by: userId,
      taken_by_name: msg.author.username
    }).eq('id', team.id);

    if (updateResp.error) {
      console.error("Failed to claim team:", updateResp.error);
      return msg.editReply(`Failed to claim ${team.name}: ${updateResp.error.message}`);
    }

    msg.editReply(`You accepted the job offer from **${team.name}**!`);
    delete client.userOffers[userId];

    // announce in general channel and perform setup
    const guild = client.guilds.cache.first();
    if (guild) {
      const general = guild.channels.cache.find(c => c.name === 'main-chat' && c.isTextBased());
      if (general) general.send(`🏈 <@${userId}> has accepted a job offer from **${team.name}**!`).catch(() => {});

      // Create team-specific channel (named after school name)
      try {
        const channelName = team.name.toLowerCase().replace(/\s+/g, '-');
        // Find or create the Team Channels category
        let teamChannelsCategory = guild.channels.cache.find(c => c.name === 'Team Channels' && c.type === ChannelType.GuildCategory);
        if (!teamChannelsCategory) {
          teamChannelsCategory = await guild.channels.create({
            name: 'Team Channels',
            type: ChannelType.GuildCategory
          });
        }
        const newChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: teamChannelsCategory.id,
          reason: `Team channel for ${team.name}`
        });
        console.log(`Created channel #${channelName} for ${team.name}`);

        // Send welcome message
        await newChannel.send(`Welcome to **${team.name}**! <@${userId}> is the Head Coach.`);
      } catch (err) {
        console.error(`Failed to create channel for ${team.name}:`, err);
      }

      // Assign Head Coach role to user
      try {
        const member = await guild.members.fetch(userId);
        let headCoachRole = guild.roles.cache.find(r => r.name === 'head coach');
        if (!headCoachRole) {
          headCoachRole = await guild.roles.create({
            name: 'head coach',
            reason: 'Role for team heads'
          });
        }
        await member.roles.add(headCoachRole, "Claimed team");
        console.log(`Assigned Head Coach role to ${msg.author.username}`);
      } catch (err) {
        console.error(`Failed to assign Head Coach role to ${msg.author.username}:`, err);
      }
    }

    // Trigger listteams update
    await runListTeamsDisplay();
  } catch (err) {
    console.error("DM accept offer error:", err);
    try { await msg.editReply("An error occurred processing your request."); } catch (e) {}
  }
});

// ---------------------------------------------------------
// START BOT
// ---------------------------------------------------------
// Global error handlers and graceful shutdown
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  try {
    if (client && client.destroy) await client.destroy();
  } catch (e) {
    console.error('Error during client.destroy() after uncaughtException:', e);
  }
  // Exit with failure - let the hosting platform restart the process
  process.exit(1);
});

client.on('error', (err) => console.error('Discord client error:', err));
client.on('warn', (info) => console.warn('Discord client warning:', info));
client.on('shardError', (error) => console.error('Discord client shardError:', error));

const _shutdown = async (signal) => {
  console.log(`Received ${signal} - shutting down gracefully...`);
  try {
    if (client && client.destroy) await client.destroy();
  } catch (e) {
    console.error('Error during client.destroy() in shutdown:', e);
  }
  // Give logs a moment to flush
  setTimeout(() => process.exit(0), 500);
};

process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT', () => _shutdown('SIGINT'));

client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error("Failed to login:", e);
});
