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
const commands = [
  new SlashCommandBuilder()
    .setName('joboffers')
    .setDescription('Get your CMR Dynasty job offers')
    .setDMPermission(false),

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
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(option =>
    option
      .setName('interval')
      .setDescription('Time until next advance')
      .setRequired(true)
      .addChoices(
        { name: '24 hours', value: '24' },
        { name: '48 hours', value: '48' }
      )
  ),
  new SlashCommandBuilder()
    .setName('season-advance')
    .setDescription('Advance to next season (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

 new SlashCommandBuilder()
  .setName('ranking')
  .setDescription('Show current season rankings (commissioner only)')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('ranking-all-time')
    .setDescription('Show all-time rankings across seasons (commissioner only)')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(opt => opt
      .setName('public')
      .setDescription('Post to #news-feed (default: private)')
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

  // Helper to respond safely (prevents double-respond errors)
  const safeRespond = async (choices) => {
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.respond(choices);
      }
    } catch (err) {
      if (err.code !== 40060 && err.code !== 10062) { // ignore already-acked or expired
        console.error('Autocomplete respond error:', err);
      }
    }
  };

  // Common min length check (skip query if too short)
  const search = (focused.value || '').toLowerCase().trim();
  if (search.length < 2) {
    await safeRespond([]);
    return;
  }

  // /game-result opponent
  if (focused.name === 'opponent') {
    try {
      console.log(`[autocomplete] Searching opponent for: "${search}"`);
      const { data: teamsData, error } = await supabase
        .from('teams')
        .select('name')
        .ilike('name', `%${search}%`)
        .limit(50);

      if (error) throw error;

      const list = (teamsData || []).map(r => r.name).sort((a, b) => a.localeCompare(b));

      await safeRespond(list.slice(0, 25).map(n => ({ name: n, value: n })));
      console.log(`[autocomplete] opponent found ${list.length} matches`);
    } catch (err) {
      console.error('Autocomplete /opponent error:', err);
      await safeRespond([]);
    }
    return;
  }

  // /move-coach coach
  if (focused.name === 'coach') {
    try {
      console.log(`[autocomplete] Searching coach for: "${search}"`);
      const { data: teamsData, error } = await supabase
        .from('teams')
        .select('taken_by_name')
        .not('taken_by', 'is', null)
        .ilike('taken_by_name', `%${search}%`)
        .limit(50);

      if (error) throw error;

      const coachList = (teamsData || []).map(r => r.taken_by_name).filter(Boolean);
      const uniqueCoaches = [...new Set(coachList)].sort((a, b) => a.localeCompare(b));

      await safeRespond(uniqueCoaches.slice(0, 25).map(n => ({ name: n, value: n })));
      console.log(`[autocomplete] coach found ${uniqueCoaches.length} unique matches`);
    } catch (err) {
      console.error('Autocomplete /coach error:', err);
      await safeRespond([]);
    }
    return;
  }

  // /move-coach new_team
  if (focused.name === 'new_team') {
    try {
      console.log(`[autocomplete] Searching new_team for: "${search}"`);
      const { data: teamsData, error } = await supabase
        .from('teams')
        .select('id, name, taken_by_name')
        .ilike('name', `%${search}%`)
        .limit(50);

      if (error) throw error;

      const list = (teamsData || []).map(t => {
        const status = t.taken_by_name ? ` (${t.taken_by_name})` : ' (available)';
        return { name: `${t.name}${status}`, value: t.id };
      }).sort((a, b) => a.name.localeCompare(b.name));

      await safeRespond(list.slice(0, 25));
      console.log(`[autocomplete] new_team found ${list.length} matches`);
    } catch (err) {
      console.error('Autocomplete /new_team error:', err);
      await safeRespond([]);
    }
    return;
  }

  // /any-game-result home_team & away_team
  if (focused.name === 'home_team' || focused.name === 'away_team') {
    try {
      console.log(`[autocomplete] Searching ${focused.name} for: "${search}"`);
      const { data: teamsData, error } = await supabase
        .from('teams')
        .select('name')
        .ilike('name', `%${search}%`)
        .limit(50);

      if (error) throw error;

      const list = (teamsData || []).map(r => r.name).sort((a, b) => a.localeCompare(b));

      await safeRespond(list.slice(0, 25).map(n => ({ name: n, value: n })));
      console.log(`[autocomplete] ${focused.name} found ${list.length} matches`);
    } catch (err) {
      console.error(`Autocomplete ${focused.name} error:`, err);
      await safeRespond([]);
    }
    return;
  }

  // Fallback: respond empty if no match
  await safeRespond([]);
}
  // ───────────────────────────────────────────────────────
  // 2. IMMEDIATELY defer ALL slash commands 
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
  // /game-result 
  // ───────────────────────────────────────────────
 if (name === 'game-result') {
  console.log('[game-result] Started for', interaction.user.tag);
  let opponentTeam = null;
  const opponentName = interaction.options.getString('opponent');
  const userScore = interaction.options.getInteger('your_score');
  const opponentScore = interaction.options.getInteger('opponent_score');
  const summary = interaction.options.getString('summary');
  try {
    console.log('[game-result] Fetching season & week...');
    const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();
    const weekResp = await supabase.from('meta').select('value').eq('key', 'current_week').maybeSingle();
    const currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
    const currentWeek = weekResp.data?.value != null ? Number(weekResp.data.value) : 0;
    console.log('[game-result] Fetching user team...');
    const { data: userTeam, error: userTeamErr } = await supabase
      .from('teams')
      .select('*')
      .eq('taken_by', interaction.user.id)
      .maybeSingle();
    if (userTeamErr) {
      console.error('[game-result] User team query error:', userTeamErr);
      return interaction.editReply({ content: `Error: ${userTeamErr.message}`, flags: 64 });
    }
    if (!userTeam) {
      return interaction.editReply({ content: "You don't control a team.", flags: 64 });
    }
    console.log('[game-result] Checking existing result...');
    const { data: existingUserResult } = await supabase
      .from('results')
      .select('*')
      .eq('season', currentSeason)
      .eq('week', currentWeek)
      .eq('user_team_id', userTeam.id)
      .maybeSingle();
    if (existingUserResult) {
      return interaction.editReply({
        content: `You already submitted a result this week (vs ${existingUserResult.opponent_team_name}). You can only submit one result per week.`,
        flags: 64
      });
    }
    console.log('[game-result] Looking up opponent team...');
    // Opponent lookup (your existing try/catch)
    try {
      const { data: teamsData, error: teamsErr } = await supabase.from('teams').select('*').limit(1000);
      if (teamsErr) throw teamsErr;
      const needle = (opponentName || '').toLowerCase().trim();
      if (teamsData && teamsData.length > 0) {
        opponentTeam = teamsData.find(t => (t.name || '').toLowerCase() === needle);
        if (!opponentTeam) opponentTeam = teamsData.find(t => (t.name || '').toLowerCase().includes(needle));
      }
    } catch (err) {
      console.error('[game-result] Opponent lookup error:', err);
      return interaction.editReply({ content: `Error looking up opponent: ${err.message}`, flags: 64 });
    }
    if (!opponentTeam) {
      return interaction.editReply({ content: `Opponent "${opponentName}" not found.`, flags: 64 });
    }
    console.log('[game-result] Opponent found:', opponentTeam.name);
    // Check if opponent already submitted this matchup (if user-controlled)
    const isOpponentUserControlled = opponentTeam.taken_by != null;
    if (isOpponentUserControlled) {
      const { data: existingOpponentResult } = await supabase
        .from('results')
        .select('*')
        .eq('season', currentSeason)
        .eq('week', currentWeek)
        .eq('user_team_id', opponentTeam.id)
        .eq('opponent_team_id', userTeam.id)
        .maybeSingle();

      if (existingOpponentResult) {
        return interaction.editReply({
          content: `${opponentTeam.name} already submitted this game result. Only the home team can enter the result.`,
          flags: 64
        });
      }
    }
    const resultText = userScore > opponentScore ? 'W' : 'L';
    console.log('[game-result] Inserting result...');
    const insertResp = await supabase.from('results').insert([{
      season: currentSeason,
      week: currentWeek,
      user_team_id: userTeam.id,
      user_team_name: userTeam.name,
      opponent_team_id: opponentTeam.id,
      opponent_team_name: opponentTeam.name,
      user_score: userScore,
      opponent_score: opponentScore,
      summary,
      result: resultText,
      taken_by: userTeam.taken_by,
      taken_by_name: userTeam.taken_by_name || interaction.user.username
    }]);
    if (insertResp.error) {
      console.error('[game-result] Insert error:', insertResp.error);
      return interaction.editReply({ content: `Failed to save result: ${insertResp.error.message}`, flags: 64 });
    }
    console.log('[game-result] Result inserted successfully');
    // ── UPDATE RECORDS ──
    const isOppControlled = !!opponentTeam.taken_by;

    // Submitting team (user's team)
    console.log('[game-result] Updating records for user team...');
    try {
      const { data: rec } = await supabase
        .from('records')
        .select('wins, losses, user_wins, user_losses')
        .eq('season', currentSeason)
        .eq('team_id', userTeam.id)
        .maybeSingle();

      const resultIsWin = userScore > opponentScore;

      await supabase.from('records').upsert({
        season: currentSeason,
        team_id: userTeam.id,
        team_name: userTeam.name,
        taken_by: userTeam.taken_by,
        taken_by_name: userTeam.taken_by_name || interaction.user.username,
        wins: (rec?.wins || 0) + (resultIsWin ? 1 : 0),
        losses: (rec?.losses || 0) + (!resultIsWin ? 1 : 0),
        user_wins: (rec?.user_wins || 0) + (isOppControlled && resultIsWin ? 1 : 0),
        user_losses: (rec?.user_losses || 0) + (isOppControlled && !resultIsWin ? 1 : 0)
      }, { onConflict: 'season,team_id' });

      console.log('[game-result] User team records upserted');
    } catch (e) {
      console.error('[game-result] Failed to update user team records:', e);
    }

    // Opponent team (if controlled)
    if (isOppControlled) {
      console.log('[game-result] Updating records for opponent...');
      try {
        const { data: oppRec } = await supabase
          .from('records')
          .select('wins, losses, user_wins, user_losses')
          .eq('season', currentSeason)
          .eq('team_id', opponentTeam.id)
          .maybeSingle();

        const oppWins = !resultIsWin;

        await supabase.from('records').upsert({
          season: currentSeason,
          team_id: opponentTeam.id,
          team_name: opponentTeam.name,
          taken_by: opponentTeam.taken_by,
          taken_by_name: opponentTeam.taken_by_name,
          wins: (oppRec?.wins || 0) + (oppWins ? 1 : 0),
          losses: (oppRec?.losses || 0) + (!oppWins ? 1 : 0),
          user_wins: (oppRec?.user_wins || 0) + (resultIsWin ? 1 : 0),
          user_losses: (oppRec?.user_losses || 0) + (!resultIsWin ? 1 : 0)
        }, { onConflict: 'season,team_id' });

        console.log('[game-result] Opponent records upserted');
      } catch (e) {
        console.error('[game-result] Failed to update opponent records:', e);
      }
    }   
// Post box score to news-feed
    console.log('[game-result] Posting to news-feed...');
    const guild = interaction.guild;
    if (guild) {
      const newsChannel = guild.channels.cache.find(c => c.name === 'news-feed' && c.isTextBased());
      if (newsChannel) {
        // Optional: fetch updated record for display
        const recordResp = await supabase
          .from('records')
          .select('wins, losses')
          .eq('season', currentSeason)
          .eq('team_id', userTeam.id)
          .maybeSingle();

        const wins = recordResp.data?.wins || 0;
        const losses = recordResp.data?.losses || 0;
        let recordText = `Record: ${userTeam.name} ${wins}-${losses}`;

        if (isOpponentUserControlled) {
          const oppRecordResp = await supabase
            .from('records')
            .select('wins, losses')
            .eq('season', currentSeason)
            .eq('team_id', opponentTeam.id)
            .maybeSingle();

          const oppWins = oppRecordResp.data?.wins || 0;
          const oppLosses = oppRecordResp.data?.losses || 0;
          recordText += `, ${opponentTeam.name} ${oppWins}-${oppLosses}`;
        }

        const boxScoreText = 
          `${userTeam.name.padEnd(20)} ${userScore}\n` +
          `${opponentTeam.name.padEnd(20)} ${opponentScore}\n` +
          `${recordText}\n` +
          `Summary: ${summary || 'No summary provided'}`;

        const resultEmbed = {
          title: `Game Result:
