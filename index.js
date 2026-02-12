// index.js - fully updated for Supabase + Discord
// Refactored for better maintainability and code quality
require('dotenv').config();
const http = require('http');

// ═════════════════════════════════════════════════════════════
// CONSTANTS
// ═════════════════════════════════════════════════════════════

const SELF_PING_INTERVAL = 4 * 60 * 1000; // 4 minutes
const STREAM_REMINDER_DELAY = 45 * 60 * 1000; // 45 minutes
const SERVER_TIMEOUT = 30000; // 30 seconds
const AUTOCOMPLETE_MIN_LENGTH = 2;
const AUTOCOMPLETE_LIMIT = 25;
const HEAD_COACH_ROLE_ID = '1463949316702994496';

// ═════════════════════════════════════════════════════════════
// ENVIRONMENT VALIDATION
// ═════════════════════════════════════════════════════════════

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'SUPABASE_URL',
  'SUPABASE_KEY'
];

const missingEnvVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════
// HEALTH SERVER
// ═════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

server.timeout = SERVER_TIMEOUT;

server.listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

// ═════════════════════════════════════════════════════════════
// SELF-PINGER
// ═════════════════════════════════════════════════════════════

/**
 * Makes an HTTP GET request to keep service warm
 * @param {string} url - URL to ping
 * @returns {Promise<Object>} Response status or error
 */
const httpGet = (url) => {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.setTimeout(5000, () => { 
        req.abort(); 
        resolve({ error: 'timeout' }); 
      });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
};

if (process.env.SELF_PING_URL) {
  setInterval(async () => {
    try {
      const result = await httpGet(process.env.SELF_PING_URL);
      if (result.error) {
        console.debug('self-ping failed:', result.error);
      } else {
        console.debug('self-ping status:', result.status);
      }
    } catch (e) {
      console.debug('self-ping exception:', e);
    }
  }, SELF_PING_INTERVAL);
  console.log('Self-pinger enabled for', process.env.SELF_PING_URL);
}

// ═════════════════════════════════════════════════════════════
// DISCORD + SUPABASE SETUP
// ═════════════════════════════════════════════════════════════

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
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const jobOfferUsed = new Set();

// ═════════════════════════════════════════════════════════════
// SLASH COMMAND DEFINITIONS
// ═════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════
// COMMAND REGISTRATION
// ═════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════

/**
 * Pick N random items from an array (non-destructive)
 * @param {Array} arr - Source array
 * @param {number} n - Number of items to pick
 * @returns {Array} Random selection
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
 * @param {Array} offers - Array of team objects from Supabase
 * @returns {string} Formatted message
 */
function buildOffersGroupedByConference(offers) {
  const map = {};
  for (const t of offers) {
    const conf = t.conference || 'Independent';
    if (!map[conf]) map[conf] = [];
    map[conf].push(t);
  }

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
 * Find or create a role in the guild
 * @param {Guild} guild - Discord guild
 * @param {string} roleName - Name of the role
 * @param {string} reason - Reason for creation
 * @returns {Promise<Role>} The role object
 */
async function findOrCreateRole(guild, roleName, reason = 'Auto-created by bot') {
  let role = guild.roles.cache.find(r => r.name === roleName);
  if (!role) {
    role = await guild.roles.create({
      name: roleName,
      reason: reason
    });
    console.log(`[role] Created role: ${roleName}`);
  }
  return role;
}

/**
 * Find or create a category channel
 * @param {Guild} guild - Discord guild
 * @param {string} categoryName - Name of the category
 * @returns {Promise<CategoryChannel>} The category channel
 */
async function findOrCreateCategory(guild, categoryName) {
  let category = guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
  if (!category) {
    category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory
    });
    console.log(`[channel] Created category: ${categoryName}`);
  }
  return category;
}

/**
 * Find a text channel by name
 * @param {Guild} guild - Discord guild
 * @param {string} channelName - Name of the channel
 * @returns {TextChannel|null} The channel or null
 */
