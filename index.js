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

  let opponentTeam = null; // Declare early so it's always defined

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
          title: `Game Result: ${userTeam.name} vs ${opponentTeam.name}`,
          color: resultText === 'W' ? 0x00ff00 : 0xff0000,
          description: boxScoreText,
          timestamp: new Date()
        };

        await newsChannel.send({ embeds: [resultEmbed] }).catch(e => {
          console.error('[game-result] News-feed post failed:', e);
        });
      } else {
        console.warn('[game-result] news-feed channel not found');
      }
    }

    // Final reply to user
    await interaction.editReply({ content: `Result recorded and posted to #news-feed: ${userTeam.name} vs ${opponentTeam.name}` });
  } catch (err) {
    console.error('[game-result] Top-level error:', err);
    await interaction.editReply({ content: `Error processing game result: ${err.message}`, flags: 64 });
  }

  return;
}

// ───────────────────────────────────────────────
// /any-game-result (commissioner only)
// ───────────────────────────────────────────────
if (name === 'any-game-result') {
  console.log('[any-game-result] Started');

  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "Only the commissioner can use this command.", flags: 64 });
  }

  const homeTeamName = interaction.options.getString('home_team');
  const awayTeamName = interaction.options.getString('away_team');
  const homeScore = interaction.options.getInteger('home_score');
  const awayScore = interaction.options.getInteger('away_score');
  const week = interaction.options.getInteger('week');
  const summary = interaction.options.getString('summary');

  try {
    console.log('[any-game-result] Looking up teams...');

    const { data: allTeams } = await supabase.from('teams').select('*').limit(1000);

    // Find home team (case-insensitive, partial match)
    let homeTeam = allTeams.find(t => t.name.toLowerCase() === homeTeamName.toLowerCase().trim());
    if (!homeTeam) homeTeam = allTeams.find(t => t.name.toLowerCase().includes(homeTeamName.toLowerCase().trim()));

    // Find away team
    let awayTeam = allTeams.find(t => t.name.toLowerCase() === awayTeamName.toLowerCase().trim());
    if (!awayTeam) awayTeam = allTeams.find(t => t.name.toLowerCase().includes(awayTeamName.toLowerCase().trim()));

    if (!homeTeam) return interaction.editReply({ content: `Home team "${homeTeamName}" not found.`, flags: 64 });
    if (!awayTeam) return interaction.editReply({ content: `Away team "${awayTeamName}" not found.`, flags: 64 });

    const homeResult = homeScore > awayScore ? 'W' : 'L';
    const awayResult = homeScore > awayScore ? 'L' : 'W';

    const isHomeUserControlled = !!homeTeam.taken_by;
    const isAwayUserControlled = !!awayTeam.taken_by;

    console.log('[any-game-result] Inserting result...');
    const insert = await supabase.from('results').insert([{
      season: 1,                    // ← change if you support multiple seasons
      week: week,
      user_team_id: homeTeam.id,
      user_team_name: homeTeam.name,
      opponent_team_id: awayTeam.id,
      opponent_team_name: awayTeam.name,
      user_score: homeScore,
      opponent_score: awayScore,
      summary,
      result: homeResult,
      taken_by: homeTeam.taken_by,
      taken_by_name: homeTeam.taken_by_name
    }]);

    if (insert.error) throw insert.error;

    // Update records for home team
    if (isHomeUserControlled) {
      const { data: existing } = await supabase
        .from('records')
        .select('*')
        .eq('season', 1)
        .eq('team_id', homeTeam.id)
        .maybeSingle();

      await supabase.from('records').upsert({
        season: 1,
        team_id: homeTeam.id,
        team_name: homeTeam.name,
        taken_by: homeTeam.taken_by,
        taken_by_name: homeTeam.taken_by_name,
        wins: (existing?.wins || 0) + (homeResult === 'W' ? 1 : 0),
        losses: (existing?.losses || 0) + (homeResult === 'L' ? 1 : 0),
        user_wins: (existing?.user_wins || 0) + (isAwayUserControlled && homeResult === 'W' ? 1 : 0),
        user_losses: (existing?.user_losses || 0) + (isAwayUserControlled && homeResult === 'L' ? 1 : 0)
      }, { onConflict: 'season,team_id' });
    }

    // Update records for away team
    if (isAwayUserControlled) {
      const { data: existing } = await supabase
        .from('records')
        .select('*')
        .eq('season', 1)
        .eq('team_id', awayTeam.id)
        .maybeSingle();

      await supabase.from('records').upsert({
        season: 1,
        team_id: awayTeam.id,
        team_name: awayTeam.name,
        taken_by: awayTeam.taken_by,
        taken_by_name: awayTeam.taken_by_name,
        wins: (existing?.wins || 0) + (awayResult === 'W' ? 1 : 0),
        losses: (existing?.losses || 0) + (awayResult === 'L' ? 1 : 0),
        user_wins: (existing?.user_wins || 0) + (isHomeUserControlled && awayResult === 'W' ? 1 : 0),
        user_losses: (existing?.user_losses || 0) + (isHomeUserControlled && awayResult === 'L' ? 1 : 0)
      }, { onConflict: 'season,team_id' });
    }

    // Optional: Post box score to #news-feed
    const guild = interaction.guild;
    if (guild) {
      const newsChannel = guild.channels.cache.find(c => c.name === 'news-feed' && c.isTextBased());
      if (newsChannel) {
        const embed = {
          title: `Manually Entered Result: ${homeTeam.name} vs ${awayTeam.name}`,
          color: homeResult === 'W' ? 0x00ff00 : 0xff0000,
          description: `${homeTeam.name} ${homeScore} - ${awayTeam.name} ${awayScore}\nSummary: ${summary || 'No summary'}`,
          timestamp: new Date()
        };
        await newsChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }

    await interaction.editReply(`✅ Game result entered for Week ${week}: ${homeTeam.name} ${homeScore} - ${awayTeam.name} ${awayScore}`);
  } catch (err) {
    console.error('[any-game-result] Error:', err);
    await interaction.editReply({ content: `Error entering result: ${err.message}`, flags: 64 });
  }

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
  console.log('[advance] Started for', interaction.user.tag);

  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "Only the commissioner can advance the week.", flags: 64 });
  }

  const intervalHours = parseInt(interaction.options.getString('interval'), 10);
  if (![24, 48].includes(intervalHours)) {
    return interaction.editReply({ content: "Interval must be 24 or 48 hours.", flags: 64 });
  }

  // Calculate next advance time in CST
  const now = new Date();
  const nextAdvance = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
  const nextAdvanceFormatted = nextAdvance.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Chicago',
    timeZoneName: 'short'
  });

  const nextAdvanceMessage = `Next advance expected in ${intervalHours} hours: **${nextAdvanceFormatted}**`;

  try {
    console.log('[advance] Fetching current week & season...');
    const weekResp = await supabase.from('meta').select('value').eq('key', 'current_week').maybeSingle();
    const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();

    let currentWeek = weekResp.data?.value != null ? Number(weekResp.data.value) : 0;
    const currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
    console.log('[advance] Current:', { week: currentWeek, season: currentSeason });

    const newWeek = currentWeek + 1;
    console.log('[advance] Advancing to week', newWeek);

    const updateResp = await supabase
      .from('meta')
      .update({ value: newWeek })
      .eq('key', 'current_week')
      .select();

    if (updateResp.error) throw updateResp.error;

    const updatedWeek = Number(updateResp.data?.[0]?.value);
    console.log('[advance] DB update result:', { updatedWeek });

    if (updatedWeek !== newWeek) {
      console.warn('[advance] Update mismatch - expected', newWeek, 'got', updatedWeek);
    }

    console.log('[advance] Building summary for completed week', currentWeek);
    const { data: pressData } = await supabase
      .from('news_feed')
      .select('text')
      .eq('week', currentWeek)
      .eq('season', currentSeason);

    const { data: weeklyResults } = await supabase
      .from('results')
      .select('*')
      .eq('season', currentSeason)
      .eq('week', currentWeek);

    const embed = {
      title: `Weekly Summary – Season ${currentSeason}, Week ${currentWeek}`,
      color: 0x1e90ff,
      description: '',
      timestamp: new Date()
    };

    let descriptionParts = [];

    if (pressData?.length > 0) {
      descriptionParts.push('**Press Releases:**\n' + pressData.map(p => `• ${p.text}`).join('\n'));
    }

    if (weeklyResults?.length > 0) {
      descriptionParts.push('**Game Results:**\n' + weeklyResults.map(r => {
        return `${r.user_team_name} ${r.user_score || '?'} - ${r.opponent_team_name} ${r.opponent_score || '?'}\nSummary: ${r.summary || 'No summary'}`;
      }).join('\n\n'));
    }

    embed.description = descriptionParts.length > 0 ? descriptionParts.join('\n\n') : 'No news or results this week.';

    console.log('[advance] Sending embeds to channels...');
    const guild = interaction.guild;
    if (guild) {
      const newsChannel = guild.channels.cache.find(c => c.name === 'news-feed' && c.isTextBased());
      if (newsChannel) {
        await newsChannel.send({ embeds: [embed] }).catch(e => console.error('news send failed:', e));
      }

     const advanceChannel = guild.channels.cache.find(c => c.name === 'advance-tracker' && c.isTextBased());
      if (advanceChannel) {
        const headCoachRoleId = '1463949316702994496'; // your role ID
        await advanceChannel.send(
          `<@&${headCoachRoleId}> We have advanced to Week ${newWeek}\n${nextAdvanceMessage}`
        ).catch(e => console.error('advance send failed:', e));
      }
    }

    await interaction.editReply(`Week advanced to **${newWeek}** & Summary posted to channels.`);
  } catch (err) {
    console.error('[advance] Error:', err);
    await interaction.editReply({ content: `Error advancing week: ${err.message}`, flags: 64 });
  }

  return;
}  
  // ───────────────────────────────────────────────
  // /season-advance
  // ───────────────────────────────────────────────
  if (name === 'season-advance') {
  console.log('[season-advance] Started');

  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "Only the commissioner can advance the season.", flags: 64 });
  }

  try {
    console.log('[season-advance] Fetching current season...');
    const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();
    let currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
    console.log('[season-advance] Current season:', currentSeason);

    const newSeason = currentSeason + 1;
    console.log('[season-advance] Advancing to season', newSeason);

    // Update season
    const seasonUpdate = await supabase
      .from('meta')
      .update({ value: newSeason })
      .eq('key', 'current_season');
    if (seasonUpdate.error) throw seasonUpdate.error;

    // Reset week to 0
    const weekUpdate = await supabase
      .from('meta')
      .update({ value: 0 })
      .eq('key', 'current_week');
    if (weekUpdate.error) throw weekUpdate.error;

    console.log('[season-advance] DB updates successful');

    // Announce
    const guild = interaction.guild;
    if (guild) {
      const advanceChannel = guild.channels.cache.find(c => c.name === 'advance-tracker' && c.isTextBased());
      if (advanceChannel) {
         const headCoachRoleId = '1463949316702994496';
        await advanceChannel.send(`<@&${headCoachRoleId}> We have advanced to Season ${newSeason}! Week reset to 0.`).catch(e => {
          console.error('[season-advance] Announce failed:', e);
        });
      } else {
        console.warn('[season-advance] advance-tracker channel not found');
      }
    }

    await interaction.editReply(`Season advanced to **${newSeason}**, week reset to 0.`);
  } catch (err) {
    console.error('[season-advance] Error:', err);
    await interaction.editReply({ content: `Error advancing season: ${err.message}`, flags: 64 });
  }

  return;
}
    // ---------------------------
    // /ranking (current season)
    // ---------------------------
    if (name === 'ranking') {
  console.log('[ranking] Started for', interaction.user.tag);

  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "Only the commissioner can view rankings.", flags: 64 });
  }

  try {
    console.log('[ranking] Fetching current season...');
    const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();
    const currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;

    console.log('[ranking] Fetching season records...');
    const { data: records, error: recordsErr } = await supabase
      .from('records')
      .select('*')
      .eq('season', currentSeason);

    if (recordsErr) throw recordsErr;
    console.log('[ranking] Fetched records count:', records?.length || 0);

    console.log('[ranking] Fetching current active coaches...');
    const { data: currentUsers, error: usersErr } = await supabase
      .from('teams')
      .select('taken_by')
      .not('taken_by', 'is', null);

    if (usersErr) throw usersErr;

    const currentUserIds = new Set((currentUsers || []).map(u => u.taken_by));
    console.log('[ranking] Active user IDs count:', currentUserIds.size);

    const filteredRecords = (records || []).filter(r => currentUserIds.has(r.taken_by));
    console.log('[ranking] Filtered active records count:', filteredRecords.length);

    if (filteredRecords.length === 0) {
      return interaction.editReply({ content: "No active user records found for this season.", flags: 64 });
    }

    console.log('[ranking] Fetching results for H2H tiebreakers...');
    const { data: results, error: resultsErr } = await supabase
      .from('results')
      .select('*')
      .eq('season', currentSeason);

    if (resultsErr) throw resultsErr;
    console.log('[ranking] Fetched results count:', results?.length || 0);

    const h2hMap = {};
    if (results) {
      for (const r of results) {
        if (r.taken_by && r.opponent_team_id) {
          const oppRecord = records.find(rec => rec.team_id === r.opponent_team_id);
          if (oppRecord && oppRecord.taken_by) {
            const key = `${r.taken_by}_vs_${oppRecord.taken_by}`;
            if (!h2hMap[key]) h2hMap[key] = { wins: 0, losses: 0 };
            if (r.result === 'W') h2hMap[key].wins++;
            else h2hMap[key].losses++;
          }
        }
      }
    }

    const getH2HWinPct = (userAId, userBId) => {
      const key = `${userAId}_vs_${userBId}`;
      if (!h2hMap[key]) return 0;
      const { wins, losses } = h2hMap[key];
      return (wins + losses) > 0 ? wins / (wins + losses) : 0;
    };

    const sorted = filteredRecords.sort((a, b) => {
      const winDiff = Math.abs(a.wins - b.wins);

      if (winDiff <= 1) {
        const aWinPct = (a.wins + a.losses) > 0 ? a.wins / (a.wins + a.losses) : 0;
        const bWinPct = (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) : 0;
        if (aWinPct !== bWinPct) return bWinPct - aWinPct;
      } else {
        return b.wins - a.wins;
      }

      const aUserPct = (a.user_wins + a.user_losses) > 0 ? a.user_wins / (a.user_wins + a.user_losses) : 0;
      const bUserPct = (b.user_wins + b.user_losses) > 0 ? b.user_wins / (b.user_wins + b.user_losses) : 0;
      if (aUserPct !== bUserPct) return bUserPct - aUserPct;

      const aH2H = getH2HWinPct(a.taken_by, b.taken_by);
      const bH2H = getH2HWinPct(b.taken_by, a.taken_by);
      if (aH2H !== bH2H) return bH2H - aH2H;

      return 0;
    });

    let description = '';
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const rank = i + 1;
      const record = `${r.wins}-${r.losses}`;
      const userRecord = `${r.user_wins}-${r.user_losses}`;
      const displayName = r.taken_by_name || r.team_name;
      const teamName = r.team_name;

      description += `${rank.toString().padStart(2, ' ')}. ${displayName}\n`;
      description += ` ${teamName}\n`;
      description += ` ${record} (${userRecord})\n\n`;
    }

    if (!description) description = 'No user teams found.';
    else description += '*Record in parentheses is vs user teams only*';

    const embed = {
      title: `🏆 CMR Dynasty Rankings – Season ${currentSeason}`,
      description: '```\n' + description + '\n```',
      color: 0xffd700,
      timestamp: new Date()
    };

    // Always post publicly to main-chat
    const generalChannel = interaction.guild?.channels.cache.find(ch => ch.name === 'main-chat');
    if (generalChannel) {
      await generalChannel.send({ embeds: [embed] }).catch(e => {
        console.error('[ranking] Failed to post to main-chat:', e);
      });
      await interaction.editReply({ content: 'Rankings posted to #main-chat.' });
    } else {
      console.warn('[ranking] main-chat channel not found');
      await interaction.editReply({ content: 'Rankings generated, but could not find #main-chat channel to post.' });
    }
  } catch (err) {
    console.error('ranking error:', err);
    await interaction.editReply({ content: `Error generating rankings: ${err.message}`, flags: 64 });
  }

  return;
}
    // ---------------------------
    // /ranking-all-time
    // ---------------------------
    if (name === 'ranking-all-time') {
  console.log('[ranking-all-time] Started');

  if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.editReply({ content: "Only the commissioner can view all-time rankings.", flags: 64 });
  }

  const isPublic = interaction.options.getBoolean('public') || false;

  try {
    console.log('[ranking-all-time] Fetching all records...');
    const { data: allRecords, error: recordsErr } = await supabase.from('records').select('*');
    if (recordsErr) throw recordsErr;

    console.log('[ranking-all-time] Fetched', allRecords?.length || 0, 'total records');

    console.log('[ranking-all-time] Fetching all results for H2H...');
    const { data: results, error: resultsErr } = await supabase.from('results').select('*');
    if (resultsErr) throw resultsErr;

    // Build H2H map
    const h2hMap = {};
    if (results) {
      for (const r of results) {
        if (r.taken_by && r.opponent_team_id) {
          const oppRecord = allRecords.find(rec => rec.team_id === r.opponent_team_id);
          if (oppRecord && oppRecord.taken_by) {
            const key = `${r.taken_by}_vs_${oppRecord.taken_by}`;
            if (!h2hMap[key]) h2hMap[key] = { wins: 0, losses: 0 };
            if (r.result === 'W') h2hMap[key].wins++;
            else h2hMap[key].losses++;
          }
        }
      }
    }

    const getH2HWinPct = (userAId, userBId) => {
      const key = `${userAId}_vs_${userBId}`;
      if (!h2hMap[key]) return 0;
      const { wins, losses } = h2hMap[key];
      return (wins + losses) > 0 ? wins / (wins + losses) : 0;
    };

    console.log('[ranking-all-time] Fetching current active coaches...');
    const { data: currentUsers, error: usersErr } = await supabase
      .from('teams')
      .select('taken_by, name')
      .not('taken_by', 'is', null);

    if (usersErr) throw usersErr;

    const currentUserIds = new Set((currentUsers || []).map(u => u.taken_by));
    const userTeamMap = {};
    (currentUsers || []).forEach(u => {
      userTeamMap[u.taken_by] = u.name;
    });

    console.log('[ranking-all-time] Aggregating records for', currentUserIds.size, 'active users');

    const userAggregates = {};
    if (allRecords) {
      for (const r of allRecords) {
        const userId = r.taken_by;
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

        userAggregates[userId].wins += r.wins || 0;
        userAggregates[userId].losses += r.losses || 0;
        userAggregates[userId].user_wins += r.user_wins || 0;
        userAggregates[userId].user_losses += r.user_losses || 0;
      }
    }

    const sorted = Object.values(userAggregates).sort((a, b) => {
      const winDiff = Math.abs(a.wins - b.wins);

      if (winDiff <= 1) {
        const aWinPct = (a.wins + a.losses) > 0 ? a.wins / (a.wins + a.losses) : 0;
        const bWinPct = (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) : 0;
        if (aWinPct !== bWinPct) return bWinPct - aWinPct;
      } else {
        return b.wins - a.wins;
      }

      const aUserPct = (a.user_wins + a.user_losses) > 0 ? a.user_wins / (a.user_wins + a.user_losses) : 0;
      const bUserPct = (b.user_wins + b.user_losses) > 0 ? b.user_wins / (b.user_wins + b.user_losses) : 0;
      if (aUserPct !== bUserPct) return bUserPct - aUserPct;

      const aH2H = getH2HWinPct(a.taken_by, b.taken_by);
      const bH2H = getH2HWinPct(b.taken_by, a.taken_by);
      if (aH2H !== bH2H) return bH2H - aH2H;

      return 0;
    });

    let description = '';
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const rank = i + 1;
      const record = `${r.wins}-${r.losses}`;
      const userRecord = `${r.user_wins}-${r.user_losses}`;
      const displayName = r.taken_by_name || 'Unknown';
      const teamName = r.team_name || 'No Team';

      description += `${rank.toString().padStart(2, ' ')}. ${displayName}\n`;
      description += ` ${teamName}\n`;
      description += ` ${record} (${userRecord})\n\n`;
    }

    if (!description) description = 'No user teams found across all seasons.';
    else description += `\n*Record in parentheses is vs user teams only*`;

    const embed = {
      title: `👑 CMR Dynasty All-Time Rankings`,
      description: '```\n' + description + '\n```',
      color: 0xffd700,
      timestamp: new Date()
    };

    if (isPublic) {
      const generalChannel = interaction.guild?.channels.cache.find(ch => ch.name === 'news-feed');
      if (generalChannel) {
        await generalChannel.send({ embeds: [embed] }).catch(e => console.error('Public rankings send failed:', e));
        return interaction.editReply({ content: 'All-time rankings posted to #news-feed.' });
      } else {
        return interaction.editReply({ content: 'Error: Could not find #news-feed channel.' });
      }
    } else {
      return interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('ranking-all-time error:', err);
    await interaction.editReply({ content: `Error generating all-time rankings: ${err.message}`, flags: 64 });
  }

  return;
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
      const teamChannelCategory = guild.channels.cache.find(
        ch => ch.name === 'Team Channels' && ch.type === ChannelType.GuildCategory
      );

      if (teamChannelCategory) {
        console.log('[move-coach] Looking for old channel with name:', oldTeam.name);

        // More flexible matching: partial match + normalize
        const oldChannel = guild.channels.cache.find(ch => {
          if (ch.parentId !== teamChannelCategory.id) return false;
          if (ch.type !== ChannelType.GuildText) return false;

          const normalizedOld = oldTeam.name.toLowerCase().replace(/\s+/g, '-');
          const normalizedCurrent = ch.name.toLowerCase().replace(/\s+/g, '-');
          return normalizedCurrent.includes(normalizedOld) || normalizedCurrent === normalizedOld;
        });

        if (oldChannel) {
          console.log('[move-coach] Found old channel:', oldChannel.name, '(ID:', oldChannel.id, ')');
          try {
            await oldChannel.setName(newTeam.name);
            console.log('[move-coach] Successfully renamed channel to:', newTeam.name);
          } catch (renameErr) {
            console.error('[move-coach] Channel rename failed:', renameErr.message);
          }
        } else {
          console.warn('[move-coach] No matching channel found for old team:', oldTeam.name);
        }
      } else {
        console.warn('[move-coach] Team Channels category not found');
      }
    }

    return interaction.editReply(
      `✅ Moved **${coachName}** from **${oldTeam.name}** to **${newTeam.name}**. Channel renamed (if it existed).`
    );
  } catch (err) {
    console.error('move-coach error:', err);
    return interaction.editReply(`Error moving coach: ${err.message}`);
  }
}
  // ───────────────────────────────────────────────
  // Catch-all for unhandled commands
  // ───────────────────────────────────────────────
  console.warn(`Unhandled command: /${name}`);
  await interaction.editReply({ content: "Command not implemented yet.", flags: 64 }).catch(() => {});
});
// ---------------------------------------------------------
// DM ACCEPT OFFER (user replies to bot DM with a number)
// ---------------------------------------------------------
client.on('messageCreate', async msg => {
  if (msg.guild || msg.author.bot) return;

  console.log(`[DM] Received from ${msg.author.tag} (${msg.author.id}): "${msg.content.trim()}"`);

  const userId = msg.author.id;

  if (!client.userOffers || !client.userOffers[userId]) {
    console.log('[DM] No pending offers for user', userId);
    return;
  }

  const offers = client.userOffers[userId];
  console.log('[DM] Found', offers.length, 'pending offers');

  const choiceRaw = msg.content.trim();
  const choice = parseInt(choiceRaw, 10);

  console.log('[DM] Choice parsed:', { raw: choiceRaw, parsed: choice });

  if (isNaN(choice) || choice < 1 || choice > offers.length) {
    console.log('[DM] Invalid choice');
    return msg.reply("Reply with the number of the team you choose (from the DM list).").catch(e => console.error('[DM] Reply failed:', e));
  }

  const team = offers[choice - 1];
  console.log('[DM] Selected team:', team.name, '(ID:', team.id, ')');

  try {
    console.log('[DM] Updating Supabase...');
    const updateResp = await supabase.from('teams').update({
      taken_by: userId,
      taken_by_name: msg.author.username
    }).eq('id', team.id);

    if (updateResp.error) {
      console.error('[DM] Supabase update failed:', updateResp.error);
      return msg.reply("Failed to claim the team — database error.").catch(() => {});
    }

    console.log('[DM] Supabase updated successfully');

    // Send confirmation DM FIRST (before guild operations)
    await msg.reply(`You accepted the job offer from **${team.name}**!`).catch(e => {
      console.error('[DM] Confirmation reply failed:', e);
    });

    delete client.userOffers[userId];
    console.log('[DM] Cleared userOffers for', userId);

    // Guild operations
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error('[DM] No guild found in cache');
      return;
    }

    console.log('[DM] Guild found:', guild.name, '(ID:', guild.id, ')');

    // Announce in general
    const general = guild.channels.cache.find(c => c.name === 'signed-coaches' && c.isTextBased());
    if (general) {
      await general.send(`🏈 <@${userId}> has accepted a job offer from **${team.name}**!`).catch(e => {
        console.error('[DM] General announce failed:', e);
      });
    } else {
      console.warn('[DM] main-chat channel not found');
    }

    // Create team channel
    try {
      const channelName = team.name.toLowerCase().replace(/\s+/g, '-');
      let teamChannelsCategory = guild.channels.cache.find(c => c.name === 'Team Channels' && c.type === ChannelType.GuildCategory);
      if (!teamChannelsCategory) {
        teamChannelsCategory = await guild.channels.create({
          name: 'Team Channels',
          type: ChannelType.GuildCategory
        });
        console.log('[DM] Created Team Channels category');
      }

      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: teamChannelsCategory.id,
        reason: `Team channel for ${team.name}`
      });
      console.log('[DM] Created channel #', channelName);

      await newChannel.send(`Welcome to **${team.name}**! <@${userId}> is the Head Coach.`);
    } catch (err) {
      console.error('[DM] Channel creation failed:', err);
    }

    // Assign Head Coach role
    try {
      const member = await guild.members.fetch(userId);
      let headCoachRole = guild.roles.cache.find(r => r.name === 'head coach');
      if (!headCoachRole) {
        headCoachRole = await guild.roles.create({
          name: 'head coach',
          reason: 'Role for team heads'
        });
        console.log('[DM] Created head coach role');
      }
      await member.roles.add(headCoachRole, "Claimed team");
      console.log('[DM] Assigned Head Coach role to', msg.author.tag);
    } catch (err) {
      console.error('[DM] Role assignment failed:', err);
    }

    await runListTeamsDisplay();
    console.log('[DM] Claim flow completed successfully');
  } catch (err) {
    console.error('[DM] Top-level error in claim flow:', err);
    await msg.reply("An error occurred processing your request.").catch(() => {});
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