function findTextChannel(guild, channelName) {
  return guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
}

/**
 * Check if a message is in a team channel
 * @param {Channel} channel - Discord channel
 * @returns {boolean} True if in team channel
 */
function isTeamChannel(channel) {
  return channel.parent?.name === 'Team Channels' ||
         channel.name.toLowerCase().includes('team-') ||
         channel.name.toLowerCase().includes('-team');
}

/**
 * Normalize team name for channel creation
 * @param {string} teamName - Team name
 * @returns {string} Normalized channel name
 */
function normalizeChannelName(teamName) {
  return teamName.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Run the listteams display logic (posts to member-list channel)
 * Called both by /listteams command and by team claim/reset flows
 * @returns {Promise<boolean>} Success status
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

    const channel = findTextChannel(guild, 'team-lists');
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
 * Send job offers DM to user
 * @param {User} user - Discord user object
 * @param {number} count - Number of offers to send
 * @returns {Promise<Array>} Array of offered teams
 */
async function sendJobOffersToUser(user, count = 3) {
  const { data: available, error } = await supabase
    .from('teams')
    .select('*')
    .eq('stars', 2.5)
    .is('taken_by', null);

  if (error) throw error;
  if (!available || available.length === 0) return [];

  const offers = pickRandom(available, count);

  if (!client.userOffers) client.userOffers = {};
  client.userOffers[user.id] = offers;

  let dmText = `Your CMR Dynasty job offers:\n\n`;
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

/**
 * Get current season and week from database
 * @returns {Promise<Object>} Object with season and week
 */
async function getCurrentSeasonAndWeek() {
  const seasonResp = await supabase.from('meta').select('value').eq('key', 'current_season').maybeSingle();
  const weekResp = await supabase.from('meta').select('value').eq('key', 'current_week').maybeSingle();
  
  const currentSeason = seasonResp.data?.value != null ? Number(seasonResp.data.value) : 1;
  const currentWeek = weekResp.data?.value != null ? Number(weekResp.data.value) : 0;
  
  return { currentSeason, currentWeek };
}

/**
 * Find a team by name (case-insensitive, supports partial match)
 * @param {Array} teams - Array of team objects
 * @param {string} searchName - Name to search for
 * @returns {Object|null} Team object or null
 */
function findTeamByName(teams, searchName) {
  const needle = (searchName || '').toLowerCase().trim();
  return teams.find(t => t.name?.toLowerCase() === needle) ||
         teams.find(t => t.name?.toLowerCase().includes(needle));
}

/**
 * Update team records in the database after a game
 * @param {Object} params - Update parameters
 * @param {number} params.season - Current season number
 * @param {Object} params.team - Team object with id, name, taken_by, taken_by_name
 * @param {boolean} params.didWin - Whether this team won
 * @param {boolean} params.opponentIsUserControlled - Whether opponent is user-controlled
 * @param {boolean} params.opponentDidWin - Whether opponent won (for user_wins/losses tracking)
 * @returns {Promise<boolean>} Success status
 */
async function updateTeamRecords({ season, team, didWin, opponentIsUserControlled, opponentDidWin }) {
  try {
    console.log(`[updateTeamRecords] Updating records for ${team.name} (Season ${season})`);
    
    // Fetch existing record
    const { data: existing, error: fetchError } = await supabase
      .from('records')
      .select('wins, losses, user_wins, user_losses')
      .eq('season', season)
      .eq('team_id', team.id)
      .maybeSingle();

    if (fetchError) {
      console.error(`[updateTeamRecords] Fetch error for ${team.name}:`, fetchError);
      return false;
    }

    // Calculate new values
    const newWins = (existing?.wins || 0) + (didWin ? 1 : 0);
    const newLosses = (existing?.losses || 0) + (!didWin ? 1 : 0);
    const newUserWins = (existing?.user_wins || 0) + (opponentIsUserControlled && didWin ? 1 : 0);
    const newUserLosses = (existing?.user_losses || 0) + (opponentIsUserControlled && !didWin ? 1 : 0);

    console.log(`[updateTeamRecords] ${team.name}: ${existing?.wins || 0}-${existing?.losses || 0} → ${newWins}-${newLosses} (user: ${newUserWins}-${newUserLosses})`);

    // Upsert the record
    const { error: upsertError } = await supabase.from('records').upsert({
      season: season,
      team_id: team.id,
      team_name: team.name,
      taken_by: team.taken_by,
      taken_by_name: team.taken_by_name,
      wins: newWins,
      losses: newLosses,
      user_wins: newUserWins,
      user_losses: newUserLosses
    }, { onConflict: 'season,team_id' });

    if (upsertError) {
      console.error(`[updateTeamRecords] Upsert error for ${team.name}:`, upsertError);
      return false;
    }

    console.log(`[updateTeamRecords] Successfully updated ${team.name}`);
    return true;
  } catch (err) {
    console.error(`[updateTeamRecords] Unexpected error for ${team.name}:`, err);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════
// BOT READY EVENT
// ═════════════════════════════════════════════════════════════

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

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

    const guildCommands = await guild.commands.fetch();
    
    if (guildCommands.size === 0) {
      console.warn("No guild commands found.");
      return;
    }

    const publicCommands = ['game-result', 'press-release'];

    for (const cmd of guildCommands.values()) {
      if (publicCommands.includes(cmd.name)) {
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

// ═════════════════════════════════════════════════════════════
// INTERACTION HANDLERS
// ═════════════════════════════════════════════════════════════

client.on('interactionCreate', async interaction => {
  // ─────────────────────────────────────────────────────────
  // AUTOCOMPLETE HANDLER
  // ─────────────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);

    const safeRespond = async (choices) => {
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.respond(choices);
        }
      } catch (err) {
        if (err.code !== 40060 && err.code !== 10062) {
          console.error('Autocomplete respond error:', err);
        }
      }
    };

    const search = (focused.value || '').toLowerCase().trim();
    if (search.length < AUTOCOMPLETE_MIN_LENGTH) {
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

        await safeRespond(list.slice(0, AUTOCOMPLETE_LIMIT).map(n => ({ name: n, value: n })));
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

        await safeRespond(uniqueCoaches.slice(0, AUTOCOMPLETE_LIMIT).map(n => ({ name: n, value: n })));
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

        await safeRespond(list.slice(0, AUTOCOMPLETE_LIMIT));
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

        await safeRespond(list.slice(0, AUTOCOMPLETE_LIMIT).map(n => ({ name: n, value: n })));
        console.log(`[autocomplete] ${focused.name} found ${list.length} matches`);
      } catch (err) {
        console.error(`Autocomplete ${focused.name} error:`, err);
        await safeRespond([]);
      }
      return;
    }

    await safeRespond([]);
  }

  // ─────────────────────────────────────────────────────────
  // DEFER ALL SLASH COMMANDS
  // ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    try {
      await interaction.deferReply();
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

  // ─────────────────────────────────────────────────────────
  // /joboffers
  // ─────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────
  // /resetteam
  // ─────────────────────────────────────────────────────────
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
          const channelName = normalizeChannelName(teamData.name);
          const teamChannel = guild.channels.cache.find(
            c => c.name.toLowerCase() === channelName && c.isTextBased() && c.parentId === teamChannelsCategory.id
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

  // ─────────────────────────────────────────────────────────
  // /listteams
  // ─────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────
  // /game-result 
  // ─────────────────────────────────────────────────────────
  if (name === 'game-result') {
    console.log('[game-result] Started for', interaction.user.tag);

    const opponentName = interaction.options.getString('opponent');
    const userScore = interaction.options.getInteger('your_score');
    const opponentScore = interaction.options.getInteger('opponent_score');
    const summary = interaction.options.getString('summary');

    try {
      const { currentSeason, currentWeek } = await getCurrentSeasonAndWeek();

      console.log('[game-result] Fetching user team...');
      const { data: userTeam, error: userTeamErr } = await supabase
        .from('teams')
        .select('*')
        .eq('taken_by', interaction.user.id)
        .maybeSingle();

      if (userTeamErr) throw userTeamErr;
      if (!userTeam) {
        return interaction.editReply({ content: "You don't control a team.", flags: 64 });
      }

      console.log('[game-result] Checking for existing result...');
      const { data: existing } = await supabase
        .from('results')
        .select('opponent_team_name')
        .eq('season', currentSeason)
        .eq('week', currentWeek)
        .eq('user_team_id', userTeam.id)
        .maybeSingle();

      if (existing) {
        return interaction.editReply({
          content: `You already submitted a result this week (vs ${existing.opponent_team_name}).`,
          flags: 64
        });
      }

      console.log('[game-result] Looking up opponent...');
      const { data: teamsData, error: teamsErr } = await supabase
        .from('teams')
        .select('*')
        .limit(1000);

      if (teamsErr) throw teamsErr;

      const opponentTeam = findTeamByName(teamsData, opponentName);

      if (!opponentTeam) {
        return interaction.editReply({ content: `Opponent "${opponentName}" not found.`, flags: 64 });
      }

      console.log('[game-result] Opponent:', opponentTeam.name);

      console.log('[game-result] Inserting result...');
      const resultIsWin = userScore > opponentScore;
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
        result: resultIsWin ? 'W' : 'L',
        taken_by: userTeam.taken_by,
        taken_by_name: userTeam.taken_by_name || interaction.user.username
      }]);

      if (insertResp.error) {
        console.error('[game-result] Insert failed:', insertResp.error);
        return interaction.editReply({ content: `Failed to save result: ${insertResp.error.message}`, flags: 64 });
      }

      console.log('[game-result] Result inserted successfully');

      const isOppControlled = !!opponentTeam.taken_by;
      const oppWon = !resultIsWin;

      // Update records for user team
      console.log('[game-result] Updating records for user team...');
      const userTeamUpdated = await updateTeamRecords({
        season: currentSeason,
        team: {
          id: userTeam.id,
          name: userTeam.name,
          taken_by: userTeam.taken_by,
          taken_by_name: userTeam.taken_by_name || interaction.user.username
        },
        didWin: resultIsWin,
        opponentIsUserControlled: isOppControlled,
        opponentDidWin: oppWon
      });

      if (!userTeamUpdated) {
        console.warn('[game-result] User team records update had issues, but continuing...');
      }

      // Update records for opponent team (if controlled)
      if (isOppControlled) {
        console.log('[game-result] Updating records for opponent...');
        const oppTeamUpdated = await updateTeamRecords({
          season: currentSeason,
          team: {
            id: opponentTeam.id,
            name: opponentTeam.name,
            taken_by: opponentTeam.taken_by,
            taken_by_name: opponentTeam.taken_by_name
          },
          didWin: oppWon,
          opponentIsUserControlled: true, // User team is always user-controlled
          opponentDidWin: resultIsWin
        });

        if (!oppTeamUpdated) {
          console.warn('[game-result] Opponent team records update had issues, but continuing...');
        }
      }

      // Post box score to news-feed
      console.log('[game-result] Posting to news-feed...');
      const guild = interaction.guild;
      if (guild) {
        const newsChannel = findTextChannel(guild, 'news-feed');
        if (newsChannel) {
          const recordResp = await supabase
            .from('records')
            .select('wins, losses')
            .eq('season', currentSeason)
            .eq('team_id', userTeam.id)
            .maybeSingle();

          const wins = recordResp.data?.wins || 0;
          const losses = recordResp.data?.losses || 0;
          let recordText = `Record: ${userTeam.name} ${wins}-${losses}`;

          if (isOppControlled) {
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
            color: resultIsWin ? 0x00ff00 : 0xff0000,
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

      await interaction.editReply({ content: `Result recorded and posted to #news-feed: ${userTeam.name} vs ${opponentTeam.name}` });
    } catch (err) {
      console.error('[game-result] Top-level error:', err);
      await interaction.editReply({ content: `Error processing game result: ${err.message}`, flags: 64 });
    }

    return;
  }

  // ─────────────────────────────────────────────────────────
  // /any-game-result (commissioner only)
  // ─────────────────────────────────────────────────────────
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
      // Get current season
      console.log('[any-game-result] Fetching current season...');
      const { currentSeason } = await getCurrentSeasonAndWeek();
      console.log(`[any-game-result] Using season ${currentSeason}, week ${week}`);

      console.log('[any-game-result] Looking up teams...');
      const { data: allTeams, error: teamsError } = await supabase.from('teams').select('*').limit(1000);
      
      if (teamsError) throw teamsError;

      const homeTeam = findTeamByName(allTeams, homeTeamName);
      const awayTeam = findTeamByName(allTeams, awayTeamName);

      if (!homeTeam) return interaction.editReply({ content: `Home team "${homeTeamName}" not found.`, flags: 64 });
      if (!awayTeam) return interaction.editReply({ content: `Away team "${awayTeamName}" not found.`, flags: 64 });

      const homeWon = homeScore > awayScore;
      const awayWon = !homeWon;
      const homeResult = homeWon ? 'W' : 'L';

      const isHomeUserControlled = !!homeTeam.taken_by;
      const isAwayUserControlled = !!awayTeam.taken_by;

      console.log(`[any-game-result] Home: ${homeTeam.name} (${isHomeUserControlled ? 'user' : 'AI'})`);
      console.log(`[any-game-result] Away: ${awayTeam.name} (${isAwayUserControlled ? 'user' : 'AI'})`);

      console.log('[any-game-result] Inserting result...');
      const insert = await supabase.from('results').insert([{
        season: currentSeason,
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
      console.log('[any-game-result] Result inserted successfully');

      // Update records for home team (if user-controlled)
      if (isHomeUserControlled) {
        console.log('[any-game-result] Updating records for home team...');
        await updateTeamRecords({
          season: currentSeason,
          team: homeTeam,
          didWin: homeWon,
          opponentIsUserControlled: isAwayUserControlled,
          opponentDidWin: awayWon
        });
      }

      // Update records for away team (if user-controlled)
      if (isAwayUserControlled) {
        console.log('[any-game-result] Updating records for away team...');
        await updateTeamRecords({
          season: currentSeason,
          team: awayTeam,
          didWin: awayWon,
          opponentIsUserControlled: isHomeUserControlled,
          opponentDidWin: homeWon
        });
      }

      // Post box score to #news-feed
      const guild = interaction.guild;
      if (guild) {
        const newsChannel = findTextChannel(guild, 'news-feed');
        if (newsChannel) {
          const embed = {
            title: `Manually Entered Result: ${homeTeam.name} vs ${awayTeam.name}`,
            color: homeWon ? 0x00ff00 : 0xff0000,
            description: `${homeTeam.name} ${homeScore} - ${awayTeam.name} ${awayScore}\nWeek ${week}, Season ${currentSeason}\nSummary: ${summary || 'No summary'}`,
            timestamp: new Date()
          };
          await newsChannel.send({ embeds: [embed] }).catch(e => {
            console.error('[any-game-result] News-feed post failed:', e);
          });
        } else {
          console.warn('[any-game-result] news-feed channel not found');
        }
      }

      await interaction.editReply(`✅ Game result entered for Season ${currentSeason}, Week ${week}: ${homeTeam.name} ${homeScore} - ${awayTeam.name} ${awayScore}`);
    } catch (err) {
      console.error('[any-game-result] Error:', err);
      await interaction.editReply({ content: `Error entering result: ${err.message}`, flags: 64 });
    }

    return;
  }

  // ─────────────────────────────────────────────────────────
  // /press-release
  // ─────────────────────────────────────────────────────────
  if (name === 'press-release') {
    const text = interaction.options.getString('text');
    const { currentSeason, currentWeek } = await getCurrentSeasonAndWeek();

    const insert = await supabase.from('news_feed').insert([{ season: currentSeason, week: currentWeek, text }]);
    if (insert.error) {
      return interaction.editReply({ content: `Error: ${insert.error.message}`, flags: 64 });
    }

    const guild = client.guilds.cache.first();
    if (guild) {
      const newsChannel = findTextChannel(guild, 'news-feed');
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

  // ─────────────────────────────────────────────────────────
  // /advance
  // ─────────────────────────────────────────────────────────
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
      const { currentSeason, currentWeek } = await getCurrentSeasonAndWeek();
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
        const newsChannel = findTextChannel(guild, 'news-feed');
        if (newsChannel) {
          await newsChannel.send({ embeds: [embed] }).catch(e => console.error('news send failed:', e));
        }

        const advanceChannel = findTextChannel(guild, 'advance-tracker');
        if (advanceChannel) {
          await advanceChannel.send(
            `<@&${HEAD_COACH_ROLE_ID}> We have advanced to Week ${newWeek}\n${nextAdvanceMessage}`
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

  // ─────────────────────────────────────────────────────────
  // /season-advance
  // ─────────────────────────────────────────────────────────
  if (name === 'season-advance') {
    console.log('[season-advance] Started');

    if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: "Only the commissioner can advance the season.", flags: 64 });
    }

    try {
      console.log('[season-advance] Fetching current season...');
      const { currentSeason } = await getCurrentSeasonAndWeek();
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
        const advanceChannel = findTextChannel(guild, 'advance-tracker');
        if (advanceChannel) {
          await advanceChannel.send(`<@&${HEAD_COACH_ROLE_ID}> We have advanced to Season ${newSeason}! Week reset to 0.`).catch(e => {
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

  // ─────────────────────────────────────────────────────────
  // /ranking (current season)
  // ─────────────────────────────────────────────────────────
  if (name === 'ranking') {
    console.log('[ranking] Started for', interaction.user.tag);

    if (!interaction.member?.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: "Only the commissioner can view rankings.", flags: 64 });
    }

    try {
      console.log('[ranking] Fetching current season...');
      const { currentSeason } = await getCurrentSeasonAndWeek();

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

      const generalChannel = findTextChannel(interaction.guild, 'news-feed');
      if (generalChannel) {
        await generalChannel.send({ embeds: [embed] }).catch(e => {
          console.error('[ranking] Failed to post to news-feed:', e);
        });
        await interaction.editReply({ content: 'Rankings posted to #news-feed.' });
      } else {
        console.warn('[ranking] news-feed channel not found');
        await interaction.editReply({ content: 'Rankings generated, but could not find #news-feed channel to post.' });
      }
    } catch (err) {
      console.error('ranking error:', err);
      await interaction.editReply({ content: `Error generating rankings: ${err.message}`, flags: 64 });
    }

    return;
  }

  // ─────────────────────────────────────────────────────────
  // /ranking-all-time
  // ─────────────────────────────────────────────────────────
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
        const generalChannel = findTextChannel(interaction.guild, 'news-feed');
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

  // ─────────────────────────────────────────────────────────
  // /move-coach
  // ─────────────────────────────────────────────────────────
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

          const normalizedOld = normalizeChannelName(oldTeam.name);
          const oldChannel = guild.channels.cache.find(ch => {
            if (ch.parentId !== teamChannelCategory.id) return false;
            if (ch.type !== ChannelType.GuildText) return false;

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

  // ─────────────────────────────────────────────────────────
  // Catch-all for unhandled commands
  // ─────────────────────────────────────────────────────────
  console.warn(`Unhandled command: /${name}`);
  await interaction.editReply({ content: "Command not implemented yet.", flags: 64 }).catch(() => {});
});

// ═════════════════════════════════════════════════════════════
// DM MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════

client.on('messageCreate', async msg => {
  // Skip if not a DM or from bot
  if (msg.guild || msg.author.bot) return;

  console.log(`[DM] Received from ${msg.author.tag} (${msg.author.id}): "${msg.content.trim()}"`);

  const userId = msg.author.id;

  // DM acceptance for job offers
  if (client.userOffers && client.userOffers[userId]) {
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

      await msg.reply(`You accepted the job offer from **${team.name}**!`).catch(e => {
        console.error('[DM] Confirmation reply failed:', e);
      });

      delete client.userOffers[userId];
      console.log('[DM] Cleared userOffers for', userId);

      const guild = client.guilds.cache.first();
      if (!guild) {
        console.error('[DM] No guild found in cache');
        return;
      }

      console.log('[DM] Guild found:', guild.name, '(ID:', guild.id, ')');

      const general = findTextChannel(guild, 'signed-coaches');
      if (general) {
        await general.send(`🏈 <@${userId}> has accepted a job offer from **${team.name}**!`).catch(e => {
          console.error('[DM] General announce failed:', e);
        });
      } else {
        console.warn('[DM] signed-coaches channel not found');
      }

      try {
        const channelName = normalizeChannelName(team.name);
        const teamChannelsCategory = await findOrCreateCategory(guild, 'Team Channels');

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

      try {
        const member = await guild.members.fetch(userId);
        const headCoachRole = await findOrCreateRole(guild, 'head coach', 'Role for team heads');
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
    return;
  }
});

// ═════════════════════════════════════════════════════════════
// STREAM REMINDER HANDLER
// ═════════════════════════════════════════════════════════════

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild || !msg.channel?.isTextBased()) return;

  // Only watch team channels
  if (!isTeamChannel(msg.channel)) return;

  const content = msg.content;

  // Detect YouTube or Twitch links
  const streamRegex = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|twitch\.tv|youtube\.com\/shorts)\/[^\s<>"')]+/i;

  if (!streamRegex.test(content)) return;

  console.log(`[stream-reminder] Detected stream link in ${msg.channel.name} by ${msg.author.tag}`);

  // Optional: require game/stream context to reduce false positives
  const hasGameContext = /live|stream|game|watch|vs|playing/i.test(content);
  if (!hasGameContext) {
    console.log('[stream-reminder] Link detected but no game context — skipping');
    return;
  }

  // Schedule reminder 45 minutes later
  setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(msg.channel.id);
      if (!channel?.isTextBased()) return;

      const reminderText = 
        `<@${msg.author.id}> Friendly reminder! ` +
        `Please share your game results using the \`/game-result\` command 😊`;

      await channel.send(reminderText);
      console.log(`[stream-reminder] Sent reminder in ${msg.channel.name}`);
    } catch (err) {
      console.error('[stream-reminder] Failed to send reminder:', err.message);
    }
  }, STREAM_REMINDER_DELAY);
});

// ═════════════════════════════════════════════════════════════
// ERROR HANDLERS & GRACEFUL SHUTDOWN
// ═════════════════════════════════════════════════════════════

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  try {
    if (client?.destroy) await client.destroy();
  } catch (e) {
    console.error('Error during client.destroy() after uncaughtException:', e);
  }
  process.exit(1);
});

client.on('error', (err) => console.error('Discord client error:', err));
client.on('warn', (info) => console.warn('Discord client warning:', info));
client.on('shardError', (error) => console.error('Discord client shardError:', error));

/**
 * Graceful shutdown handler
 * @param {string} signal - Signal name (SIGTERM, SIGINT)
 */
const shutdown = async (signal) => {
  console.log(`Received ${signal} - shutting down gracefully...`);
  try {
    if (client?.destroy) {
      await client.destroy();
      console.log('Discord client destroyed successfully');
    }
  } catch (e) {
    console.error('Error during client.destroy() in shutdown:', e);
  }
  
  // Ensure cleanup completes
  await new Promise(resolve => setTimeout(resolve, 500));
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ═════════════════════════════════════════════════════════════
// BOT LOGIN
// ═════════════════════════════════════════════════════════════

(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (e) {
    console.error("Failed to login:", e);
    process.exit(1);
  }
})();
