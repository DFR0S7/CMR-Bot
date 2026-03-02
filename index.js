// =====================================================
// Universal Dynasty League Bot - index.js
// Version: 2.1.0 (Universal Multi-Server)
// =====================================================

require('dotenv').config();
const http  = require('http');
const https = require('https');

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
  Events,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// =====================================================
// ENVIRONMENT & CLIENTS
// =====================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CLIENT_ID     = process.env.CLIENT_ID;
const PORT          = process.env.PORT || 3000;
const SELF_PING_URL = process.env.SELF_PING_URL || '';

if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID) {
  console.error('[boot] Missing required environment variables. Check DISCORD_TOKEN, SUPABASE_URL, SUPABASE_KEY, CLIENT_ID.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

// =====================================================
// =====================================================
// PHASE CYCLE
// =====================================================
const PHASE_CYCLE = [
  { key: 'preseason',           name: 'Preseason',               subWeeks: 1,  startSub: 0, format: ()    => 'Preseason' },
  { key: 'regular',             name: 'Regular Season',          subWeeks: 15, startSub: 0, format: (sub) => `Week ${sub}` },
  { key: 'conf_champ',          name: 'Conference Championship', subWeeks: 1,  startSub: 0, format: ()    => 'Conference Championship' },
  { key: 'bowl',                name: 'Bowl Season',             subWeeks: 4,  startSub: 0, format: (sub) => {
    const labels = ['Bowl Week 1', 'Bowl Week 2', 'Semifinals', 'National Championship'];
    return labels[sub] ?? `Bowl Week ${sub + 1}`;
  }},
  { key: 'players_leaving',     name: 'Players Leaving',         subWeeks: 1,  startSub: 0, format: ()    => 'Players Leaving' },
  { key: 'transfer_portal',     name: 'Transfer Portal',         subWeeks: 4,  startSub: 0, format: (sub) => `Transfer Week ${sub + 1}` },
  { key: 'position_changes',    name: 'Position Changes',        subWeeks: 1,  startSub: 0, format: ()    => 'Position Changes' },
  { key: 'training_results',    name: 'Training Results',        subWeeks: 1,  startSub: 0, format: ()    => 'Training Results' },
  { key: 'encourage_transfers', name: 'Encourage Transfers',     subWeeks: 1,  startSub: 0, format: ()    => 'Encourage Transfers' },
];

const getPhaseByKey = (key) => PHASE_CYCLE.find(p => p.key === key) || PHASE_CYCLE[0];

// Returns a human-readable label for the current phase + sub-week
function formatPhase(phaseKey, subPhase) {
  const phase = getPhaseByKey(phaseKey);
  return phase.format ? phase.format(subPhase) : phase.name;
}

const streamReminderTimers = new Map();

// =====================================================
// HEALTH SERVER (always on for Render)
// =====================================================
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Dynasty Bot OK');
}).listen(PORT, () => {
  console.log(`[server] HTTP server listening on port ${PORT}`);
});

// =====================================================
// SELF-PING (keep Render free tier alive)
// =====================================================
if (SELF_PING_URL) {
  setInterval(() => {
    const mod = SELF_PING_URL.startsWith('https') ? https : http;
    mod.get(SELF_PING_URL, () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
  console.log(`[server] Self-ping enabled → ${SELF_PING_URL}`);
}

// =====================================================
// GLOBAL ERROR HANDLERS — keep process alive on errors
// =====================================================
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught Exception:', err);
});

client.on('error', (err) => {
  console.error('[discord] Client error:', err);
});

client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[discord] Shard ${shardId} disconnected. Code: ${event.code}`);
});

client.on('shardReconnecting', (shardId) => {
  console.log(`[discord] Shard ${shardId} reconnecting...`);
});

client.on('shardResume', (shardId, replayed) => {
  console.log(`[discord] Shard ${shardId} resumed. Replayed ${replayed} events.`);
});

// =====================================================
// CONFIG CACHE (per guild)
// =====================================================
const guildConfigs = new Map();

// Single source of truth for default config values
const CONFIG_DEFAULTS = {
  league_name:                  'Dynasty League',
  league_abbreviation:          '',
  setup_complete:               false,
  league_type:                  'new',      // 'new' | 'established'
  // ── Feature flags ─────────────────────────────
  feature_game_result:          false,
  feature_any_game_result:      false,
  feature_ranking:              false,
  feature_ranking_all_time:     false,
  feature_game_results_reminder:false,
  feature_job_offers:           false,
  feature_assign_team:          false,
  feature_reset_team:           false,
  feature_list_teams:           false,
  feature_move_coach:           false,
  feature_advance:              false,
  feature_stream_autopost:      false,
  feature_streaming_list:       false,
  // ── Channels ──────────────────────────────────
  channel_news_feed:            'news-feed',
  channel_advance_tracker:      'advance-tracker',
  channel_team_lists:           'team-lists',
  channel_signed_coaches:       'signed-coaches',
  channel_streaming:            'streaming',
  // ── Roles ─────────────────────────────────────
  role_head_coach:              'head coach',
  role_head_coach_id:           null,
  // ── Job Offers ────────────────────────────────
  star_rating_for_offers:       2.5,
  star_rating_max_for_offers:   null,
  job_offers_count:             3,
  job_offers_expiry_hours:      48,
  // ── Stream / Advance ──────────────────────────
  stream_reminder_minutes:      45,
  advance_intervals:            '[24, 48]',
  advance_timezones:             '["ET","CT","MT","PT"]',
  // ── Embed colors ──────────────────────────────
  embed_color_primary:          '0x1e90ff',
  embed_color_win:              '0x00ff00',
  embed_color_loss:             '0xff0000',
};

function parseConfig(data) {
  let intervals = [24, 48];
  try {
    const raw = (data.advance_intervals || '').trim();
    // Support both "[12, 24, 48]" (JSON) and "12,24,48" (plain CSV)
    const normalized = raw.startsWith('[') ? raw : `[${raw}]`;
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed) && parsed.length > 0) {
      intervals = parsed.map(Number).filter(n => !isNaN(n));
    }
  } catch (_) {
    console.warn(`[config] Could not parse advance_intervals: "${data.advance_intervals}" — using default [24, 48]`);
  }
  return {
    ...data,
    advance_intervals_parsed: intervals,
    advance_timezones_parsed: (() => {
      try {
        const tzs = JSON.parse(data.advance_timezones || '["ET","CT","MT","PT"]');
        return Array.isArray(tzs) ? tzs : ['ET','CT','MT','PT'];
      } catch { return ['ET','CT','MT','PT']; }
    })(),
    embed_color_primary_int:  parseInt(data.embed_color_primary, 16) || 0x1e90ff,
    embed_color_win_int:      parseInt(data.embed_color_win, 16)     || 0x00ff00,
    embed_color_loss_int:     parseInt(data.embed_color_loss, 16)    || 0xff0000,
  };
}

async function loadGuildConfig(guildId) {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  if (error || !data) {
    console.log(`[config] No config for guild ${guildId}, using defaults.`);
    const defaults = parseConfig({ ...CONFIG_DEFAULTS, guild_id: guildId,
      advance_intervals_parsed: [24, 48],
      embed_color_primary_int: 0x1e90ff,
      embed_color_win_int: 0x00ff00,
      embed_color_loss_int: 0xff0000,
    });
    guildConfigs.set(guildId, defaults);
    return defaults;
  }

  const parsed = parseConfig(data);
  guildConfigs.set(guildId, parsed);
  return parsed;
}

async function getConfig(guildId) {
  return guildConfigs.get(guildId) || loadGuildConfig(guildId);
}

async function saveConfig(guildId, updates) {
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('config')
    .update(updates)
    .eq('guild_id', guildId);
  if (error) throw error;
  guildConfigs.delete(guildId);
  return loadGuildConfig(guildId);
}

async function createDefaultConfig(guildId, leagueName = 'Dynasty League') {
  const { error } = await supabase.from('config').upsert(
    { ...CONFIG_DEFAULTS, guild_id: guildId, league_name: leagueName },
    { onConflict: 'guild_id' }
  );
  if (error) throw error;
  guildConfigs.delete(guildId);
  return loadGuildConfig(guildId);
}

// =====================================================
// DISCORD HELPERS
// =====================================================
function findTextChannel(guild, name) {
  if (!name) return null;
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === name.toLowerCase()
  ) || null;
}

async function findOrCreateRole(guild, roleName) {
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    role = await guild.roles.create({ name: roleName, reason: 'Dynasty Bot auto-created role' });
  }
  return role;
}

function starRating(rating) {
  const full  = Math.floor(rating);
  const half  = (rating % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '⭐'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

// Post an embed to a channel, logging a warning if the channel isn't found
async function postToChannel(guild, channelName, payload) {
  const ch = findTextChannel(guild, channelName);
  if (!ch) {
    console.warn(`[post] Channel not found: "${channelName}"`);
    return null;
  }
  await ch.send(payload);
  return ch;
}

// =====================================================
// SUPABASE HELPERS
// =====================================================
async function getTeamByUser(userId, guildId) {
  const { data, error } = await supabase
    .from('team_assignments')
    .select('*, teams(*)')
    .eq('user_id', userId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    console.error(`[db] getTeamByUser(${userId}, ${guildId}) error:`, error.message);
    throw new Error(`Database error looking up your team: ${error.message}`);
  }
  if (!data) return null;
  if (!data.teams) {
    console.warn(`[db] getTeamByUser: assignment found but teams join returned null for user ${userId} — orphaned assignment row?`);
    return null;
  }
  return { ...data.teams, user_id: data.user_id, assignment_id: data.id };
}

async function getTeamByName(teamName, guildId) {
  // Use maybeSingle() so Supabase returns null instead of throwing on 0 rows
  const { data: team, error: teamErr } = await supabase
    .from('teams')
    .select('*')
    .ilike('team_name', teamName.trim())
    .maybeSingle();

  if (teamErr) {
    console.error(`[db] getTeamByName("${teamName}") teams query error:`, teamErr.message);
    throw new Error(`Database error looking up team "${teamName}": ${teamErr.message}`);
  }
  if (!team) return null;

  const { data: assignment, error: assignErr } = await supabase
    .from('team_assignments')
    .select('*')
    .eq('team_id', team.id)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (assignErr) {
    console.error(`[db] getTeamByName("${teamName}") assignments query error:`, assignErr.message);
    // Non-fatal — team exists, just no assignment info
  }

  return { ...team, user_id: assignment?.user_id || null, assignment_id: assignment?.id || null };
}

async function getAllTeams(guildId) {
  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('*')
    .order('team_name');

  if (teamsErr) {
    console.error(`[db] getAllTeams(${guildId}) teams query error:`, teamsErr.message);
    throw new Error(`Database error loading teams: ${teamsErr.message}`);
  }
  if (!teams || teams.length === 0) return [];

  const { data: assignments, error: assignErr } = await supabase
    .from('team_assignments')
    .select('*')
    .eq('guild_id', guildId);

  if (assignErr) {
    console.error(`[db] getAllTeams(${guildId}) assignments query error:`, assignErr.message);
    // Non-fatal — return teams with no assignment info
  }

  const assignMap = {};
  for (const a of (assignments || [])) assignMap[a.team_id] = a;

  return teams.map(t => ({
    ...t,
    user_id:       assignMap[t.id]?.user_id || null,
    assignment_id: assignMap[t.id]?.id      || null,
  }));
}

async function assignTeam(teamId, userId, guildId) {
  await supabase
    .from('team_assignments')
    .upsert({ team_id: teamId, user_id: userId, guild_id: guildId }, { onConflict: 'team_id,guild_id' });
}

async function unassignTeam(teamId, guildId) {
  await supabase
    .from('team_assignments')
    .delete()
    .eq('team_id', teamId)
    .eq('guild_id', guildId);
}

async function getMeta(guildId) {
  const { data } = await supabase.from('meta').select('*').eq('guild_id', guildId).single();
  return data || {
    season:               1,
    week:                 1,
    current_phase:        'preseason',
    current_sub_phase:    0,
    advance_hours:        24,
    advance_deadline:     null,
    last_advance_at:      null,
    next_advance_deadline: null,
  };
}

async function setMeta(guildId, updates) {
  await supabase.from('meta').upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });
}


// ── Job Offer Config helpers ──────────────────────────────────────────────
async function getJobOfferConfig(guildId) {
  const { data } = await supabase
    .from('job_offer_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  return {
    one_per_conference: false,
    weighted_ratings:   'off',
    conf_balance:       false,
    ...( data || {} ),
  };
}

async function setJobOfferConfig(guildId, updates) {
  await supabase.from('job_offer_config').upsert(
    { guild_id: guildId, ...updates },
    { onConflict: 'guild_id' }
  );
}

async function getJobOfferConferences(guildId, mode) {
  const { data } = await supabase
    .from('job_offer_conferences')
    .select('conference')
    .eq('guild_id', guildId)
    .eq('mode', mode);
  return (data || []).map(r => r.conference);
}

async function toggleJobOfferConference(guildId, conference, mode) {
  // Returns true if now active, false if removed
  const { data: existing } = await supabase
    .from('job_offer_conferences')
    .select('conference')
    .eq('guild_id', guildId)
    .eq('conference', conference)
    .eq('mode', mode)
    .maybeSingle();

  if (existing) {
    await supabase.from('job_offer_conferences')
      .delete()
      .eq('guild_id', guildId)
      .eq('conference', conference)
      .eq('mode', mode);
    return false;
  } else {
    await supabase.from('job_offer_conferences')
      .insert({ guild_id: guildId, conference, mode });
    return true;
  }
}

async function getDistinctConferences() {
  const { data } = await supabase
    .from('teams')
    .select('conference')
    .not('conference', 'is', null)
    .neq('conference', 'FCS');
  const unique = [...new Set((data || []).map(r => r.conference).filter(Boolean))].sort();
  return unique;
}

async function getRecord(teamId, season, guildId) {
  const { data } = await supabase
    .from('records')
    .select('*')
    .eq('team_id', teamId)
    .eq('season', season)
    .eq('guild_id', guildId)
    .single();
  return data || { wins: 0, losses: 0, team_id: teamId, season, guild_id: guildId };
}

async function upsertRecord(record) {
  await supabase.from('records').upsert(record, { onConflict: 'team_id,season,guild_id' });
}

// =====================================================
// COACH STREAM HELPERS
// =====================================================

async function setCoachStream(guildId, userId, handle, platform = 'twitch') {
  const { error } = await supabase.from('coach_streams').upsert({
    guild_id:   guildId,
    user_id:    userId,
    stream_url: handle.trim(),  // stream_url column stores the handle
    platform,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'guild_id,user_id' });

  if (error) throw error;
}

async function removeCoachStream(guildId, userId) {
  await supabase
    .from('coach_streams')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);
}

async function getStreamerByHandle(guildId, handle) {
  // Match handle case-insensitively against stream_url (which stores the handle)
  const { data, error } = await supabase
    .from('coach_streams')
    .select('user_id, stream_url, platform')
    .eq('guild_id', guildId);

  if (error || !data) return null;
  const normalised = handle.toLowerCase().replace(/^\//, '');
  return data.find(r => r.stream_url.toLowerCase() === normalised) || null;
}

async function getAllStreamers(guildId) {
  const { data, error } = await supabase
    .from('coach_streams')
    .select('user_id, stream_url, platform')
    .eq('guild_id', guildId)
    .order('platform', { ascending: true });

  if (error) throw error;
  return data || [];
}
// =====================================================
// STREAM REMINDER TRACKING
// =====================================================
function scheduleStreamReminder(channel, userId, guildId, minutes) {
  const key = `${guildId}-${channel.id}-${userId}`;
  if (streamReminderTimers.has(key)) return;

  const timer = setTimeout(async () => {
    streamReminderTimers.delete(key);
    try {
      await channel.send(
        `<@${userId}> Friendly reminder! Please share your game results using the \`/game-result\` command 😊`
      );
      console.log(`[stream] Reminder sent to ${userId} in guild ${guildId}`);
    } catch (e) {
      console.error('[stream] Could not send reminder:', e.message);
    }
  }, minutes * 60 * 1000);

  streamReminderTimers.set(key, timer);
  console.log(`[stream] Scheduled ${minutes}min reminder for user ${userId} in guild ${guildId}`);
}

// =====================================================
// SLASH COMMANDS DEFINITION
// =====================================================
function buildCommands() {
  return [
    // ── User Commands ──────────────────────────────
    new SlashCommandBuilder()
      .setName('joboffers')
      .setDescription('Get coaching job offers based on your current team rating'),

    new SlashCommandBuilder()
      .setName('game-result')
      .setDescription('Submit your game result')
      .addStringOption(o => o.setName('opponent').setDescription('Opponent team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('your-score').setDescription('Your score').setRequired(true))
      .addIntegerOption(o => o.setName('opponent-score').setDescription('Opponent score').setRequired(true))
      .addStringOption(o => o.setName('summary').setDescription('Optional game summary or highlights').setRequired(false).setMaxLength(500)),

    new SlashCommandBuilder()
      .setName('ranking')
      .setDescription('View current season standings'),

    new SlashCommandBuilder()
      .setName('ranking-all-time')
      .setDescription('View all-time win/loss rankings'),

    // ── Admin Commands ─────────────────────────────
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Interactive bot configuration wizard (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Manage bot configuration (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(sub => sub.setName('view').setDescription('View current configuration'))
      .addSubcommand(sub => sub.setName('features').setDescription('Toggle features on/off'))
      .addSubcommand(sub => sub.setName('reload').setDescription('Reload config from database'))
      .addSubcommand(sub => sub.setName('timezones').setDescription('Configure timezones shown on advance deadline posts'))
      .addSubcommand(sub =>
        sub.setName('edit')
          .setDescription('Edit a specific config value')
          .addStringOption(o => o.setName('setting').setDescription('Setting name').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('value').setDescription('New value').setRequired(true).setAutocomplete(true))
      ),

    new SlashCommandBuilder()
      .setName('assign-team')
      .setDescription('Manually assign a team to a user (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
      .addStringOption(o => o.setName('team').setDescription('Team name').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('skip-announcement').setDescription('Skip signing announcement').setRequired(false)),

    new SlashCommandBuilder()
      .setName('resetteam')
      .setDescription('Remove a user from their team (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('User to reset').setRequired(true)),

    new SlashCommandBuilder()
      .setName('listteams')
      .setDescription('Post the team availability list (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('advance')
      .setDescription('Advance to next week (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('hours').setDescription('Deadline window for this week').setRequired(true).setAutocomplete(true)),


    new SlashCommandBuilder()
      .setName('move-coach')
      .setDescription('Move a coach from one team to another (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('coach').setDescription('Coach to move').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('new-team').setDescription('Destination team').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('any-game-result')
      .setDescription('Enter a result for any two teams (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('team1').setDescription('First team name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('team2').setDescription('Second team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('score1').setDescription('Team 1 score').setRequired(true))
      .addIntegerOption(o => o.setName('score2').setDescription('Team 2 score').setRequired(true))
      .addIntegerOption(o => o.setName('week').setDescription('Week number (defaults to current week)').setRequired(false).setMinValue(1)),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('View available commands and how to use them'),

    new SlashCommandBuilder()
      .setName('checkpermissions')
      .setDescription('Check if the bot has all required permissions (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('streamer')
      .setDescription('Streamer commands for Wamellow integration')
      .addSubcommand(sub => sub
        .setName('register')
        .setDescription('Streamer Registration — save your Twitch or YouTube handle')
        .addStringOption(o =>
          o.setName('platform')
           .setDescription('Your streaming platform')
           .setRequired(true)
           .addChoices(
             { name: 'Twitch',  value: 'twitch' },
             { name: 'YouTube', value: 'youtube' },
           )
        )
        .addStringOption(o =>
          o.setName('handle')
           .setDescription('Your username/handle (e.g. johndoe — no URL needed)')
           .setRequired(true)
        )
      )
      .addSubcommand(sub => sub
        .setName('list')
        .setDescription('Streamer List — show all coaches, their Discord name, and handle')
      ),

    new SlashCommandBuilder()
      .setName('set-phase')
      .setDescription('[Admin] Manually set the current season, phase, and week.')
      .addIntegerOption(o => o.setName('season').setDescription('Season number (e.g. 3)').setRequired(true).setMinValue(1))
      .addStringOption(o => o
        .setName('phase')
        .setDescription('Phase to set')
        .setRequired(true)
        .addChoices(
          { name: 'Preseason',               value: 'preseason' },
          { name: 'Regular Season',           value: 'regular' },
          { name: 'Conference Championship',  value: 'conf_champ' },
          { name: 'Bowl Season',              value: 'bowl' },
          { name: 'Players Leaving',          value: 'players_leaving' },
          { name: 'Transfer Portal',          value: 'transfer_portal' },
          { name: 'Position Changes',         value: 'position_changes' },
          { name: 'Training Results',         value: 'training_results' },
          { name: 'Encourage Transfers',      value: 'encourage_transfers' },
        )
      )
      .addIntegerOption(o => o
        .setName('sub')
        .setDescription('Sub-phase index. Regular: 0–14 (week). Bowl: 0–3. Transfer: 0–3 (displays as Week 1–4). Others: 0.')
        .setRequired(false)
        .setMinValue(0)
      ),

    new SlashCommandBuilder()
      .setName('reload-commands')
      .setDescription('[Admin] Force re-register all slash commands with Discord.'),

    new SlashCommandBuilder()
      .setName('offers-config')
      .setDescription('[Admin] Configure job offer conference rules and weighting.'),

  ].map(cmd => cmd.toJSON());
}

// =====================================================
// REGISTER SLASH COMMANDS
// =====================================================
async function registerCommands() {
  const rest     = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = buildCommands();
  try {
    console.log('[commands] Registering global slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`[commands] Registered ${commands.length} commands.`);
  } catch (err) {
    console.error('[commands] Registration failed:', err);
  }
}

// =====================================================
// COMMAND HANDLERS
// =====================================================

// Setup gate — returned to user-facing handlers when setup hasn't been run
async function replySetupRequired(interaction) {
  const msg = {
    content:
      '⚙️ **Setup Required**\n' +
      "This bot hasn't been configured for this server yet.\n" +
      'An admin needs to run `/setup` to get started.',
    flags: 64,
  };
  if (interaction.deferred || interaction.replied) return interaction.editReply(msg);
  return interaction.reply(msg);
}

// /setup ──────────────────────────────────────────────
async function handleSetup(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  // Acknowledge immediately — must happen within 3 seconds
  await interaction.reply({ content: '📬 Check your DMs — setup wizard is starting!', flags: 64 });

  // Fetch guild with full data — use fetch({force:true}) to bypass stale cache
  let guild = interaction.guild;
  if (!guild) {
    guild = await client.guilds.fetch({ guild: guildId, force: true }).catch(() => null);
  }
  if (!guild) {
    return interaction.followUp({ content: '❌ **Setup Failed**\nCould not load server data. Please try again in a moment.', flags: 64 });
  }

  // Populate channel and role caches
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});

  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.followUp({
      content: "❌ **Setup Failed — DMs Blocked**\nI couldn't send you a DM. To fix this:\n1. Right-click the server → **Privacy Settings**\n2. Enable **Direct Messages**\n3. Run `/setup` again",
      flags: 64,
    });
  }

  await dm.send("👋 **Dynasty Bot Setup Wizard**\nAnswer each question in this DM. You have 2 minutes per step.");

  // ── Setup Helpers ─────────────────────────────────────────────────────────

  const TIMEOUT_MSG = '⏰ Setup timed out. Run `/setup` in your server again to restart.';

  const ask = async (question) => {
    await dm.send(question);
    try {
      const col = await dm.awaitMessages({ filter: m => m.author.id === userId && !m.author.bot, max: 1, time: 120000, errors: ['time'] });
      return col.first().content.trim();
    } catch {
      await dm.send(TIMEOUT_MSG);
      return null;
    }
  };

  const askWithDefault = async (question, defaultVal) => {
    const answer = await ask(question);
    if (answer === null) return null;
    return answer.toLowerCase() === 'default' ? String(defaultVal) : answer;
  };

  const askButtons = async (question, buttons) => {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        buttons.slice(i, i + 5).map(b =>
          new ButtonBuilder()
            .setCustomId(`setup_${b.id}`)
            .setLabel(b.label)
            .setStyle(b.style || ButtonStyle.Primary)
        )
      ));
    }
    const msg = await dm.send({ content: question, components: rows });
    try {
      const btnInt = await msg.awaitMessageComponent({ filter: i => i.user.id === userId, time: 120000 });
      await btnInt.update({ components: [] });
      return btnInt.customId.replace('setup_', '');
    } catch {
      await dm.send(TIMEOUT_MSG);
      return null;
    }
  };

  const askMultiButtons = async (question, options) => {
    const selected = new Set();

    const buildRows = () => {
      const rows = [];
      for (let i = 0; i < options.length; i += 4) {
        rows.push(new ActionRowBuilder().addComponents(
          options.slice(i, i + 4).map(o =>
            new ButtonBuilder()
              .setCustomId(`msel_${o.id}`)
              .setLabel((selected.has(o.id) ? '✅ ' : '') + o.label)
              .setStyle(selected.has(o.id) ? ButtonStyle.Success : ButtonStyle.Secondary)
          )
        ));
      }
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('msel_ALL').setLabel('Select All').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('msel_DONE').setLabel('✔ Done').setStyle(ButtonStyle.Success),
      ));
      return rows;
    };

    const msg = await dm.send({ content: question, components: buildRows() });

    return new Promise((resolve) => {
      const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === userId, time: 120000 });

      collector.on('collect', async (btnInt) => {
        const id = btnInt.customId.replace('msel_', '');
        if (id === 'DONE') {
          collector.stop('done');
          await btnInt.update({ components: [] });
          resolve([...selected]);
        } else if (id === 'ALL') {
          options.forEach(o => selected.add(o.id));
          await btnInt.update({ components: buildRows() });
        } else {
          selected.has(id) ? selected.delete(id) : selected.add(id);
          await btnInt.update({ components: buildRows() });
        }
      });

      collector.on('end', (_, reason) => {
        if (reason !== 'done') {
          dm.send(TIMEOUT_MSG);
          resolve(null);
        }
      });
    });
  };

  const pickFromList = async (question, items, idPrefix, labelFn) => {
    if (items.length === 0) return null;
    if (items.length <= 25) {
      const rows = [];
      for (let i = 0; i < items.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
          items.slice(i, i + 5).map(item =>
            new ButtonBuilder()
              .setCustomId(`${idPrefix}_${item.id}`)
              .setLabel(labelFn(item))
              .setStyle(ButtonStyle.Secondary)
          )
        ));
      }
      const msg = await dm.send({ content: question, components: rows });
      try {
        const btnInt = await msg.awaitMessageComponent({ filter: i => i.user.id === userId, time: 120000 });
        await btnInt.update({ components: [] });
        return items.find(item => item.id === btnInt.customId.replace(`${idPrefix}_`, ''));
      } catch {
        await dm.send(TIMEOUT_MSG);
        return null;
      }
    } else {
      // Numbered text fallback for >25 items
      const lines = items.map((item, i) => `\`${i + 1}\` — ${labelFn(item)}`).join('\n');
      await dm.send(`${question}\n\n${lines}`);
      try {
        const col = await dm.awaitMessages({ filter: m => m.author.id === userId && !m.author.bot, max: 1, time: 120000, errors: ['time'] });
        const idx = parseInt(col.first().content.trim()) - 1;
        if (isNaN(idx) || idx < 0 || idx >= items.length) {
          await dm.send('❌ Invalid selection. Run `/setup` again to restart.');
          return null;
        }
        return items[idx];
      } catch {
        await dm.send(TIMEOUT_MSG);
        return null;
      }
    }
  };

  const pickChannel = (question, channels) => pickFromList(question, channels, 'ch', c => '#' + c.name);
  const pickRole    = (question, roles)    => pickFromList(question, roles,    'role', r => '@' + r.name);

  // ── Fetch guild resources ─────────────────────────────────────────────────
  try {
  const textChannels = [...guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText)
    .sort((a, b) => a.name.localeCompare(b.name))
    .values()];

  const roles = [...guild.roles.cache
    .filter(r => !r.managed && r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .values()];

  // ── League Info ───────────────────────────────────────────────────────────
  const leagueName = await ask('**[League 1/3]** What is your league name?\nExample: CMR Dynasty');
  if (!leagueName) return;

  const leagueAbbr = await ask(
    '**[League 2/3]** What is your league abbreviation or keyword?\n' +
    'Example: `CMR`\n\n' +
    '📡 **Wamellow note:** This keyword is used to filter stream titles. ' +
    'Wamellow will only autopost streams whose title contains this abbreviation — ' +
    'make sure your coaches include it in their stream titles.'
  );
  if (!leagueAbbr) return;

  // ── League Type ───────────────────────────────────────────────────────────
  const leagueType = await askButtons(
    '**[League 3/3]** What best describes your league?',
    [
      { id: 'new',         label: '🆕 New League',         style: ButtonStyle.Primary },
      { id: 'established', label: '🏛️ Established League', style: ButtonStyle.Secondary },
    ]
  );
  if (!leagueType) return;

  // ── Established League: capture current season + week ────────────────────
  let initialMeta = { season: 1, week: 1, current_phase: 'preseason', current_sub_phase: 0 };
  if (leagueType === 'established') {
    const seasonStr = await ask(
      '**[League 4/?]** What season is your league currently in?\nExample: `3`'
    );
    if (!seasonStr) return;
    const season = parseInt(seasonStr);
    if (isNaN(season) || season < 1) {
      await dm.send('❌ Invalid season number. Run `/setup` again.');
      return;
    }

    const phaseGroup = await askButtons(
      '**[League 5/?]** What phase is the league currently in?',
      [
        { id: 'preseason',  label: 'Preseason',               style: ButtonStyle.Secondary },
        { id: 'regular',    label: 'Regular Season',          style: ButtonStyle.Primary },
        { id: 'conf_champ', label: 'Conference Championship', style: ButtonStyle.Secondary },
        { id: 'bowl',       label: 'Bowl Season',             style: ButtonStyle.Secondary },
        { id: 'offseason',  label: 'Offseason (post-bowl)',   style: ButtonStyle.Secondary },
      ]
    );
    if (!phaseGroup) return;

    let currentWeek = 1;
    let currentSub  = 0;
    let phaseKey    = phaseGroup;

    if (phaseGroup === 'regular') {
      let validWeek = false;
      while (!validWeek) {
        const weekStr = await ask('**[League 6/?]** What week of the regular season? (0–14)\nExample: `8`');
        if (!weekStr) return;
        const parsed = parseInt(weekStr);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 14) {
          currentWeek = parsed;
          currentSub  = parsed;
          validWeek   = true;
        } else {
          await dm.send('❌ Please enter a number between 0 and 14.');
        }
      }

    } else if (phaseGroup === 'bowl') {
      const bowlChoice = await askButtons(
        '**[League 6/?]** Which bowl week?',
        [
          { id: '0', label: 'Bowl Week 1',           style: ButtonStyle.Secondary },
          { id: '1', label: 'Bowl Week 2',           style: ButtonStyle.Secondary },
          { id: '2', label: 'Semifinals',            style: ButtonStyle.Secondary },
          { id: '3', label: 'National Championship', style: ButtonStyle.Primary },
        ]
      );
      if (!bowlChoice) return;
      currentSub = parseInt(bowlChoice);

    } else if (phaseGroup === 'offseason') {
      const offChoice = await askButtons(
        '**[League 6/?]** Which offseason phase?',
        [
          { id: 'players_leaving',     label: 'Players Leaving',  style: ButtonStyle.Secondary },
          { id: 'transfer_portal',     label: 'Transfer Portal',  style: ButtonStyle.Secondary },
          { id: 'position_changes',    label: 'Position Changes', style: ButtonStyle.Secondary },
          { id: 'training_results',    label: 'Training Results', style: ButtonStyle.Secondary },
        ]
      );
      if (!offChoice) return;
      phaseKey = offChoice;

      if (offChoice === 'transfer_portal') {
        const transferChoice = await askButtons(
          '**[League 7/?]** Which transfer week?',
          [
            { id: '0', label: 'Transfer Week 1', style: ButtonStyle.Secondary },
            { id: '1', label: 'Transfer Week 2', style: ButtonStyle.Secondary },
            { id: '2', label: 'Transfer Week 3', style: ButtonStyle.Secondary },
            { id: '3', label: 'Transfer Week 4', style: ButtonStyle.Secondary },
          ]
        );
        if (!transferChoice) return;
        currentSub = parseInt(transferChoice);
      }
    }
    // preseason / conf_champ: phaseKey already set, sub stays 0

    // Derive week: regular = sub+1, preseason = 1, bowl/offseason = 17 (post-regular-season)
    const derivedWeek = phaseKey === 'regular'   ? currentSub + 1
                      : phaseKey === 'preseason'  ? 1
                      : 17; // bowl / offseason — assume regular season finished at week 17

    initialMeta = {
      season:            season,
      week:              derivedWeek,
      current_phase:     phaseKey,
      current_sub_phase: currentSub,
    };
  }

  // ── Group-Based Feature Selection ────────────────────────────────────────

  // Helper: ask about one feature group — Enable All / Disable All / Customize
  const askGroupFeatures = async (groupLabel, groupEmoji, commands) => {
    const choice = await askButtons(
      `${groupEmoji} **${groupLabel}**\nEnable this feature group?\nIncludes: ${commands.map(c => c.label).join(', ')}`,
      [
        { id: 'all',    label: '✅ Enable All',  style: ButtonStyle.Success },
        { id: 'none',   label: '❌ Disable All', style: ButtonStyle.Danger },
        { id: 'custom', label: '🔧 Customize',   style: ButtonStyle.Secondary },
      ]
    );
    if (!choice) return null;
    if (choice === 'all')  return commands.map(c => c.id);
    if (choice === 'none') return [];
    return await askMultiButtons(
      `🔧 **${groupLabel} — Customize**\nSelect which commands to enable:`,
      commands
    );
  };

  await dm.send('**— Feature Setup —**\nConfigure each feature group one at a time. Nothing is on by default — enable only what you need.');

  const gameDayCmds = [
    { label: 'Game Result',           id: 'feature_game_result' },
    { label: 'Any Game Result',       id: 'feature_any_game_result' },
    { label: 'Ranking',               id: 'feature_ranking' },
    { label: 'All-Time Ranking',      id: 'feature_ranking_all_time' },
    { label: 'Game Results Reminder', id: 'feature_game_results_reminder' },
  ];
  const teamCmds = [
    { label: 'Job Offers',  id: 'feature_job_offers' },
    { label: 'Assign Team', id: 'feature_assign_team' },
    { label: 'Reset Team',  id: 'feature_reset_team' },
    { label: 'List Teams',  id: 'feature_list_teams' },
    { label: 'Move Coach',  id: 'feature_move_coach' },
  ];
  const advanceCmds = [
    { label: 'Advance', id: 'feature_advance' },
  ];
  const streamingCmds = [
    { label: 'Streamer Register', id: 'feature_stream_autopost' },
    { label: 'Streamer List',     id: 'feature_streaming_list' },
  ];

  if (leagueType === 'established') await dm.send('💡 **Game Day — Recommendation:** Enable this if you want coaches to record game results. You can always turn it on later via `/config features`.');
  const gameDayEnabled   = await askGroupFeatures('Game Day',           '🏈', gameDayCmds);
  if (gameDayEnabled === null) return;
  if (leagueType === 'established') await dm.send('💡 **Team Selection — Recommendation:** Enable **Assign Team** to map existing coaches to their teams directly. You likely won\'t need Job Offers unless you\'re still growing.');
  else await dm.send('💡 **Team Selection — Recommendation:** Enable **Job Offers** so coaches can request and accept teams through the bot.');
  const teamEnabled      = await askGroupFeatures('Team Selection',     '👥', teamCmds);
  if (teamEnabled === null) return;
  const advanceEnabled   = await askGroupFeatures('Advance Management', '📅', advanceCmds);
  if (advanceEnabled === null) return;
  const streamingEnabled = await askGroupFeatures('Autopost Streams (Wamellow)', '📡', streamingCmds);
  if (streamingEnabled === null) return;

  const allEnabled = [...gameDayEnabled, ...teamEnabled, ...advanceEnabled, ...streamingEnabled];

  const features = {
    feature_game_result:           allEnabled.includes('feature_game_result'),
    feature_any_game_result:       allEnabled.includes('feature_any_game_result'),
    feature_ranking:               allEnabled.includes('feature_ranking'),
    feature_ranking_all_time:      allEnabled.includes('feature_ranking_all_time'),
    feature_game_results_reminder: allEnabled.includes('feature_game_results_reminder'),
    feature_job_offers:            allEnabled.includes('feature_job_offers'),
    feature_assign_team:           allEnabled.includes('feature_assign_team'),
    feature_reset_team:            allEnabled.includes('feature_reset_team'),
    feature_list_teams:            allEnabled.includes('feature_list_teams'),
    feature_move_coach:            allEnabled.includes('feature_move_coach'),
    feature_advance:               allEnabled.includes('feature_advance'),
    feature_stream_autopost:       allEnabled.includes('feature_stream_autopost'),
    feature_streaming_list:        allEnabled.includes('feature_streaming_list'),
  };

  // ── Channel Setup ─────────────────────────────────────────────────────────
  const channelConfig = {
    channel_news_feed:       'news-feed',
    channel_signed_coaches:  'signed-coaches',
    channel_team_lists:      'team-lists',
    channel_advance_tracker: 'advance-tracker',
    channel_streaming:       'streaming',
  };

  const needsNewsFeed  = features.feature_ranking || features.feature_ranking_all_time || features.feature_game_result;
  const needsSigned    = features.feature_job_offers || features.feature_assign_team;
  const needsTeamList  = features.feature_list_teams;
  const needsAdvance   = features.feature_advance;
  const needsStreaming = features.feature_game_results_reminder || features.feature_stream_autopost || features.feature_streaming_list;

  if (needsNewsFeed || needsSigned || needsTeamList || needsAdvance || needsStreaming) {
    await dm.send('**— Channel Setup —**\nSelect the channel for each feature group.');

    if (needsNewsFeed) {
      const ch = await pickChannel('📰 **News Feed** — Where should game results and standings post?', textChannels);
      if (!ch) return;
      channelConfig.channel_news_feed = ch.name;
    }
    if (needsSigned) {
      const ch = await pickChannel('✍️ **Signed Coaches** — Where should coach signing announcements post?', textChannels);
      if (!ch) return;
      channelConfig.channel_signed_coaches = ch.name;
    }
    if (needsTeamList) {
      const ch = await pickChannel('📋 **Team Lists** — Where should the available teams list post?', textChannels);
      if (!ch) return;
      channelConfig.channel_team_lists = ch.name;
    }
    if (needsAdvance) {
      const ch = await pickChannel('⏱️ **Advance Tracker** — Where should advance deadline notices post?', textChannels);
      if (!ch) return;
      channelConfig.channel_advance_tracker = ch.name;
    }
    if (needsStreaming) {
      const ch = await pickChannel('🎮 **Streaming** — Which channel should the bot monitor for stream links?', textChannels);
      if (!ch) return;
      channelConfig.channel_streaming = ch.name;
    }
  }

  // ── Role Setup ────────────────────────────────────────────────────────────
  let headCoachRoleName = 'head coach';
  let headCoachRoleId   = null;

  if (roles.length > 0) {
    const skipRoleChoice = await askButtons(
      '**— Role Setup —**\nShould the bot assign a role to head coaches when they are signed?\n\n' +
      'Choose **Pick a Role** to assign an existing role, or **Skip** if your server uses @everyone.',
      [
        { id: 'pick', label: '🎭 Pick a Role', style: ButtonStyle.Primary },
        { id: 'skip', label: '⏭️ Skip (@everyone)', style: ButtonStyle.Secondary },
      ]
    );
    if (!skipRoleChoice) return;

    if (skipRoleChoice === 'pick') {
      const role = await pickRole('Which role should be assigned to head coaches?', roles);
      if (!role) return;
      headCoachRoleName = role.name;
      headCoachRoleId   = role.id;
    }
    // skip → leave defaults ('head coach', null) — bot won't assign a role
  } else {
    await dm.send('⚠️ No roles found. The bot will skip role assignment — coaches will use @everyone.');
  }

  // ── Job Offers Config ─────────────────────────────────────────────────────
  let jobOffersConfig = { star_rating_for_offers: 2.5, star_rating_max_for_offers: null, job_offers_count: 3, job_offers_expiry_hours: 24 };

  if (features.feature_job_offers) {
    await dm.send('**— Job Offers Setup —**\nAnswer the next 4 questions to configure job offers.');

    let starMin;
    while (!starMin) {
      const input = await askWithDefault('**[Job Offers 1/4]** Minimum star rating for job offers? (1.0 – 5.0)\nDefault: 2.5', '2.5');
      if (!input) return;
      const val = parseFloat(input);
      if (!isNaN(val) && val >= 1.0 && val <= 5.0) {
        starMin = input;
      } else {
        await dm.send('❌ Please enter a number between 1.0 and 5.0 (e.g. `2.5`).');
      }
    }

    let starMax;
    while (!starMax) {
      const input = await askWithDefault('**[Job Offers 2/4]** Maximum star rating? Type `none` for no cap.\nDefault: none', 'none');
      if (!input) return;
      if (input.toLowerCase() === 'none') {
        starMax = 'none';
      } else {
        const val = parseFloat(input);
        const minVal = parseFloat(starMin);
        if (!isNaN(val) && val >= minVal && val <= 5.0) {
          starMax = input;
        } else {
          await dm.send(`❌ Please enter a number between ${starMin} and 5.0, or type \`none\` for no cap.`);
        }
      }
    }
    const offersCount = await askWithDefault('**[Job Offers 3/4]** How many offers should each user receive?\nDefault: 3', '3');
    if (!offersCount) return;
    const offersExpiry = await askWithDefault('**[Job Offers 4/4]** How many hours should offers last before expiring? (1–24)\nDefault: 24', '24');
    if (!offersExpiry) return;

    jobOffersConfig = {
      star_rating_for_offers:     parseFloat(starMin) || 2.5,
      star_rating_max_for_offers: starMax.toLowerCase() === 'none' ? null : (parseFloat(starMax) || null),
      job_offers_count:           parseInt(offersCount) || 3,
      job_offers_expiry_hours:    Math.min(24, Math.max(1, parseInt(offersExpiry) || 24)),
    };
  }

  // ── Game Results Reminder Config ──────────────────────────────────────────
  let streamConfig = { stream_reminder_minutes: 45 };

  if (features.feature_game_results_reminder) {
    const mins = await askWithDefault(
      '**— Game Results Reminder Setup —**\nHow many minutes after a game result is submitted should the bot send a reminder?\nDefault: 45', '45'
    );
    if (!mins) return;
    streamConfig = { stream_reminder_minutes: parseInt(mins) || 45 };
  }

  // ── Advance Management Config ─────────────────────────────────────────────
  let advanceConfig = { advance_intervals: '[24, 48]' };

  if (features.feature_advance) {
    const intervalChoices = await askMultiButtons(
      '**— Advance Management Setup —**\nWhich advance intervals (hours) should be available? Select all that apply.',
      [
        { id: '12', label: '12 hours' },
        { id: '24', label: '24 hours' },
        { id: '48', label: '48 hours' },
        { id: '72', label: '72 hours' },
      ]
    );
    if (!intervalChoices) return;
    const selectedIntervals = intervalChoices.length > 0 ? intervalChoices : ['24', '48'];
    advanceConfig = { advance_intervals: JSON.stringify(selectedIntervals.map(Number)) };

    const tzChoices = await askMultiButtons(
      '**— Advance Timezones —**\nWhich timezones should appear on advance deadline posts? Select all that apply.',
      [
        { id: 'ET',   label: '🌴 ET  (New York)'    },
        { id: 'CT',   label: '🐄 CT  (Chicago)'     },
        { id: 'MT',   label: '🏔️ MT  (Denver)'      },
        { id: 'PT',   label: '🌊 PT  (Los Angeles)' },
        { id: 'GMT',  label: '🌐 GMT (London)'      },
        { id: 'AEST', label: '🦘 AEST (Sydney)'     },
        { id: 'NZST', label: '🥝 NZST (Auckland)'  },
      ]
    );
    if (!tzChoices) return;
    const selectedTZ = tzChoices.length > 0 ? tzChoices : ['ET', 'CT', 'MT', 'PT'];
    advanceConfig.advance_timezones = JSON.stringify(selectedTZ);
  }

  // ── Save Config ───────────────────────────────────────────────────────────
  try {
    await createDefaultConfig(guildId, leagueName);
    await setMeta(guildId, initialMeta);
    await saveConfig(guildId, {
      league_name:         leagueName,
      league_abbreviation: leagueAbbr,
      ...channelConfig,
      role_head_coach:     headCoachRoleName,
      role_head_coach_id:  headCoachRoleId,
      ...features,
      ...jobOffersConfig,
      ...streamConfig,
      ...advanceConfig,
      setup_complete:      true,
      league_type:         leagueType,
    });

    // ── Summary Embed — group-based display ───────────────────────────────
    const fv = (flag) => features[flag] ? '✅' : '❌';
    const summaryFields = [
      { name: 'League Name',  value: leagueName,                                          inline: true },
      { name: 'Abbreviation', value: leagueAbbr,                                          inline: true },
      { name: 'League Type',  value: leagueType === 'new' ? '🆕 New League' : '🏛️ Established League', inline: true },
      {
        name: '🏈 Game Day',
        value:
          `${fv('feature_game_result')} Game Result  ${fv('feature_any_game_result')} Any Game Result\n` +
          `${fv('feature_ranking')} Ranking  ${fv('feature_ranking_all_time')} All-Time Ranking\n` +
          `${fv('feature_game_results_reminder')} Game Results Reminder`,
        inline: false,
      },
      {
        name: '👥 Team Selection',
        value:
          `${fv('feature_job_offers')} Job Offers  ${fv('feature_assign_team')} Assign Team\n` +
          `${fv('feature_reset_team')} Reset Team  ${fv('feature_list_teams')} List Teams\n` +
          `${fv('feature_move_coach')} Move Coach`,
        inline: false,
      },
      {
        name: '📅 Advance Management',
        value: `${fv('feature_advance')} Advance`,
        inline: false,
      },
      {
        name: '📡 Autopost Streams (Wamellow)',
        value: `${fv('feature_stream_autopost')} Streamer Register  ${fv('feature_streaming_list')} Streamer List`,
        inline: false,
      },
      { name: '\u200b', value: '\u200b', inline: false },
    ];

    if (needsNewsFeed)  summaryFields.push({ name: 'News Feed',       value: '#' + channelConfig.channel_news_feed,       inline: true });
    if (needsSigned)    summaryFields.push({ name: 'Signed Coaches',  value: '#' + channelConfig.channel_signed_coaches,  inline: true });
    if (needsTeamList)  summaryFields.push({ name: 'Team Lists',      value: '#' + channelConfig.channel_team_lists,      inline: true });
    if (needsAdvance)   summaryFields.push({ name: 'Advance Tracker', value: '#' + channelConfig.channel_advance_tracker, inline: true });
    if (needsStreaming) summaryFields.push({ name: 'Streaming',       value: '#' + channelConfig.channel_streaming,       inline: true });
    summaryFields.push({ name: 'Head Coach Role', value: headCoachRoleId ? `@${headCoachRoleName}` : '@everyone (no role assigned)', inline: true });
    summaryFields.push({ name: '\u200b', value: '\u200b', inline: true });

    if (features.feature_job_offers) {
      summaryFields.push(
        { name: 'Min Star Rating', value: jobOffersConfig.star_rating_for_offers + ' stars',                                                             inline: true },
        { name: 'Max Star Rating', value: jobOffersConfig.star_rating_max_for_offers ? jobOffersConfig.star_rating_max_for_offers + ' stars' : 'No cap', inline: true },
        { name: 'Offers Per User', value: String(jobOffersConfig.job_offers_count),                                                                      inline: true },
        { name: 'Offer Expiry',    value: jobOffersConfig.job_offers_expiry_hours + ' hrs',                                                              inline: true },
      );
    }
    if (features.feature_job_offers) {
      summaryFields.push({ name: '💡 Offers Config', value: 'Use `/offers-config` after setup to control conference balancing, weighting, and whitelists/blacklists.', inline: false });
    }
    if (features.feature_game_results_reminder) summaryFields.push({ name: 'Results Reminder',  value: streamConfig.stream_reminder_minutes + ' min', inline: true });
    if (features.feature_advance)               summaryFields.push({ name: 'Advance Intervals', value: advanceConfig.advance_intervals,               inline: true });

    const embed = new EmbedBuilder()
      .setTitle('✅ Setup Complete!')
      .setColor(0x00ff00)
      .setDescription('Your league is configured! Use `/config view` to review or `/config edit` to change anything.')
      .addFields(summaryFields);

    await dm.send({ embeds: [embed] });
  } catch (err) {
    console.error('[setup] Error saving config:', err);
    await dm.send(`❌ Setup failed: ${err.message}`);
  }
  } catch (err) {
    console.error('[setup] Unexpected error:', err);
    await dm.send(`❌ **Setup Failed — Unexpected Error**\n\`${err.message}\`\n\nPlease try running \`/setup\` again.`).catch(() => {});
  }
}

// /streamer ──────────────────────────────────────────
async function handleStreaming(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  const sub    = interaction.options.getSubcommand();

  if (!config.setup_complete) return replySetupRequired(interaction);
  const featureEnabled = sub === 'register' ? config.feature_stream_autopost : config.feature_streaming_list;
  if (!featureEnabled) {
    return interaction.editReply({ content: `❌ **${sub === 'register' ? 'Streamer Registration' : 'Streamer List'} Disabled**\nThis feature is turned off. An admin can enable it with \`/config features\`.` });
  }

  if (sub === 'register') {
    const platform = interaction.options.getString('platform', true);
    const handle   = interaction.options.getString('handle', true).trim().replace(/^@/, '');

    if (!handle) {
      return interaction.editReply('❌ **Invalid Handle**\nPlease enter your username without spaces (e.g. `johndoe`).');
    }

    try {
      // Store platform + handle. stream_url column reused to store the handle,
      // platform column stores 'twitch' or 'youtube'.
      await setCoachStream(interaction.guildId, interaction.user.id, handle, platform);
      const platformLabel = platform === 'twitch' ? 'Twitch' : 'YouTube';
      await interaction.editReply(
        `✅ **Streamer Registered!**\n` +
        `Platform: **${platformLabel}**\nHandle: **${handle}**\n\n` +
        `Admins can run \`/streamer list\` to see all registered coaches.`
      );
    } catch (err) {
      console.error('[streamer register] Error:', err);
      await interaction.editReply(`❌ **Failed to save handle**\nDatabase error: ${err.message}`);
    }
    return;
  }

  if (sub === 'list') {
    let streamers;
    try {
      streamers = await getAllStreamers(interaction.guildId);
    } catch (err) {
      return interaction.editReply(`❌ **Database Error**\nCouldn't load streamers: ${err.message}`);
    }

    if (streamers.length === 0) {
      return interaction.editReply('No coaches have registered a stream handle yet.');
    }

    // Build rows: Discord display name + platform + handle
    const rows = streamers.map(entry => {
      const member   = interaction.guild.members.cache.get(entry.user_id);
      const discName = member?.displayName ?? `Unknown (${entry.user_id})`;
      const platform = entry.platform === 'youtube' ? 'YouTube' : 'Twitch';
      return { discName, platform, handle: entry.stream_url };
    });

    // Pad columns for alignment
    const nameLen     = Math.max('Coach'.length,    ...rows.map(r => r.discName.length));
    const platformLen = Math.max('Platform'.length, ...rows.map(r => r.platform.length));
    const handleLen   = Math.max('Handle'.length,   ...rows.map(r => r.handle.length));

    const pad = (str, len) => str.padEnd(len);
    const header  = `${pad('Coach', nameLen)}  ${pad('Platform', platformLen)}  Handle`;
    const divider = `${'-'.repeat(nameLen)}  ${'-'.repeat(platformLen)}  ${'-'.repeat(handleLen)}`;
    const tableLines = rows.map(r =>
      `${pad(r.discName, nameLen)}  ${pad(r.platform, platformLen)}  ${r.handle}`
    );
    const table = [header, divider, ...tableLines].join('\n');

    const block = '```\n' + table + '\n```';
    if (block.length <= 2000) {
      await interaction.editReply({ content: `**Streamers (${rows.length})**\n${block}` });
    } else {
      await interaction.editReply({ content: `**Streamers (${rows.length})** — copy the table below:` });
      let chunk = '```\n' + header + '\n' + divider + '\n';
      for (const line of tableLines) {
        if ((chunk + line + '\n```').length > 2000) {
          await interaction.followUp({ content: chunk + '```', flags: 64 });
          chunk = '```\n';
        }
        chunk += line + '\n';
      }
      if (chunk !== '```\n') await interaction.followUp({ content: chunk + '```', flags: 64 });
    }
    return;
  }
}

// /config view ────────────────────────────────────────
async function handleConfigView(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${config.league_name} — Bot Configuration`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(
      { name: '📌 League',       value: config.league_name,                     inline: true },
      { name: '🔤 Abbreviation', value: config.league_abbreviation || 'Not set', inline: true },
      { name: '🆔 Guild ID',     value: config.guild_id,                         inline: true },
      { name: '\u200b',          value: '\u200b',                                 inline: true },
      { name: '🔧 Features', value:
        `🏈 ${config.feature_game_result ? '✅' : '❌'} Game Result  ${config.feature_any_game_result ? '✅' : '❌'} Any Game Result\n` +
        `${config.feature_ranking ? '✅' : '❌'} Ranking  ${config.feature_ranking_all_time ? '✅' : '❌'} All-Time  ${config.feature_game_results_reminder ? '✅' : '❌'} Reminder\n` +
        `👥 ${config.feature_job_offers ? '✅' : '❌'} Job Offers  ${config.feature_assign_team ? '✅' : '❌'} Assign  ${config.feature_reset_team ? '✅' : '❌'} Reset  ${config.feature_list_teams ? '✅' : '❌'} List  ${config.feature_move_coach ? '✅' : '❌'} Move\n` +
        `📅 ${config.feature_advance ? '✅' : '❌'} Advance\n` +
        `📡 ${config.feature_stream_autopost ? '✅' : '❌'} Streamer Register  ${config.feature_streaming_list ? '✅' : '❌'} Streamer List`,
        inline: false },
      { name: '📺 Channels', value:
        `News Feed: \`${config.channel_news_feed}\`\n` +
        `Advance Tracker: \`${config.channel_advance_tracker}\`\n` +
        `Team Lists: \`${config.channel_team_lists}\`\n` +
        `Signed Coaches: \`${config.channel_signed_coaches}\`\n` +
        `Streaming: \`${config.channel_streaming}\``,
        inline: true },
      { name: '🎮 Settings', value:
        `Min Star Rating: \`${config.star_rating_for_offers}\`\n` +
        `Max Star Rating: \`${config.star_rating_max_for_offers || 'No cap'}\`\n` +
        `Job Offers Count: \`${config.job_offers_count}\`\n` +
        `Offers Expire: \`${config.job_offers_expiry_hours}hrs\`\n` +
        `Results Reminder: \`${config.stream_reminder_minutes} min\`\n` +
        `Advance Intervals: \`${config.advance_intervals}\`\n` +
        `Timezones: \`${(config.advance_timezones_parsed || ['ET','CT','MT','PT']).join(', ')}\` — change with \`/config timezones\``,
        inline: true },
    );
  await interaction.editReply({ embeds: [embed] });
}

// /config features ────────────────────────────────────
// Feature groups definition (shared by /config features handler + select menu handler)
const FEATURE_GROUPS = [
  {
    key:   'game_day',
    label: '🏈 Game Day',
    commands: [
      { id: 'feature_game_result',           label: 'Game Result',           desc: 'Coaches submit their own game results' },
      { id: 'feature_any_game_result',        label: 'Any Game Result',       desc: 'Admin enters results for any two teams' },
      { id: 'feature_ranking',               label: 'Ranking',               desc: 'Season standings' },
      { id: 'feature_ranking_all_time',      label: 'All-Time Ranking',      desc: 'All-time win/loss records' },
      { id: 'feature_game_results_reminder', label: 'Results Reminder',      desc: 'Reminder to submit result after streaming' },
    ],
  },
  {
    key:   'team_selection',
    label: '👥 Team Selection',
    commands: [
      { id: 'feature_job_offers',   label: 'Job Offers',  desc: 'Coaches request job offers via DM' },
      { id: 'feature_assign_team',  label: 'Assign Team', desc: 'Admin manually assigns a team' },
      { id: 'feature_reset_team',   label: 'Reset Team',  desc: 'Admin removes a coach from their team' },
      { id: 'feature_list_teams',   label: 'List Teams',  desc: 'Post team availability list' },
      { id: 'feature_move_coach',   label: 'Move Coach',  desc: 'Admin moves a coach to a different team' },
    ],
  },
  {
    key:   'advance',
    label: '📅 Advance Management',
    commands: [
      { id: 'feature_advance', label: 'Advance', desc: 'Advance to next week/phase — season rolls over automatically' },
    ],
  },
  {
    key:   'autopost_streams',
    label: '📡 Autopost Streams (Wamellow)',
    commands: [
      { id: 'feature_stream_autopost',  label: 'Streamer Register', desc: 'Store handle for use with Wamellow' },
      { id: 'feature_streaming_list',   label: 'Streamer List',   desc: '/streamer list for Wamellow' },
    ],
  },
];

async function handleConfigFeatures(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config  = await getConfig(interaction.guildId);
  const guildId = interaction.guildId;

  // Build one row of buttons per group showing current on/off state
  const buildGroupRows = (currentConfig) => {
    const rows = [];
    for (const group of FEATURE_GROUPS) {
      const allOn  = group.commands.every(c => !!currentConfig[c.id]);
      const allOff = group.commands.every(c => !currentConfig[c.id]);
      const status = allOn ? '✅' : allOff ? '❌' : '🔧';
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg_grp_${guildId}_${group.key}`)
          .setLabel(`${status} ${group.label}`)
          .setStyle(allOn ? ButtonStyle.Success : allOff ? ButtonStyle.Danger : ButtonStyle.Secondary),
      ));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cfg_grp_${guildId}_done`)
        .setLabel('✔ Done')
        .setStyle(ButtonStyle.Primary),
    ));
    return rows;
  };

  const msg = await interaction.editReply({
    content: '**⚙️ Feature Groups**\nClick a group to toggle all commands in it, or customize individual commands.\n✅ = all on · ❌ = all off · 🔧 = mixed',
    components: buildGroupRows(config),
  });

  // Collector listens for group button clicks
  const collector = msg.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time:   120000,
  });

  let currentConfig = { ...config };

  collector.on('collect', async (btnInt) => {
    const id = btnInt.customId.replace(`cfg_grp_${guildId}_`, '');

    if (id === 'done') {
      collector.stop('done');
      await btnInt.update({ content: '✅ **Features saved!**', components: [] });
      return;
    }

    const group = FEATURE_GROUPS.find(g => g.key === id);
    if (!group) return;

    // Show customize UI for this group
    const allOn = group.commands.every(c => !!currentConfig[c.id]);

    const buildCmdRows = () => {
      const rows = [];
      for (let i = 0; i < group.commands.length; i += 4) {
        rows.push(new ActionRowBuilder().addComponents(
          group.commands.slice(i, i + 4).map(cmd =>
            new ButtonBuilder()
              .setCustomId(`cfg_cmd_${guildId}_${cmd.id}`)
              .setLabel((currentConfig[cmd.id] ? '✅ ' : '❌ ') + cmd.label)
              .setStyle(currentConfig[cmd.id] ? ButtonStyle.Success : ButtonStyle.Secondary)
          )
        ));
      }
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg_cmd_${guildId}_ALL_ON`)
          .setLabel('Enable All')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cfg_cmd_${guildId}_ALL_OFF`)
          .setLabel('Disable All')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`cfg_cmd_${guildId}_BACK`)
          .setLabel('← Back')
          .setStyle(ButtonStyle.Primary),
      ));
      return rows;
    };

    const cmdLines = group.commands.map(c => `${currentConfig[c.id] ? '✅' : '❌'} **${c.label}** — ${c.desc}`).join('\n');
    await btnInt.update({
      content: `**${group.label}**\n${cmdLines}`,
      components: buildCmdRows(),
    });

    // Inner collector for this group's command toggles
    const innerCollector = msg.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time:   120000,
    });

    innerCollector.on('collect', async (inner) => {
      const innerId = inner.customId.replace(`cfg_cmd_${guildId}_`, '');

      if (innerId === 'BACK') {
        innerCollector.stop('back');
        // Save changes then return to group view
        const updates = Object.fromEntries(group.commands.map(c => [c.id, !!currentConfig[c.id]]));
        await saveConfig(guildId, updates);
        await inner.update({
          content: '**⚙️ Feature Groups**\nClick a group to toggle all commands in it, or customize individual commands.\n✅ = all on · ❌ = all off · 🔧 = mixed',
          components: buildGroupRows(currentConfig),
        });
        return;
      }

      if (innerId === 'ALL_ON') {
        group.commands.forEach(c => { currentConfig[c.id] = true; });
      } else if (innerId === 'ALL_OFF') {
        group.commands.forEach(c => { currentConfig[c.id] = false; });
      } else {
        // Toggle individual command
        const cmd = group.commands.find(c => c.id === innerId);
        if (cmd) currentConfig[cmd.id] = !currentConfig[cmd.id];
      }

      const updatedLines = group.commands.map(c => `${currentConfig[c.id] ? '✅' : '❌'} **${c.label}** — ${c.desc}`).join('\n');
      await inner.update({
        content: `**${group.label}**\n${updatedLines}`,
        components: buildCmdRows(),
      });
    });

    innerCollector.on('end', (_, reason) => {
      if (reason !== 'back') {
        // Save on timeout too
        const updates = Object.fromEntries(group.commands.map(c => [c.id, !!currentConfig[c.id]]));
        saveConfig(guildId, updates).catch(console.error);
      }
    });
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'done') {
      // Save everything on timeout and clean up buttons
      const allFlags = FEATURE_GROUPS.flatMap(g => g.commands.map(c => c.id));
      const updates  = Object.fromEntries(allFlags.map(f => [f, !!currentConfig[f]]));
      await saveConfig(guildId, updates).catch(console.error);
      await interaction.editReply({ components: [] }).catch(() => {});
    }
  });
}

// /config edit ────────────────────────────────────────
async function handleConfigEdit(interaction) {
  await interaction.deferReply({ flags: 64 });
  const setting = interaction.options.getString('setting');
  const value   = interaction.options.getString('value');
  const allowed = [
    'league_name', 'league_abbreviation', 'channel_news_feed', 'channel_advance_tracker',
    'channel_team_lists', 'channel_signed_coaches', 'channel_streaming', 'role_head_coach',
    'star_rating_for_offers', 'star_rating_max_for_offers', 'job_offers_count',
    'job_offers_expiry_hours', 'stream_reminder_minutes', 'advance_intervals',
    'embed_color_primary', 'embed_color_win', 'embed_color_loss',
  ];
  if (!allowed.includes(setting)) {
    return interaction.editReply({ content: `❌ **Unknown Setting: \`${setting}\`**\nUse the autocomplete dropdown when typing the setting name, or run \`/config view\` to see all available settings.` });
  }
  try {
    await saveConfig(interaction.guildId, { [setting]: value });
    await interaction.editReply({ content: `✅ Updated **${setting}** to \`${value}\`` });
  } catch (err) {
    await interaction.editReply({ content: `❌ **Failed to Save Setting**\nDatabase error: ${err.message}\n\nTry running \`/config reload\` then attempt the edit again. If this keeps happening, check your Supabase connection.` });
  }
}

// /config timezones ─────────────────────────────────────
async function handleConfigTimezones(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  const TZ_OPTIONS = [
    { id: 'ET',   label: '🌴 ET  (New York)'    },
    { id: 'CT',   label: '🐄 CT  (Chicago)'     },
    { id: 'MT',   label: '🏔️ MT  (Denver)'      },
    { id: 'PT',   label: '🌊 PT  (Los Angeles)' },
    { id: 'GMT',  label: '🌐 GMT (London)'      },
    { id: 'AEST', label: '🦘 AEST (Sydney)'     },
    { id: 'NZST', label: '🥝 NZST (Auckland)'  },
  ];

  const current = config.advance_timezones_parsed || ['ET','CT','MT','PT'];
  const selected = new Set(current);

  const buildRows = () => {
    const rows = [];
    for (let i = 0; i < TZ_OPTIONS.length; i += 4) {
      rows.push(new ActionRowBuilder().addComponents(
        TZ_OPTIONS.slice(i, i + 4).map(tz =>
          new ButtonBuilder()
            .setCustomId(`tz_${tz.id}`)
            .setLabel((selected.has(tz.id) ? '✅ ' : '') + tz.label)
            .setStyle(selected.has(tz.id) ? ButtonStyle.Success : ButtonStyle.Secondary)
        )
      ));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tz_DONE').setLabel('✔ Save').setStyle(ButtonStyle.Primary),
    ));
    return rows;
  };

  const msg = await interaction.editReply({
    content: '📡 **Advance Timezones**\nToggle which timezones appear on advance deadline posts, then click **Save**.',
    components: buildRows(),
  });

  const collector = msg.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time: 120000,
  });

  collector.on('collect', async btn => {
    const id = btn.customId.replace('tz_', '');
    if (id === 'DONE') {
      collector.stop('done');
      const finalTZs = [...selected];
      if (finalTZs.length === 0) {
        await btn.update({ content: '❌ You must select at least one timezone.', components: buildRows() });
        return;
      }
      await saveConfig(guildId, { advance_timezones: JSON.stringify(finalTZs) });
      guildConfigs.delete(guildId);
      const labels = finalTZs.map(k => TZ_OPTIONS.find(t => t.id === k)?.label || k).join(', ');
      await btn.update({ content: `✅ **Timezones saved:** ${labels}`, components: [] });
    } else {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      await btn.update({ components: buildRows() });
    }
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'done') {
      await interaction.editReply({ content: '⏰ Timed out — timezones not saved.', components: [] }).catch(() => {});
    }
  });
}

// /config reload ──────────────────────────────────────
async function handleConfigReload(interaction) {
  await interaction.deferReply({ flags: 64 });
  guildConfigs.delete(interaction.guildId);
  const config = await loadGuildConfig(interaction.guildId);
  await interaction.editReply({ content: `✅ Config reloaded for **${config.league_name}**!` });
}

// /joboffers ──────────────────────────────────────────
async function handleJobOffers(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  await interaction.deferReply({ flags: 64 });
  const config  = await getConfig(guildId);

  if (!config.setup_complete) return replySetupRequired(interaction);
  if (!config.feature_job_offers || !config.feature_assign_team) {
    return interaction.editReply({ content: '❌ **Job Offers Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const currentTeam = await getTeamByUser(userId, guildId);
  if (currentTeam) {
    return interaction.editReply({
      content: `❌ **Already Assigned**\nYou are already the head coach of **${currentTeam.team_name}**. Job offers are only available to coaches without a team.\n\nIf this is a mistake, ask an admin to run \`/resetteam\` to remove your current assignment.`,
    });
  }

  const now = new Date();

  // Check for existing active offers and resend
  const { data: existingOffers } = await supabase
    .from('job_offers')
    .select('*, teams(team_name, star_rating, conference)')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .gt('expires_at', now.toISOString());

  if (existingOffers && existingOffers.length > 0) {
    return sendOffersAsDM(interaction, existingOffers, config, guildId, true);
  }

  // Find locked (in other users' active offers) and already-assigned teams
  const { data: lockedRows }    = await supabase.from('job_offers').select('team_id').eq('guild_id', guildId).gt('expires_at', now.toISOString());
  const { data: assignedRows }  = await supabase.from('team_assignments').select('team_id').eq('guild_id', guildId);

  const locked    = (lockedRows    || []).map(r => r.team_id);
  const assigned  = (assignedRows  || []).map(r => r.team_id);

  let query = supabase
    .from('teams')
    .select('*')
    .gte('star_rating', config.star_rating_for_offers)
    .neq('conference', 'FCS')
    .limit(200);

  if (config.star_rating_max_for_offers) {
    query = query.lte('star_rating', config.star_rating_max_for_offers);
  }

  const { data: availableJobs } = await query;
  let pool = (availableJobs || []).filter(t => !assigned.includes(t.id) && !locked.includes(t.id));

  // ── Apply conference whitelist / blacklist ────────────────────────────────
  const offerCfg    = await getJobOfferConfig(guildId);
  const whitelist   = await getJobOfferConferences(guildId, 'whitelist');
  const blacklist   = await getJobOfferConferences(guildId, 'blacklist');

  if (whitelist.length > 0) pool = pool.filter(t => whitelist.includes(t.conference));
  if (blacklist.length > 0) pool = pool.filter(t => !blacklist.includes(t.conference));

  if (pool.length === 0) {
    return interaction.editReply({
      content: `❌ **No Available Teams**\nThere are no unassigned teams matching the current offer settings.\n\nPossible reasons:\n• All eligible teams are taken or locked\n• Conference whitelist/blacklist is too restrictive\n• Star rating range is too narrow\n\nAn admin can adjust settings with \`/config edit\` or \`/offers-config\`.`,
    });
  }

  // ── Weighted ratings ──────────────────────────────────────────────────────
  let weightedPool;
  if (offerCfg.weighted_ratings === 'highest') {
    // Weight by star rating — higher rated = more likely
    weightedPool = pool.flatMap(t => Array(Math.round((t.star_rating || 1) * 2)).fill(t));
  } else if (offerCfg.weighted_ratings === 'lowest') {
    // Inverse weight — lower rated = more likely
    const max = Math.max(...pool.map(t => t.star_rating || 1));
    weightedPool = pool.flatMap(t => Array(Math.round((max - (t.star_rating || 1) + 1) * 2)).fill(t));
  } else {
    weightedPool = pool;
  }

  // ── Pick with optional conference rules ───────────────────────────────────
  const count    = config.job_offers_count || 3;
  const shuffled = weightedPool.sort(() => Math.random() - 0.5);
  let picks      = [];
  const usedConfs = new Set();

  for (const t of shuffled) {
    if (picks.find(p => p.id === t.id)) continue; // dedupe from weighting

    if (offerCfg.one_per_conference && usedConfs.has(t.conference)) continue;

    if (offerCfg.conf_balance && usedConfs.has(t.conference) && picks.length < count) {
      // Try to keep going for a different conference
      const remaining = shuffled.filter(s =>
        !picks.find(p => p.id === s.id) && !usedConfs.has(s.conference)
      );
      if (remaining.length > 0) continue;
      // No more unique conferences available — allow duplicate
    }

    picks.push(t);
    usedConfs.add(t.conference);
    if (picks.length >= count) break;
  }

  // Fallback: if strict rules left us short, fill remainder ignoring conf rules
  if (picks.length < count) {
    const remaining = pool.filter(t => !picks.find(p => p.id === t.id))
                          .sort(() => Math.random() - 0.5);
    for (const t of remaining) {
      picks.push(t);
      if (picks.length >= count) break;
    }
  }
  const expiresAt  = new Date(now.getTime() + (config.job_offers_expiry_hours || 48) * 60 * 60 * 1000);

  await supabase.from('job_offers').insert(
    picks.map(t => ({ guild_id: guildId, user_id: userId, team_id: t.id, expires_at: expiresAt.toISOString() }))
  );

  const shaped = picks.map(t => ({ teams: t, expires_at: expiresAt.toISOString(), team_id: t.id }));
  await sendOffersAsDM(interaction, shaped, config, guildId, false);
}

async function sendOffersAsDM(interaction, offers, config, guildId, isExisting) {
  const expiresAt = new Date(offers[0].expires_at);
  const hoursLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60));

  const embed = new EmbedBuilder()
    .setTitle('📋 Your Job Offers')
    .setColor(config.embed_color_primary_int)
    .setDescription(
      isExisting
        ? `You already have active offers. They expire in **${hoursLeft} hour(s)**. Click a button below to accept one.`
        : `Here are your **${offers.length}** offer(s). They expire in **${hoursLeft} hours**. Click a button below to accept one.`
    )
    .addFields(offers.map((o, i) => ({
      name:  `${i + 1}. ${o.teams.team_name}`,
      value: `Rating: ${starRating(o.teams.star_rating || 0)} (${o.teams.star_rating || '?'}⭐)\nConference: ${o.teams.conference || 'Unknown'}`,
      inline: false,
    })))
    .setFooter({ text: 'Offers cannot be refreshed until they expire.' });

  const rows = [];
  for (let i = 0; i < offers.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      offers.slice(i, i + 5).map((o, j) =>
        new ButtonBuilder()
          .setCustomId(`accept-offer_${guildId}_${offers[i + j].team_id}`)
          .setLabel(`Accept: ${o.teams.team_name}`)
          .setStyle(ButtonStyle.Primary)
      )
    ));
  }

  try {
    const dm = await interaction.user.createDM();
    await dm.send({ embeds: [embed], components: rows });
    await interaction.editReply({ content: '📬 Your job offers have been sent to your DMs!' });
  } catch {
    await interaction.editReply({ embeds: [embed], components: rows });
  }
}

async function handleAcceptOffer(interaction) {
  const [, guildId, teamIdStr] = interaction.customId.split('_');
  const teamId = parseInt(teamIdStr);
  const userId = interaction.user.id;

  await interaction.deferUpdate();

  const offerConfig = await getConfig(guildId).catch(() => null);
  if (!offerConfig?.setup_complete) {
    return interaction.followUp({ content: '⚙️ **Setup Required**\nThis server has not been configured yet. Ask an admin to run `/setup`.', flags: 64 });
  }

  const { data: offer } = await supabase
    .from('job_offers')
    .select('*, teams(*)')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('team_id', teamId)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!offer) {
    return interaction.editReply({ content: '❌ **Offer No Longer Available**\nThis offer has either expired or the team was taken by someone else.\n\nRun `/joboffers` in your server to request a fresh set of offers.', components: [], embeds: [] });
  }

  const { data: existing } = await supabase
    .from('team_assignments')
    .select('user_id')
    .eq('guild_id', guildId)
    .eq('team_id', teamId)
    .single();

  if (existing) {
    return interaction.editReply({ content: `❌ **Team Just Taken**\n**${offer.teams.team_name}** was claimed by another coach moments before you accepted.\n\nRun \`/joboffers\` in your server to get a new set of offers.`, components: [], embeds: [] });
  }

  await assignTeam(teamId, userId, guildId);
  await supabase.from('job_offers').delete().eq('guild_id', guildId).eq('user_id', userId);

  const config = await getConfig(guildId);
  const guild  = client.guilds.cache.get(guildId);

  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      const hcRole = await findOrCreateRole(guild, config.role_head_coach);
      try {
        await member.roles.add(hcRole);
      } catch (roleErr) {
        console.error('[roles] Failed to assign head coach role on offer accept:', roleErr.message);
        // Notify in news feed — team assignment still succeeded
        const newsChannel = findTextChannel(guild, config.channel_news_feed);
        if (newsChannel) newsChannel.send({ content: `⚠️ <@${userId}> accepted **${offer.teams.team_name}** but I couldn't assign the **${config.role_head_coach}** role. Check that my role is above it in Server Settings → Roles, or run \`/checkpermissions\`.` });
      }
      if (!config.role_head_coach_id) await saveConfig(guildId, { role_head_coach_id: hcRole.id });
    }
  }

  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Offer Accepted!')
    .setColor(0x00ff00)
    .setDescription(`You are now the Head Coach of **${offer.teams.team_name}**! Welcome to the league.`)
    .addFields(
      { name: 'Team',       value: offer.teams.team_name,               inline: true },
      { name: 'Conference', value: offer.teams.conference || 'Unknown',  inline: true },
      { name: 'Rating',     value: `${starRating(offer.teams.star_rating || 0)} (${offer.teams.star_rating || '?'}⭐)`, inline: true },
    );

  await interaction.editReply({ embeds: [successEmbed], components: [] });

  // ── Prompt for stream handle if feature is enabled ───────────────────────
  if (config.feature_stream_autopost && guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      try {
        const platformRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('stream_platform_twitch').setLabel('Twitch').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('stream_platform_youtube').setLabel('YouTube').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('stream_platform_skip').setLabel('Skip').setStyle(ButtonStyle.Danger),
        );
        const streamPrompt = await member.send({
          content:
            `🎮 **One more thing!** Want to register your stream handle for **${offer.teams.team_name}**?\n` +
            `This lets the bot tag you for game result reminders after your streams.\n\n` +
            `What platform do you stream on?`,
          components: [platformRow],
        });
        const platformBtn = await streamPrompt.awaitMessageComponent({ time: 120000 }).catch(() => null);
        if (platformBtn && platformBtn.customId !== 'stream_platform_skip') {
          const platform = platformBtn.customId === 'stream_platform_twitch' ? 'twitch' : 'youtube';
          await platformBtn.update({ content: `Got it! What is your **${platform === 'twitch' ? 'Twitch' : 'YouTube'}** handle? (just the username, no URL)`, components: [] });
          const handleMsg = await streamPrompt.channel.awaitMessages({ filter: m => m.author.id === userId, max: 1, time: 60000 }).catch(() => null);
          const handle = handleMsg?.first()?.content?.trim().replace(/^@/, '');
          if (handle) {
            await setCoachStream(guildId, userId, handle, platform);
            await member.send(`✅ Stream handle **${handle}** (${platform === 'twitch' ? 'Twitch' : 'YouTube'}) registered! Admins can view all handles with \`/streamer list\`.`);
          }
        } else if (platformBtn) {
          await platformBtn.update({ content: 'No problem — you can register anytime with `/streamer register`.', components: [] });
        }
      } catch {
        // DMs blocked or timed out — silently skip
      }
    }
  }

  if (guild) {
    const signingEmbed = new EmbedBuilder()
      .setTitle(`✍️ Coach Signed — ${offer.teams.team_name}`)
      .setColor(config.embed_color_primary_int)
      .setDescription(`<@${userId}> has accepted the head coaching position at **${offer.teams.team_name}**!`)
      .addFields(
        { name: 'Coach',      value: `<@${userId}>`,                     inline: true },
        { name: 'Team',       value: offer.teams.team_name,              inline: true },
        { name: 'Conference', value: offer.teams.conference || 'Unknown', inline: true },
      )
      .setTimestamp();

    const target = findTextChannel(guild, config.channel_signed_coaches) || findTextChannel(guild, config.channel_news_feed);
    if (target) await target.send({ embeds: [signingEmbed] });

    // Auto-update team list
    await postTeamList(guild, guildId, config).catch(console.error);
  }
}

async function expireJobOffers() {
  const now = new Date().toISOString();
  const { data: expired } = await supabase.from('job_offers').select('*, teams(team_name)').lt('expires_at', now);
  if (!expired || expired.length === 0) return;

  const byUser = {};
  for (const offer of expired) {
    const key = `${offer.guild_id}:${offer.user_id}`;
    if (!byUser[key]) byUser[key] = { guild_id: offer.guild_id, user_id: offer.user_id, teams: [] };
    byUser[key].teams.push(offer.teams?.team_name || 'Unknown');
  }

  for (const { guild_id, user_id, teams } of Object.values(byUser)) {
    try {
      const guild  = client.guilds.cache.get(guild_id);
      if (!guild) continue;
      const config = await getConfig(guild_id);
      if (!config?.setup_complete) continue; // skip guilds that haven't completed setup
      const member = await guild.members.fetch(user_id).catch(() => null);
      if (!member) continue;

      const embed = new EmbedBuilder()
        .setTitle('⏰ Job Offers Expired')
        .setColor(0xff9900)
        .setDescription(
          `Your job offers have expired and the following teams are back in the pool:\n\n` +
          teams.map(t => `• **${t}**`).join('\n') +
          `\n\nRun \`/joboffers\` to request a new set.`
        );

      await member.send({ embeds: [embed] }).catch(() => {
        const newsChannel = findTextChannel(guild, config.channel_news_feed);
        if (newsChannel) newsChannel.send({ content: `<@${user_id}>`, embeds: [embed] });
      });
    } catch (err) {
      // Log per-user errors but always continue — delete still runs below
      console.error(`[expireJobOffers] Error notifying ${user_id}:`, err.message);
    }
  }

  // Always delete expired rows regardless of notification errors above
  try {
    const { error } = await supabase.from('job_offers').delete().lt('expires_at', now);
    if (error) console.error('[expireJobOffers] Delete error:', error.message);
    else console.log(`[expireJobOffers] Removed ${expired.length} expired offer(s).`);
  } catch (err) {
    console.error('[expireJobOffers] Failed to delete expired offers:', err.message);
  }
}

// /game-result ────────────────────────────────────────
async function handleGameResult(interaction) {
  await interaction.deferReply();
  const guildId      = interaction.guildId;
  const config       = await getConfig(guildId);
  if (!config.setup_complete) return replySetupRequired(interaction);
  if (!config.feature_game_result) return interaction.editReply({ content: '❌ Game results are disabled on this server.' });
  const meta         = await getMeta(guildId);
  const opponentName = interaction.options.getString('opponent');
  const yourScore    = interaction.options.getInteger('your-score');
  const oppScore     = interaction.options.getInteger('opponent-score');
  const summary      = interaction.options.getString('summary') || null;
  const userId       = interaction.user.id;

  let yourTeam, oppTeam;
  try {
    yourTeam = await getTeamByUser(userId, guildId);
  } catch (err) {
    return interaction.editReply({ content: `❌ **Database Error**\nCouldn't load your team: ${err.message}\n\nTry again in a moment. If this persists, check your Supabase connection.` });
  }
  if (!yourTeam) {
    return interaction.editReply({ content: "❌ **No Team Assigned**\nYou don't have a team yet. Use `/joboffers` to receive coaching offers, or ask an admin to assign you a team with `/assign-team`." });
  }

  try {
    oppTeam = await getTeamByName(opponentName, guildId);
  } catch (err) {
    return interaction.editReply({ content: `❌ **Database Error**\nCouldn't look up opponent "${opponentName}": ${err.message}` });
  }
  if (!oppTeam) {
    return interaction.editReply({ content: `❌ **Opponent Not Found: \`${opponentName}\`**\nNo team with that name exists in the database. Make sure you selected from the autocomplete dropdown — partial or misspelled names won't match.` });
  }

  const won  = yourScore > oppScore;
  const tied = yourScore === oppScore;

  const yourRecord = await getRecord(yourTeam.id, meta.season, guildId);
  const oppRecord  = await getRecord(oppTeam.id,  meta.season, guildId);

  if (won) {
    yourRecord.wins++;  oppRecord.losses++;
  } else if (!tied) {
    yourRecord.losses++; oppRecord.wins++;
  }

  // Only write records for assigned teams to avoid bloating the DB with unmanaged teams
  await upsertRecord({ ...yourRecord, team_id: yourTeam.id, season: meta.season, guild_id: guildId });
  if (oppTeam.user_id) await upsertRecord({ ...oppRecord, team_id: oppTeam.id, season: meta.season, guild_id: guildId });

  await supabase.from('results').insert({
    guild_id: guildId, season: meta.season, week: meta.week,
    team1_id: yourTeam.id, team2_id: oppTeam.id,
    score1: yourScore, score2: oppScore, submitted_by: userId,
  });

  const result = tied ? 'TIE' : (won ? 'WIN' : 'LOSS');
  const color  = tied ? 0xffa500 : (won ? config.embed_color_win_int : config.embed_color_loss_int);

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Game Result — Season ${meta.season} Week ${meta.week}`)
    .setColor(color)
    .setDescription(`**${yourTeam.team_name}** vs **${oppTeam.team_name}**`)
    .addFields(
      { name: yourTeam.team_name,              value: `${yourScore}`,                              inline: true },
      { name: result,                           value: '—',                                         inline: true },
      { name: oppTeam.team_name,               value: `${oppScore}`,                               inline: true },
      { name: `${yourTeam.team_name} Record`,  value: `${yourRecord.wins}-${yourRecord.losses}`,   inline: true },
      { name: `${oppTeam.team_name} Record`,   value: `${oppRecord.wins}-${oppRecord.losses}`,     inline: true },
    )
    .setFooter({ text: `Submitted by ${interaction.user.displayName}` });

  if (summary) embed.addFields({ name: '📝 Game Summary', value: summary, inline: false });

  await interaction.editReply({ embeds: [embed] });

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }

  // Cancel any pending stream reminder for this user now that they've submitted
  for (const [key, timer] of streamReminderTimers.entries()) {
    if (key.startsWith(`${guildId}-`) && key.endsWith(`-${userId}`)) {
      clearTimeout(timer);
      streamReminderTimers.delete(key);
      console.log(`[stream] Cancelled reminder for ${userId} after submitting result`);
    }
  }
}

// /any-game-result ────────────────────────────────────
async function handleAnyGameResult(interaction) {
  await interaction.deferReply();
  const guildId   = interaction.guildId;
  const config    = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_any_game_result) return interaction.editReply({ content: '❌ Any-game-result is disabled on this server.' });
  const meta      = await getMeta(guildId);
  const team1Name = interaction.options.getString('team1');
  const team2Name = interaction.options.getString('team2');
  const score1    = interaction.options.getInteger('score1');
  const score2    = interaction.options.getInteger('score2');
  const weekInput = interaction.options.getInteger('week');
  const week      = weekInput || meta.week;

  if (weekInput && (weekInput < 1 || weekInput > meta.week)) {
    return interaction.editReply({
      content: `❌ **Invalid Week**\nWeek **${weekInput}** is out of range. The current season is on Week **${meta.week}** — enter a week between 1 and ${meta.week}.`,
    });
  }

  let team1, team2;
  try { team1 = await getTeamByName(team1Name, guildId); }
  catch (err) { return interaction.editReply({ content: `❌ **Database Error**\nCouldn't look up "${team1Name}": ${err.message}` }); }
  try { team2 = await getTeamByName(team2Name, guildId); }
  catch (err) { return interaction.editReply({ content: `❌ **Database Error**\nCouldn't look up "${team2Name}": ${err.message}` }); }

  if (!team1) return interaction.editReply({ content: `❌ **Team Not Found: \`${team1Name}\`**\nNo team with that name exists in the database. Use the autocomplete dropdown to select teams.` });
  if (!team2) return interaction.editReply({ content: `❌ **Team Not Found: \`${team2Name}\`**\nNo team with that name exists in the database. Use the autocomplete dropdown to select teams.` });

  const record1 = await getRecord(team1.id, meta.season, guildId);
  const record2 = await getRecord(team2.id, meta.season, guildId);

  if      (score1 > score2) { record1.wins++;  record2.losses++; }
  else if (score2 > score1) { record2.wins++;  record1.losses++; }

  // Only write records for assigned teams to avoid bloating the DB with unmanaged teams
  if (team1.user_id) await upsertRecord({ ...record1, team_id: team1.id, season: meta.season, guild_id: guildId });
  if (team2.user_id) await upsertRecord({ ...record2, team_id: team2.id, season: meta.season, guild_id: guildId });

  await supabase.from('results').insert({
    guild_id: guildId, season: meta.season, week,
    team1_id: team1.id, team2_id: team2.id,
    score1, score2, submitted_by: interaction.user.id,
  });

  const won1  = score1 > score2;
  const tied  = score1 === score2;
  const color = tied ? 0xffa500 : (won1 ? config.embed_color_win_int : config.embed_color_loss_int);

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Game Result Entered — S${meta.season} W${week}`)
    .setColor(color)
    .addFields(
      { name: team1.team_name,              value: `${score1}`,                          inline: true },
      { name: tied ? 'TIE' : (won1 ? 'WIN' : 'LOSS'), value: '—',                       inline: true },
      { name: team2.team_name,              value: `${score2}`,                          inline: true },
      { name: `${team1.team_name} Record`,  value: `${record1.wins}-${record1.losses}`,  inline: true },
      { name: `${team2.team_name} Record`,  value: `${record2.wins}-${record2.losses}`,  inline: true },
    )
    .setFooter({ text: `Entered by ${interaction.user.displayName} (admin)${weekInput && weekInput !== meta.week ? ` · Backfilled to Week ${week}` : ''}` });

  await interaction.editReply({ embeds: [embed] });

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}

// /ranking ────────────────────────────────────────────
async function handleRanking(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  if (!config.setup_complete) return replySetupRequired(interaction);
  if (!config.feature_ranking) {
    return interaction.editReply({ content: '❌ **Rankings Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const meta = await getMeta(interaction.guildId);
  const { data: records } = await supabase
    .from('records')
    .select('*, teams(team_name, team_assignments(user_id))')
    .eq('guild_id', interaction.guildId)
    .eq('season', meta.season)
    .order('wins', { ascending: false });

  // Filter to only teams currently assigned in this guild
  const assignedRecords = (records || []).filter(r =>
    r.teams?.team_assignments?.some(a => a.user_id)
  );

  if (!assignedRecords || assignedRecords.length === 0) {
    return interaction.editReply({ content: '❌ **No Records Yet**\nNo game results have been submitted for this season. Records will appear here once coaches start submitting results with `/game-result`.' });
  }

  const lines = assignedRecords.map((r, i) =>
    `**${i + 1}.** ${r.teams?.team_name || `Team ${r.team_id}`} — ${r.wins}W - ${r.losses}L`
  );

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Season ${meta.season} Standings`)
    .setColor(config.embed_color_primary_int)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
    await interaction.editReply({ content: `✅ Standings posted in ${newsChannel}!` });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }
}

// /ranking-all-time ───────────────────────────────────
async function handleRankingAllTime(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  if (!config.setup_complete) return replySetupRequired(interaction);
  if (!config.feature_ranking_all_time) return interaction.editReply({ content: '❌ All-time rankings are disabled on this server.' });

  const { data: records } = await supabase
    .from('records')
    .select('team_id, wins, losses, teams(team_name, team_assignments(user_id))')
    .eq('guild_id', interaction.guildId);

  // Filter to only teams currently assigned in this guild
  const assignedRecords = (records || []).filter(r =>
    r.teams?.team_assignments?.some(a => a.user_id)
  );

  if (!assignedRecords || assignedRecords.length === 0) {
    return interaction.editReply({ content: '❌ **No Records Found**\nNo game results exist yet. Records will appear here once coaches submit results with `/game-result`.' });
  }

  const totals = {};
  for (const r of assignedRecords) {
    const name = r.teams?.team_name || r.team_id;
    if (!totals[name]) totals[name] = { wins: 0, losses: 0 };
    totals[name].wins   += r.wins   || 0;
    totals[name].losses += r.losses || 0;
  }

  const lines = Object.entries(totals)
    .sort((a, b) => b[1].wins - a[1].wins)
    .map(([name, rec], i) => {
      const pct = (rec.wins + rec.losses) > 0
        ? ((rec.wins / (rec.wins + rec.losses)) * 100).toFixed(1) : '0.0';
      return `**${i + 1}.** ${name} — ${rec.wins}W - ${rec.losses}L (${pct}%)`;
    });

  const embed = new EmbedBuilder()
    .setTitle('🏆 All-Time Rankings')
    .setColor(config.embed_color_primary_int)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
    await interaction.editReply({ content: `✅ All-time rankings posted in ${newsChannel}!` });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }
}

// /assign-team ────────────────────────────────────────
async function handleAssignTeam(interaction) {
  const guildId  = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const config   = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_assign_team) return interaction.editReply({ content: '❌ Team assignment is disabled on this server.' });
  const guild    = interaction.guild;
  const user     = interaction.options.getUser('user');
  const teamName = interaction.options.getString('team');
  const skipAnn  = interaction.options.getBoolean('skip-announcement') || false;

  let team;
  try { team = await getTeamByName(teamName, guildId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't look up team "${teamName}": ${err.message}`); }
  if (!team) return interaction.editReply(`❌ **Team Not Found: \`${teamName}\`**\nThis team doesn't exist in the global teams database. Make sure you selected from the autocomplete dropdown.\n\nIf the team is missing entirely, it may need to be added to the Supabase \`teams\` table.`);

  if (team.user_id && team.user_id !== user.id) {
    const currentCoach = await guild.members.fetch(team.user_id).catch(() => null);
    return interaction.editReply(`❌ **Team Already Assigned**\n**${team.team_name}** is currently coached by **${currentCoach ? currentCoach.displayName : 'another coach'}** in this league.\n\nTo reassign this team, first run \`/resetteam\` on the current coach, then try \`/assign-team\` again.`);
  }

  const oldTeam = await getTeamByUser(user.id, guildId);
  if (oldTeam) await unassignTeam(oldTeam.id, guildId);

  await assignTeam(team.id, user.id, guildId);

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member) {
    const hcRole = await findOrCreateRole(guild, config.role_head_coach);
    try {
      if (!member.roles.cache.has(hcRole.id)) await member.roles.add(hcRole);
    } catch (roleErr) {
      console.error('[roles] Failed to assign head coach role on assign-team:', roleErr.message);
      await interaction.followUp({ content: `⚠️ Team assigned, but I couldn't add the **${config.role_head_coach}** role to <@${user.id}>. Check that my role is above it in **Server Settings → Roles**, or run \`/checkpermissions\`.`, flags: 64 });
    }
    if (!config.role_head_coach_id) await saveConfig(guildId, { role_head_coach_id: hcRole.id });
  }

  const embed = new EmbedBuilder()
    .setTitle(`✍️ Coach Signed — ${team.team_name}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`<@${user.id}> has been assigned to **${team.team_name}**!`)
    .addFields(
      { name: 'Coach', value: `<@${user.id}>`, inline: true },
      { name: 'Team',  value: team.team_name,  inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  if (!skipAnn) {
    const target = findTextChannel(guild, config.channel_signed_coaches) || findTextChannel(guild, config.channel_news_feed);
    if (target && target.id !== interaction.channelId) await target.send({ embeds: [embed] });
  }

  // Auto-update team list
  await postTeamList(guild, guildId, config).catch(console.error);
}

// /resetteam ──────────────────────────────────────────
async function handleResetTeam(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_reset_team) return interaction.editReply({ content: '❌ Team reset is disabled on this server.' });
  const user    = interaction.options.getUser('user');

  const team = await getTeamByUser(user.id, guildId);
  if (!team) {
    return interaction.editReply({ content: `❌ **No Team Found**\n<@${user.id}> doesn't have a team assigned in this league. Nothing to reset.` });
  }

  await unassignTeam(team.id, guildId);

  await removeCoachStream(guildId, user.id).catch(err => {
  console.warn('[reset] Failed to remove stream link:', err.message);
});
  
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  let roleWarning = '';
  if (member && config.role_head_coach_id) {
    try {
      await member.roles.remove(config.role_head_coach_id);
    } catch (roleErr) {
      console.error('[roles] Failed to remove head coach role on resetteam:', roleErr.message);
      roleWarning = `\n⚠️ Couldn't remove the **${config.role_head_coach}** role — check bot role hierarchy in **Server Settings → Roles**.`;
    }
  }

  const signedChannel = findTextChannel(interaction.guild, config.channel_signed_coaches);
  const newsChannel   = findTextChannel(interaction.guild, config.channel_news_feed);
  const announceTarget = signedChannel || newsChannel;

  const releaseEmbed = new EmbedBuilder()
    .setTitle(`🚪 Coach Released — ${team.team_name}`)
    .setColor(0xff4444)
    .setDescription(`<@${user.id}> has been released from **${team.team_name}**.`)
    .addFields(
      { name: 'Coach', value: `<@${user.id}>`, inline: true },
      { name: 'Team',  value: team.team_name,   inline: true },
    )
    .setTimestamp();

  if (announceTarget) await announceTarget.send({ embeds: [releaseEmbed] }).catch(() => {});

  await interaction.editReply({ content: `✅ <@${user.id}> has been removed from **${team.team_name}**.${roleWarning}` });
  
}

// /listteams ──────────────────────────────────────────
async function handleListTeams(interaction) {
  const guildId = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const config  = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_list_teams) return interaction.editReply({ content: '❌ Team listing is disabled on this server.' });

  let allTeams;
  try {
    allTeams = await getAllTeams(guildId);
  } catch (err) {
    return interaction.editReply(`❌ **Database Error**\nCouldn't load teams: ${err.message}\n\nCheck your Supabase connection and ensure the \`teams\` table exists and has data.`);
  }

  const minRating = config.star_rating_for_offers     || 0;
  const maxRating = config.star_rating_max_for_offers || 999;

  // Always show taken teams; only show available teams within the configured range
  const teams = allTeams.filter(t => t.user_id || (t.star_rating != null && parseFloat(t.star_rating) >= minRating && parseFloat(t.star_rating) <= maxRating));

  // Group by conference
  const confMap = {};
  for (const t of teams) {
    const conf = t.conference || 'Independent';
    if (!confMap[conf]) confMap[conf] = [];
    confMap[conf].push(t);
  }

  const fields = [];
  for (const [conf, confTeams] of Object.entries(confMap).sort()) {
    const lines = confTeams
      .sort((a, b) => (b.star_rating || 0) - (a.star_rating || 0))
      .map(t => t.user_id
        ? `🏈 **${t.team_name}** — <@${t.user_id}> (${t.star_rating || '?'}⭐)`
        : `🟢 **${t.team_name}** — Available (${t.star_rating || '?'}⭐)`
      );

    for (let i = 0; i < lines.length; i += 15) {
      fields.push({
        name:  i === 0 ? `__${conf}__` : `__${conf} (cont.)__`,
        value: lines.slice(i, i + 15).join('\n'),
        inline: false,
      });
    }
  }

  if (fields.length === 0) {
    return interaction.editReply('No teams found. Make sure teams are loaded in the database.');
  }

  const taken = teams.filter(t => t.user_id).length;
  const avail = teams.filter(t => !t.user_id).length;

  const embeds = [];
  for (let i = 0; i < fields.length; i += 25) {
    const embed = new EmbedBuilder()
      .setColor(config.embed_color_primary_int)
      .addFields(fields.slice(i, i + 25));

    if (i === 0) {
      embed
        .setTitle(`📋 ${config.league_name} — Team List`)
        .setDescription(
          `**${taken}** coaches signed · **${avail}** teams available\n` +
          `Showing teams rated **${minRating}⭐${maxRating < 999 ? ' – ' + maxRating + '⭐' : '+'}**`
        )
        .setTimestamp();
    }
    embeds.push(embed);
  }

  const listsChannel = findTextChannel(interaction.guild, config.channel_team_lists);
  const target       = listsChannel || interaction.channel;

  const botMember = interaction.guild.members.cache.get(client.user.id);
  const perms     = target.permissionsFor(botMember);

  if (!perms?.has('SendMessages')) {
    return interaction.editReply(`❌ **Missing Channel Permissions**\nI don't have permission to post in ${target}.\n\n**Required permissions in that channel:**\n• Send Messages\n• Embed Links\n• Read Message History\n• Manage Messages (for cleanup)\n\nFix this in **Server Settings → Roles** or the channel's **Edit Channel → Permissions**, then try again. Run \`/checkpermissions\` for a full audit.`);
  }

  if (perms.has('ManageMessages')) {
    try {
      const messages = await target.messages.fetch({ limit: 100 });
      for (const m of messages.filter(m => m.author.id === client.user.id).values()) {
        await m.delete().catch(() => {});
      }
    } catch { /* ignore */ }
  }

  for (const embed of embeds) await target.send({ embeds: [embed] });

  await interaction.editReply(
    listsChannel && listsChannel.id !== interaction.channelId
      ? `✅ Team list posted in ${listsChannel}!`
      : '✅ Team list posted!'
  );
}

// postTeamList — internal helper, no interaction object needed
async function postTeamList(guild, guildId, config) {
  if (!config.feature_list_teams) return;
  const listsChannel = findTextChannel(guild, config.channel_team_lists);
  if (!listsChannel) return;

  let allTeams;
  try { allTeams = await getAllTeams(guildId); } catch { return; }

  const minRating = config.star_rating_for_offers     || 0;
  const maxRating = config.star_rating_max_for_offers || 999;
  const teams = allTeams.filter(t => t.user_id || (t.star_rating != null && parseFloat(t.star_rating) >= minRating && parseFloat(t.star_rating) <= maxRating));

  const confMap = {};
  for (const t of teams) {
    const conf = t.conference || 'Independent';
    if (!confMap[conf]) confMap[conf] = [];
    confMap[conf].push(t);
  }

  const fields = [];
  for (const [conf, confTeams] of Object.entries(confMap).sort()) {
    const lines = confTeams
      .sort((a, b) => (b.star_rating || 0) - (a.star_rating || 0))
      .map(t => t.user_id
        ? `🏈 **${t.team_name}** — <@${t.user_id}> (${t.star_rating || '?'}⭐)`
        : `🟢 **${t.team_name}** — Available (${t.star_rating || '?'}⭐)`
      );
    for (let i = 0; i < lines.length; i += 15) {
      fields.push({ name: i === 0 ? `__${conf}__` : `__${conf} (cont.)__`, value: lines.slice(i, i + 15).join('\n'), inline: false });
    }
  }
  if (fields.length === 0) return;

  // Delete old bot messages in channel, post fresh
  const PAGE = 25;
  const embeds = [];
  for (let i = 0; i < fields.length; i += PAGE) {
    embeds.push(new EmbedBuilder()
      .setTitle(i === 0 ? `📋 Team Availability — ${config.league_name}` : `📋 Team Availability (cont.)`)
      .setColor(config.embed_color_primary_int || 0x1e90ff)
      .setDescription(i === 0 ? `**${config.league_abbreviation || config.league_name}** · Updated <t:${Math.floor(Date.now()/1000)}:R>` : null)
      .addFields(fields.slice(i, i + PAGE))
      .setTimestamp()
    );
  }

  try {
    const messages = await listsChannel.messages.fetch({ limit: 100 });
    for (const m of messages.filter(m => m.author.id === listsChannel.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* ignore */ }

  for (const embed of embeds) await listsChannel.send({ embeds: [embed] });
}

// /advance helpers ────────────────────────────────────
async function postWeeklyRecap(guild, guildId, config, meta) {
  const newsChannel = findTextChannel(guild, config.channel_news_feed);
  if (!newsChannel) return;

  const { data: results } = await supabase
    .from('results')
    .select('*, team1:teams!results_team1_id_fkey(team_name), team2:teams!results_team2_id_fkey(team_name)')
    .eq('guild_id', guildId)
    .eq('season', meta.season)
    .eq('week', meta.week)
    .order('created_at', { ascending: true });

  if (!results || results.length === 0) return;

  const lines = results.map(r => {
    const t1     = r.team1?.team_name || 'Team 1';
    const t2     = r.team2?.team_name || 'Team 2';
    const trophy = r.score1 !== r.score2 ? '🏆' : '🤝';
    return `${trophy} **${t1}** ${r.score1} — ${r.score2} **${t2}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📋 Week ${meta.week} Recap — ${config.league_name}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`Season **${meta.season}** · Week **${meta.week}** · **${results.length}** game${results.length !== 1 ? 's' : ''} played`)
    .setTimestamp();

  for (let i = 0; i < lines.length; i += 15) {
    embed.addFields({
      name:   lines.length > 15 ? `Results (${Math.floor(i / 15) + 1})` : 'Results',
      value:  lines.slice(i, i + 15).join('\n'),
      inline: false,
    });
  }

  await newsChannel.send({ embeds: [embed] });
}

// /advance ────────────────────────────────────────────
async function handleAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  guildConfigs.delete(guildId);
  const config = await loadGuildConfig(guildId);

  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_advance) {
    return interaction.editReply({ content: '❌ **Advance Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const hoursStr = interaction.options.getString('hours');
  const hours = parseInt(hoursStr);
  const intervals = config.advance_intervals_parsed || [24, 48];
  if (isNaN(hours) || !intervals.includes(hours)) {
    return interaction.editReply({
      content:
        `❌ **Invalid Option: \`${hoursStr}\`**\n` +
        `Please select one of the available options from the dropdown.\n` +
        `Configured intervals: ${intervals.map(h => h + 'h').join(', ')}`,
    });
  }

  const meta = await getMeta(guildId);

  // ── Advance phase/sub-phase ───────────────────────────────────────────
  const currentPhase = meta.current_phase     || 'preseason';
  const currentSub   = meta.current_sub_phase  || 0;
  const phaseDef     = getPhaseByKey(currentPhase);

  let newPhase  = currentPhase;
  let newSub    = currentSub + 1;
  let newSeason = meta.season || 1;

  if (newSub >= phaseDef.subWeeks) {
    const idx      = PHASE_CYCLE.findIndex(p => p.key === currentPhase);
    const nextIdx  = (idx + 1) % PHASE_CYCLE.length;
    const nextPhase = PHASE_CYCLE[nextIdx];
    newPhase       = nextPhase.key;
    newSub         = nextPhase.startSub ?? 0;
    if (newPhase === 'preseason') {
      newSeason = newSeason + 1;
      // Post season rollover announcement
      const seasonEmbed = new EmbedBuilder()
        .setTitle(`🏆 Season ${newSeason} Has Begun!`)
        .setColor(config.embed_color_primary_int)
        .setDescription(`Season **${meta.season}** is over! Welcome to **Season ${newSeason}**!\nWe are now in **Preseason**. Good luck!`)
        .setTimestamp();
      const advCh = findTextChannel(interaction.guild, config.channel_advance_tracker);
      const newsCh = findTextChannel(interaction.guild, config.channel_news_feed);
      const hcRoleName = (config.role_head_coach || 'head coach').trim();
      const hcRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === hcRoleName.toLowerCase());
      const seasonMention = hcRole ? `<@&${hcRole.id}> ` : '@everyone ';
      if (advCh) await advCh.send({ content: seasonMention, embeds: [seasonEmbed] });
      if (newsCh && newsCh.id !== advCh?.id) await newsCh.send({ embeds: [seasonEmbed] });
    }
  }

  // ── Week 15 skip prompt ───────────────────────────────────────────────────
  // Week 14 = sub_phase 14 in regular season (0-indexed, Week 0–15). Some leagues skip it.
  // Ask the admin before committing so they can jump straight to conf champ.
  if (newPhase === 'regular' && newSub === 14) {
    const skipRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('advance_week15')
        .setLabel('▶️ Continue to Week 14')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('advance_skip15')
        .setLabel('⏭️ Skip to Conference Championship')
        .setStyle(ButtonStyle.Primary),
    );
    const promptMsg = await interaction.editReply({
      content: '**Week 14 Prompt**\nSome leagues skip Week 14. What would you like to do?',
      components: [skipRow],
    });
    try {
      const btn = await promptMsg.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id,
        time: 60000,
      });
      await btn.update({ components: [] });
      if (btn.customId === 'advance_skip15') {
        // Jump straight to Conference Championship
        const confIdx = PHASE_CYCLE.findIndex(p => p.key === 'conf_champ');
        newPhase = PHASE_CYCLE[confIdx].key;
        newSub   = 0;
      }
      // else continue to Week 15 as normal
    } catch {
      await interaction.editReply({ content: '⏰ No response — advance cancelled. Run `/advance` again.', components: [] });
      return;
    }
  }

  const phaseLabel = formatPhase(newPhase, newSub);
  const deadline   = new Date(Date.now() + hours * 60 * 60 * 1000);

  const TZ_MAP = {
    ET:   { label: '🌴 ET',   iana: 'America/New_York'    },
    CT:   { label: '🐄 CT',   iana: 'America/Chicago'     },
    MT:   { label: '🏔️ MT',   iana: 'America/Denver'      },
    PT:   { label: '🌊 PT',   iana: 'America/Los_Angeles' },
    GMT:  { label: '🌐 GMT',  iana: 'Europe/London'       },
    AEST: { label: '🦘 AEST', iana: 'Australia/Sydney'    },
    NZST: { label: '🥝 NZST', iana: 'Pacific/Auckland'    },
  };

  const formatTZ = (date, iana) =>
    date.toLocaleString('en-US', { timeZone: iana, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

  const configuredTZs = config.advance_timezones_parsed || ['ET','CT','MT','PT'];
  const deadlineLines = configuredTZs
    .filter(k => TZ_MAP[k])
    .map(k => `${TZ_MAP[k].label}: **${formatTZ(deadline, TZ_MAP[k].iana)}**`)
    .join('\n');

  // Mention @head-coach role on public announcement if it exists, else @everyone
  const headCoachRoleName = (config.role_head_coach || 'head coach').trim();
  const headCoachRole     = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === headCoachRoleName.toLowerCase());
  const mention           = headCoachRole ? `<@&${headCoachRole.id}> ` : '@everyone ';

  const embed = new EmbedBuilder()
    .setTitle(`⏭️ Advance — ${phaseLabel} (Season ${newSeason})`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`The league is advancing to **${phaseLabel}**!\nAll tasks must be completed within **${hours} hours**.`)
    .addFields({
      name: '🕐 Deadline',
      value: deadlineLines || 'No timezones configured.',
      inline: false,
    })
    .setTimestamp();

  // Only post weekly game recap during regular season.
  // Skip if news-feed and advance-tracker are the same channel — would duplicate.
  if (currentPhase === 'regular') {
    const recapNewsChannel    = findTextChannel(interaction.guild, config.channel_news_feed);
    const recapAdvanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
    const sameChannel = recapNewsChannel && recapAdvanceChannel && recapNewsChannel.id === recapAdvanceChannel.id;
    if (!sameChannel) await postWeeklyRecap(interaction.guild, guildId, config, meta);
  }

  await setMeta(guildId, {
    season:                newSeason,
    week:                  newPhase === 'regular' ? newSub + 1 : (newPhase === 'preseason' ? 1 : meta.week),
    current_phase:         newPhase,
    current_sub_phase:     newSub,
    advance_hours:         hours,
    advance_deadline:      deadline.toISOString(),
    last_advance_at:       new Date().toISOString(),
    next_advance_deadline: deadline.toISOString(),
  });

  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  if (advanceChannel) {
    await advanceChannel.send({ content: mention, embeds: [embed] });
    await interaction.editReply({ content: `✅ Advance posted in ${advanceChannel}!` });
  } else {
    await interaction.editReply({ content: mention, embeds: [embed] });
  }
}
// /move-coach ─────────────────────────────────────────
async function handleMoveCoach(interaction) {
  const guildId     = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const config      = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_move_coach) return interaction.editReply({ content: '❌ Move coach is disabled on this server.' });
  const coachId     = interaction.options.getString('coach');
  const newTeamName = interaction.options.getString('new-team');

  const user = await interaction.guild.members.fetch(coachId).then(m => m.user).catch(() => null);
  if (!user) return interaction.editReply('❌ **Coach Not Found**\nThis user couldn\'t be fetched from the server. They may have left.\n\nIf they\'re still in the server, try running `/move-coach` again and selecting from the autocomplete list.');

  let currentTeam, newTeam;
  try { currentTeam = await getTeamByUser(user.id, guildId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't load current team for this coach: ${err.message}`); }
  try { newTeam = await getTeamByName(newTeamName, guildId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't look up destination team "${newTeamName}": ${err.message}`); }

  if (!newTeam) return interaction.editReply(`❌ **Team Not Found: \`${newTeamName}\`**\nThis team doesn't exist in the database. Use the autocomplete dropdown to select a valid destination team.`);
  if (newTeam.user_id && newTeam.user_id !== user.id) {
    return interaction.editReply(`❌ **Team Already Occupied**\n**${newTeam.team_name}** is currently assigned to another coach in this league.\n\nTo move this coach there, first run \`/resetteam\` on the current coach of that team, then try again.`);
  }

  if (currentTeam) await unassignTeam(currentTeam.id, guildId);
  await assignTeam(newTeam.id, user.id, guildId);

  const embed = new EmbedBuilder()
    .setTitle('🔄 Coach Moved')
    .setColor(config.embed_color_primary_int)
    .setDescription(`<@${user.id}> has moved to **${newTeam.team_name}**.`)
    .addFields(
      { name: 'From', value: currentTeam ? currentTeam.team_name : 'No previous team', inline: true },
      { name: 'To',   value: newTeam.team_name,                                         inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // Post to signed-coaches (preferred) or news-feed
  const signedChannel = findTextChannel(interaction.guild, config.channel_signed_coaches);
  const newsChannel   = findTextChannel(interaction.guild, config.channel_news_feed);
  const announceTarget = signedChannel || newsChannel;
  if (announceTarget && announceTarget.id !== interaction.channelId) {
    await announceTarget.send({ embeds: [embed] });
  }
}


// /offers-config ─────────────────────────────────────────────────────────
async function handleOffersConfig(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  await showOffersConfigMenu(interaction, guildId, config);
}

async function showOffersConfigMenu(interaction, guildId, config, edit = false) {
  const offerCfg = await getJobOfferConfig(guildId);
  const whitelist = await getJobOfferConferences(guildId, 'whitelist');
  const blacklist = await getJobOfferConferences(guildId, 'blacklist');

  const weightLabel = offerCfg.weighted_ratings === 'highest' ? '⭐ Weighted: Highest'
                    : offerCfg.weighted_ratings === 'lowest'  ? '⭐ Weighted: Lowest'
                    : '⭐ Weighted: Off';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Job Offer Configuration')
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription('Toggle rules that apply when generating job offers. FCS teams are always excluded.')
    .addFields(
      { name: '🚫 Max 1 Per Conference', value: offerCfg.one_per_conference ? '✅ On'  : '❌ Off', inline: true },
      { name: '⚖️ Conference Balance',   value: offerCfg.conf_balance       ? '✅ On'  : '❌ Off', inline: true },
      { name: weightLabel,               value: offerCfg.weighted_ratings === 'off' ? '❌ Off' : '✅ On', inline: true },
      { name: '✅ Whitelist',            value: whitelist.length > 0 ? whitelist.join(', ') : 'None (all allowed)', inline: true },
      { name: '🚫 Blacklist',            value: blacklist.length > 0 ? blacklist.join(', ') : 'None',               inline: true },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ofc_one_per_conf')
      .setLabel(offerCfg.one_per_conference ? '✅ 1 Per Conference' : '❌ 1 Per Conference')
      .setStyle(offerCfg.one_per_conference ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ofc_balance')
      .setLabel(offerCfg.conf_balance ? '✅ Conf Balance' : '❌ Conf Balance')
      .setStyle(offerCfg.conf_balance ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ofc_weighted')
      .setLabel(weightLabel)
      .setStyle(offerCfg.weighted_ratings !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ofc_whitelist')
      .setLabel(`✅ Manage Whitelist${whitelist.length > 0 ? ` (${whitelist.length})` : ''}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ofc_blacklist')
      .setLabel(`🚫 Manage Blacklist${blacklist.length > 0 ? ` (${blacklist.length})` : ''}`)
      .setStyle(ButtonStyle.Primary),
  );

  const payload = { embeds: [embed], components: [row1, row2] };
  const msg = edit
    ? await interaction.editReply(payload)
    : await interaction.editReply(payload);

  // Collect button interaction
  try {
    const btn = await msg.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id,
      time: 120000,
    });
    await btn.deferUpdate();

    if (btn.customId === 'ofc_one_per_conf') {
      await setJobOfferConfig(guildId, { one_per_conference: !offerCfg.one_per_conference });
      await showOffersConfigMenu(interaction, guildId, config, true);

    } else if (btn.customId === 'ofc_balance') {
      await setJobOfferConfig(guildId, { conf_balance: !offerCfg.conf_balance });
      await showOffersConfigMenu(interaction, guildId, config, true);

    } else if (btn.customId === 'ofc_weighted') {
      // Cycle: off → highest → lowest → off
      const next = offerCfg.weighted_ratings === 'off'     ? 'highest'
                 : offerCfg.weighted_ratings === 'highest' ? 'lowest'
                 : 'off';
      await setJobOfferConfig(guildId, { weighted_ratings: next });
      await showOffersConfigMenu(interaction, guildId, config, true);

    } else if (btn.customId === 'ofc_whitelist') {
      await showConferenceToggleMenu(interaction, guildId, config, 'whitelist');

    } else if (btn.customId === 'ofc_blacklist') {
      await showConferenceToggleMenu(interaction, guildId, config, 'blacklist');
    }

  } catch {
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}

async function showConferenceToggleMenu(interaction, guildId, config, mode) {
  const conferences = await getDistinctConferences();
  const active      = await getJobOfferConferences(guildId, mode);
  const modeLabel   = mode === 'whitelist' ? '✅ Whitelist' : '🚫 Blacklist';
  const modeDesc    = mode === 'whitelist'
    ? 'Only these conferences will appear in job offers. If empty, all are allowed.'
    : 'These conferences will never appear in job offers.';

  if (conferences.length === 0) {
    await interaction.editReply({ content: '❌ No conferences found in the teams database.', components: [] });
    return;
  }

  // Build toggle buttons — up to 25 (5 rows of 5)
  const buttons = conferences.slice(0, 25).map(conf =>
    new ButtonBuilder()
      .setCustomId(`ofc_conf_${mode}_${conf}`)
      .setLabel(active.includes(conf) ? `✅ ${conf}` : conf)
      .setStyle(active.includes(conf) ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  // Add a Back button at the end
  buttons.push(
    new ButtonBuilder()
      .setCustomId('ofc_back')
      .setLabel('← Back')
      .setStyle(ButtonStyle.Primary)
  );

  // Chunk into rows of 5
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  const embed = new EmbedBuilder()
    .setTitle(`${modeLabel} Conferences`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(`${modeDesc}\n\nCurrently active: ${active.length > 0 ? active.join(', ') : 'None'}`);

  const msg = await interaction.editReply({ embeds: [embed], components: rows });

  try {
    const btn = await msg.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id,
      time: 120000,
    });
    await btn.deferUpdate();

    if (btn.customId === 'ofc_back') {
      await showOffersConfigMenu(interaction, guildId, config, true);
      return;
    }

    // Parse conference from customId: ofc_conf_{mode}_{conference}
    const parts = btn.customId.split('_');
    // customId format: ofc_conf_whitelist_Big Ten  (conference name may have spaces replaced)
    const confName = conferences.find(c => `ofc_conf_${mode}_${c}` === btn.customId);
    if (confName) {
      await toggleJobOfferConference(guildId, confName, mode);
    }

    // Re-show the same screen to allow multiple toggles
    await showConferenceToggleMenu(interaction, guildId, config, mode);

  } catch {
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}

// /reload-commands ───────────────────────────────────────────────────
async function handleReloadCommands(interaction) {
  await interaction.deferReply({ flags: 64 });
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  try {
    await registerCommands();
    await interaction.editReply({ content: '✅ **Commands re-registered.** New commands may take up to a minute to appear in Discord.' });
  } catch (err) {
    await interaction.editReply({ content: `❌ **Failed to re-register commands:** ${err.message}` });
  }
}

// /set-phase ───────────────────────────────────────────────────────────
async function handleSetPhase(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  const season   = interaction.options.getInteger('season');
  const phaseKey = interaction.options.getString('phase');
  const subInput = interaction.options.getInteger('sub');

  const phaseDef = getPhaseByKey(phaseKey);

  // Determine sub — if not provided use the phase's startSub default
  let sub = subInput !== null ? subInput : phaseDef.startSub;

  // Validate sub range
  const maxSub = phaseDef.startSub + phaseDef.subWeeks - 1;
  if (sub < phaseDef.startSub || sub > maxSub) {
    return interaction.editReply({
      content: `❌ **Invalid sub-phase for ${phaseDef.name}**\nValid range: ${phaseDef.startSub}–${maxSub}. You entered: ${sub}.`,
    });
  }

  // Derive week the same way advance does
  const week = phaseKey === 'regular'  ? sub + 1
             : phaseKey === 'preseason' ? 1
             : 17; // bowl / offseason — post-regular-season

  await setMeta(guildId, {
    season,
    week,
    current_phase:     phaseKey,
    current_sub_phase: sub,
  });

  const label = formatPhase(phaseKey, sub);

  const embed = new EmbedBuilder()
    .setTitle('📅 Phase Updated')
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(`League phase has been manually updated.`)
    .addFields(
      { name: 'Season',  value: `Season ${season}`,    inline: true },
      { name: 'Phase',   value: label,                 inline: true },
      { name: 'Week',    value: `Week ${week}`,         inline: true },
      { name: 'Sub-Phase Index', value: `${sub}`,      inline: true },
    )
    .setFooter({ text: 'Use /advance to continue advancing from this point.' });

  await interaction.editReply({ embeds: [embed] });
}

// /help ──────────────────────────────────────────────
async function handleHelp(interaction) {
  await interaction.deferReply({ flags: 64 });

  const config  = await getConfig(interaction.guildId);
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!config.setup_complete && !isAdmin) return replySetupRequired(interaction);

  // ── Command catalogue ─────────────────────────────────────────────────────
  // Each entry: { flag, adminOnly, title, usage, description }
  // flag: config key that must be true for the command to show (null = always show)
  const COMMANDS = [
    // ── Game Day ───────────────────────────────────────────────────────────
    {
      flag:      'feature_game_result',
      adminOnly: false,
      title:     '🏈 `/game-result`',
      usage:     '/game-result opponent: <team> your-score: <n> opponent-score: <n>',
      desc:      "Submit your game result. Your record updates automatically. Optionally add a short summary.",
    },
    {
      flag:      'feature_any_game_result',
      adminOnly: true,
      title:     '🏈 `/any-game-result`',
      usage:     '/any-game-result team1: <team> team2: <team> score1: <n> score2: <n>',
      desc:      "Enter a result for any two teams. Use when a coach can't submit their own.",
    },
    {
      flag:      'feature_ranking',
      adminOnly: false,
      title:     '🏆 `/ranking`',
      usage:     '/ranking',
      desc:      "View the current season standings sorted by wins.",
    },
    {
      flag:      'feature_ranking_all_time',
      adminOnly: false,
      title:     '🏆 `/ranking-all-time`',
      usage:     '/ranking-all-time',
      desc:      "View all-time win/loss records across every season.",
    },
    {
      flag:      'feature_game_results_reminder',
      adminOnly: false,
      title:     '🔔 Game Results Reminder',
      usage:     '(automatic)',
      desc:      `After a game result is submitted, the bot sends a reminder to any coaches who haven't submitted theirs yet after ${config.stream_reminder_minutes || 45} minutes.`,
    },
    // ── Team Selection ─────────────────────────────────────────────────────
    {
      flag:      'feature_job_offers',
      adminOnly: true,
      title:     '⚙️ `/offers-config`',
      usage:     '/offers-config',
      desc:      'Configure conference rules and weighting for job offers. Toggle max-1-per-conference, conference balance, weighted ratings, and manage conference whitelists/blacklists.',
    },
    {
      flag:      'feature_job_offers',
      adminOnly: false,
      title:     '📋 `/joboffers`',
      usage:     '/joboffers',
      desc:      "Request a set of coaching job offers. You'll receive up to " + (config.job_offers_count || 3) + " teams via DM based on star rating. Offers expire after " + (config.job_offers_expiry_hours || 48) + " hours.",
    },
    {
      flag:      'feature_assign_team',
      adminOnly: true,
      title:     '➕ `/assign-team`',
      usage:     '/assign-team user: @user team: <team>',
      desc:      "Manually assign a team to a user and post a signing announcement. Use skip-announcement: true to assign quietly.",
    },
    {
      flag:      'feature_reset_team',
      adminOnly: true,
      title:     '❌ `/resetteam`',
      usage:     '/resetteam user: @user',
      desc:      "Remove a coach from their team, strip their Head Coach role, and clear their stream handle.",
    },
    {
      flag:      'feature_list_teams',
      adminOnly: true,
      title:     '📋 `/listteams`',
      usage:     '/listteams',
      desc:      "Post the full team availability list to the configured channel, showing which teams are taken and which are open.",
    },
    {
      flag:      'feature_move_coach',
      adminOnly: true,
      title:     '🔀 `/move-coach`',
      usage:     '/move-coach coach: <name> new-team: <team>',
      desc:      "Move an assigned coach from their current team to a different one.",
    },
    // ── Advance Management ─────────────────────────────────────────────────
    {
      flag:      'feature_advance',
      adminOnly: true,
      title:     '⏩ `/advance`',
      usage:     '/advance hours: <n>',
      desc:      "Advance the league to the next phase/week and set a deadline. The bot posts the new phase and deadline to the advance tracker channel.",
    },

    // ── Streaming ──────────────────────────────────────────────────────────
    {
      flag:      'feature_stream_autopost',
      adminOnly: false,
      title:     '📡 `/streamer register`',
      usage:     '/streamer register platform: Twitch|YouTube handle: <username>',
      desc:      "Store your Twitch or YouTube handle for use with Wamellow autopost. Use /streamer list to get the full table for Wamellow setup.",
    },
    {
      flag:      'feature_streaming_list',
      adminOnly: true,
      title:     '📋 `/streamer list`',
      usage:     '/streamer list',
      desc:      "Show all coaches and their registered stream handles. Formatted as a copyable table for pasting into Wamellow.",
    },
    // ── Always available ───────────────────────────────────────────────────
    {
      flag:      null,
      adminOnly: false,
      title:     '❓ `/help`',
      usage:     '/help',
      desc:      "Show this list. Admins see all commands; coaches see only commands available to them.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config view`',
      usage:     '/config view',
      desc:      "View all current bot settings for this server.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config edit`',
      usage:     '/config edit setting: <name> value: <value>',
      desc:      "Change a specific config value (channel names, star ratings, colors, etc.).",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config features`',
      usage:     '/config features',
      desc:      "Toggle individual features on or off for this server.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config reload`',
      usage:     '/config reload',
      desc:      "Force-reload the bot config from the database. Use after editing Supabase directly.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '🔧 `/setup`',
      usage:     '/setup',
      desc:      "Run the interactive setup wizard. Walks through league name, features, channels, roles, and settings via DM.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '🔧 `/checkpermissions`',
      usage:     '/checkpermissions',
      desc:      "Audit the bot's permissions across all configured channels and confirm everything is set up correctly.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '📅 `/set-phase`',
      usage:     '/set-phase season: <n> phase: <phase> sub: <n>',
      desc:      "Manually set the current season, phase, and sub-week. Use to correct the league state if it gets out of sync. /advance will continue from wherever you set it.",
    },
  ];

  // ── Filter by feature flag + role ─────────────────────────────────────────
  const visible = COMMANDS.filter(cmd => {
    if (cmd.adminOnly && !isAdmin) return false;
    if (cmd.flag && !config[cmd.flag]) return false;
    return true;
  });

  // ── Build embed fields (max 25 Discord fields) ────────────────────────────
  const fields = visible.map(cmd => ({
    name:   cmd.title,
    value:  `${cmd.usage}\n${cmd.desc}`,
    inline: false,
  }));

  // Split into pages of 10 if needed
  const PAGE = 10;
  const pages = [];
  for (let i = 0; i < fields.length; i += PAGE) pages.push(fields.slice(i, i + PAGE));

  const roleLabel = isAdmin ? 'Admin' : 'Coach';
  const embed = new EmbedBuilder()
    .setTitle(`📖 ${config.league_name} — Command Guide (${roleLabel})`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(
      isAdmin
        ? `Showing all **${visible.length}** commands available on this server. Disabled features are hidden.`
        : `Showing **${visible.length}** commands available to you. Ask an admin to enable additional features.`
    )
    .addFields(pages[0])
    .setFooter({ text: '🔗 Invite Dynasty Bot: http://bit.ly/46t7pjs' });

  await interaction.editReply({ embeds: [embed] });

  // Send additional pages as follow-ups if list is long
  for (let p = 1; p < pages.length; p++) {
    const pageEmbed = new EmbedBuilder()
      .setColor(config.embed_color_primary_int || 0x1e90ff)
      .addFields(pages[p]);
    await interaction.followUp({ embeds: [pageEmbed], flags: 64 });
  }
}

// /checkpermissions ───────────────────────────────────
async function handleCheckPermissions(interaction) {
  const guildId   = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild || await client.guilds.fetch({ guild: guildId, force: true }).catch(() => null);
  if (!guild) return interaction.editReply({ content: '❌ Could not load server data. Please try again.' });
  await guild.channels.fetch().catch(() => {});
  const config    = await getConfig(guildId);
  const botMember = guild.members.cache.get(client.user.id) || await guild.members.fetch(client.user.id).catch(() => null);
  if (!botMember) return interaction.editReply({ content: '❌ Could not fetch bot member data. Please try again.' });

  const REQUIRED = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

  const channelChecks = [
    { key: 'channel_news_feed',       label: 'News Feed',       needsManage: false },
    { key: 'channel_signed_coaches',  label: 'Signed Coaches',  needsManage: false },
    { key: 'channel_team_lists',      label: 'Team Lists',      needsManage: true  },
    { key: 'channel_advance_tracker', label: 'Advance Tracker', needsManage: false },
    { key: 'channel_streaming',       label: 'Streaming',       needsManage: false },
  ];

  const lines  = ['**📺 Channel Permissions**'];
  let allGood  = true;

  for (const check of channelChecks) {
    const chName  = config[check.key];
    if (!chName) { lines.push(`⬜ **${check.label}** — not configured`); continue; }

    const channel = findTextChannel(guild, chName);
    if (!channel) { lines.push(`❌ **${check.label}** — \`#${chName}\` not found`); allGood = false; continue; }

    const perms   = channel.permissionsFor(botMember);
    const missing = REQUIRED.filter(f => !perms.has(f));
    if (check.needsManage && !perms.has('ManageMessages')) missing.push('ManageMessages');

    if (missing.length) {
      lines.push(`❌ **${check.label}** (#${channel.name}) — missing: ${missing.join(', ')}`);
      allGood = false;
    } else {
      lines.push(`✅ **${check.label}** (#${channel.name})`);
    }
  }

  lines.push('', '**🔧 Server Permissions**');
  const guildPerms = botMember.permissions;
  if (guildPerms.has('ManageRoles'))     lines.push('✅ **Manage Roles**');
  else { lines.push('❌ **Manage Roles** — required to assign head coach role'); allGood = false; }
  lines.push(guildPerms.has('ManageNicknames') ? '✅ **Manage Nicknames**' : '⬜ **Manage Nicknames** (optional)');

  lines.push('', '**👑 Role Hierarchy**');
  const hcRole  = guild.roles.cache.find(r => r.name === config.role_head_coach);
  const botRole = botMember.roles.highest;

  if (!hcRole) {
    lines.push(`⬜ Head coach role \`${config.role_head_coach}\` not found — will be created on first assignment`);
  } else if (botRole.position <= hcRole.position) {
    lines.push(`❌ Bot role **${botRole.name}** is below **${hcRole.name}** — move the bot role higher in Server Settings → Roles`);
    allGood = false;
  } else {
    lines.push(`✅ Bot role **${botRole.name}** is above **${hcRole.name}**`);
  }

  const embed = new EmbedBuilder()
    .setTitle(allGood ? '✅ All Permissions OK' : '⚠️ Permission Issues Found')
    .setColor(allGood ? 0x00ff00 : 0xff4444)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Fix any ❌ items in channel/server settings, then run this again.' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// =====================================================
// AUTOCOMPLETE HANDLER
// =====================================================
async function handleAutocomplete(interaction) {
  const { commandName, guildId } = interaction;
  const focused = interaction.options.getFocused(true);
  const query   = focused.value.toLowerCase();
  let choices   = [];

  try {

  if (commandName === 'assign-team' || commandName === 'any-game-result') {
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, team_name, conference, star_rating')
      .ilike('team_name', `%${query}%`)
      .order('team_name')
      .limit(25);

    if (error) console.error('[autocomplete] teams query error:', error.message);
    choices = (teams || []).map(t => ({
      name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
      value: t.team_name,
    }));

  } else if (commandName === 'move-coach') {
    if (focused.name === 'coach') {
      const { data: assignments, error } = await supabase
        .from('team_assignments')
        .select('user_id, teams(team_name)')
        .eq('guild_id', guildId);

      if (error) {
        console.error('[autocomplete] move-coach assignments error:', error.message);
      } else {
        // Bulk fetch all members at once instead of one-by-one in a loop
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
          // Filter by query first using cached members, fall back to fetching unknowns
          for (const a of (assignments || [])) {
            const cached = guild.members.cache.get(a.user_id);
            const displayName = cached?.displayName;
            if (!displayName) continue; // skip uncached members — avoids serial API calls
            if (!displayName.toLowerCase().includes(query)) continue;
            choices.push({ name: `${displayName} — ${a.teams?.team_name || 'Unknown'}`, value: a.user_id });
            if (choices.length >= 25) break;
          }
        }
      }

    } else if (focused.name === 'new-team') {
      const { data: teams, error } = await supabase
        .from('teams')
        .select('id, team_name, conference, star_rating')
        .ilike('team_name', `%${query}%`)
        .order('team_name')
        .limit(25);

      if (error) console.error('[autocomplete] move-coach new-team error:', error.message);
      choices = (teams || []).map(t => ({
        name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
        value: t.team_name,
      }));
    }

  } else if (commandName === 'game-result') {
    // Get user's team_id directly (no join) then query teams table same as assign-team
    const { data: assignment } = await supabase
      .from('team_assignments')
      .select('team_id')
      .eq('user_id', interaction.user.id)
      .eq('guild_id', guildId)
      .maybeSingle();

    const userTeamId = assignment?.team_id || null;

    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, team_name, conference, star_rating')
      .ilike('team_name', `%${query}%`)
      .order('team_name')
      .limit(25);

    if (error) console.error('[autocomplete] game-result teams error:', error.message);
    choices = (teams || [])
      .filter(t => t.id !== userTeamId)
      .map(t => ({
        name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
        value: t.team_name,
      }));

  } else if (commandName === 'resetteam') {
    // Get assigned team_ids first (no join), then look up teams directly
    const { data: assignments, error: aErr } = await supabase
      .from('team_assignments')
      .select('team_id')
      .eq('guild_id', guildId);

    if (aErr) console.error('[autocomplete] resetteam assignments error:', aErr.message);

    const assignedIds = (assignments || []).map(a => a.team_id);
    if (assignedIds.length > 0) {
      const { data: teams, error: tErr } = await supabase
        .from('teams')
        .select('id, team_name, conference, star_rating')
        .in('id', assignedIds)
        .ilike('team_name', `%${query}%`)
        .order('team_name')
        .limit(25);

      if (tErr) console.error('[autocomplete] resetteam teams error:', tErr.message);
      choices = (teams || []).map(t => ({
        name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
        value: t.team_name,
      }));
    }

  } else if (commandName === 'advance') {
    // Always load fresh config so intervals reflect latest settings
    guildConfigs.delete(guildId);
    const advConfig  = await loadGuildConfig(guildId);
    const intervals  = advConfig.advance_intervals_parsed || [24, 48];
    choices = intervals
      .filter(h => String(h).includes(query))
      .map(h => ({ name: `${h} Hours`, value: String(h) }));

  } else if (commandName === 'config' && focused.name === 'setting') {
    const allSettings = [
      { label: 'League Name',             key: 'league_name',                hint: 'League display name' },
      { label: 'League Abbreviation',     key: 'league_abbreviation',        hint: 'Short name for stream detection' },
      { label: 'News Feed Channel',       key: 'channel_news_feed',          hint: 'Channel for results & announcements' },
      { label: 'Advance Tracker Channel', key: 'channel_advance_tracker',    hint: 'Channel for advance notices' },
      { label: 'Team Lists Channel',      key: 'channel_team_lists',         hint: 'Channel for team availability list' },
      { label: 'Signed Coaches Channel',  key: 'channel_signed_coaches',     hint: 'Channel for signing announcements' },
      { label: 'Streaming Channel',       key: 'channel_streaming',          hint: 'Channel to monitor for stream links' },
      { label: 'Head Coach Role',         key: 'role_head_coach',            hint: 'Role assigned to coaches' },

      { label: 'Min Star Rating',         key: 'star_rating_for_offers',     hint: 'Minimum star rating for job offers' },
      { label: 'Max Star Rating',         key: 'star_rating_max_for_offers', hint: 'Maximum star rating for job offers' },
      { label: 'Offers Per User',         key: 'job_offers_count',           hint: 'Number of offers per user' },
      { label: 'Offer Expiry Hours',      key: 'job_offers_expiry_hours',    hint: 'Hours before offers expire (1–24)' },
      { label: 'Game Results Reminder (Minutes)', key: 'stream_reminder_minutes',    hint: 'Minutes after result is submitted to send reminder' },
      { label: 'Advance Intervals',       key: 'advance_intervals',          hint: 'Available advance intervals e.g. [24,48]' },
      { label: 'Primary Embed Color',     key: 'embed_color_primary',        hint: 'Primary embed color hex e.g. 0x1e90ff' },
      { label: 'Win Embed Color',         key: 'embed_color_win',            hint: 'Win result embed color hex' },
      { label: 'Loss Embed Color',        key: 'embed_color_loss',           hint: 'Loss result embed color hex' },
    ];
    choices = allSettings
      .filter(s => s.label.toLowerCase().includes(query) || s.key.includes(query) || s.hint.toLowerCase().includes(query))
      .slice(0, 25)
      .map(s => ({ name: `${s.label} — ${s.hint}`, value: s.key }));

  } else if (commandName === 'config' && focused.name === 'value') {
    const setting = interaction.options.getString('setting') || '';
    const guild   = client.guilds.cache.get(guildId);

    if (setting.startsWith('channel_') && guild) {
      choices = [...guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText && c.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(c => ({ name: `#${c.name}`, value: c.name }))
      ].slice(0, 25);

    } else if (setting === 'role_head_coach' && guild) {
      choices = [...guild.roles.cache
        .filter(r => !r.managed && r.name !== '@everyone' && r.name.toLowerCase().includes(query))
        .sort((a, b) => b.position - a.position)
        .map(r => ({ name: `@${r.name}`, value: r.name }))
      ].slice(0, 25);

    } else if (setting === 'star_rating_for_offers' || setting === 'star_rating_max_for_offers') {
      choices = ['1.0','1.5','2.0','2.5','3.0','3.5','4.0','4.5','5.0']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} stars`, value: v }));

    } else if (setting === 'job_offers_expiry_hours') {
      choices = ['1','2','4','6','8','12','16','24']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} hours`, value: v }));

    } else if (setting === 'job_offers_count') {
      choices = ['1','2','3','4','5']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} offers`, value: v }));

    } else if (setting === 'stream_reminder_minutes') {
      choices = ['15','30','45','60','90','120']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} minutes`, value: v }));

    } else if (setting === 'advance_intervals') {
      choices = ['[24, 48]','[12, 24, 48]','[24]','[48]','[6, 12, 24, 48]']
        .filter(v => v.includes(query)).map(v => ({ name: v, value: v }));

    } else if (setting.startsWith('embed_color_')) {
      choices = [
        { name: 'Blue (default)', value: '0x1e90ff' },
        { name: 'Green',          value: '0x00ff00' },
        { name: 'Red',            value: '0xff0000' },
        { name: 'Gold',           value: '0xffd700' },
        { name: 'Purple',         value: '0x9b59b6' },
        { name: 'Orange',         value: '0xff8c00' },
        { name: 'White',          value: '0xffffff' },
        { name: 'Black',          value: '0x000000' },
      ].filter(c => c.name.toLowerCase().includes(query) || c.value.includes(query));
    }
  }

  } catch (err) {
    console.error('[autocomplete] Unhandled error:', err.message);
    choices = []; // respond with empty list so Discord doesn't show "loading failed"
  }

  // Always respond — never leave an autocomplete interaction hanging
  if (!interaction.responded) {
    await interaction.respond(choices).catch(e => {
      // Token may have expired if we took too long — log and move on
      if (e.code !== 10062) console.error('[autocomplete] respond error:', e.message);
    });
  }
}

// =====================================================
// INTERACTION ROUTER
// =====================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup':             return handleSetup(interaction);
        case 'help':              return handleHelp(interaction);
        case 'checkpermissions':  return handleCheckPermissions(interaction);
        case 'joboffers':         return handleJobOffers(interaction);
        case 'offers-config':     return handleOffersConfig(interaction);
        case 'game-result':       return handleGameResult(interaction);
        case 'any-game-result':   return handleAnyGameResult(interaction);
        case 'ranking':           return handleRanking(interaction);
        case 'ranking-all-time':  return handleRankingAllTime(interaction);
        case 'assign-team':       return handleAssignTeam(interaction);
        case 'resetteam':         return handleResetTeam(interaction);
        case 'listteams':         return handleListTeams(interaction);
        case 'advance':           return handleAdvance(interaction);
        case 'set-phase':          return handleSetPhase(interaction);
        case 'reload-commands':    return handleReloadCommands(interaction);
        case 'move-coach':        return handleMoveCoach(interaction);
        case 'streamer':          return handleStreaming(interaction);
        case 'config':
          switch (interaction.options.getSubcommand()) {
            case 'view':     return handleConfigView(interaction);
            case 'features': return handleConfigFeatures(interaction);
            case 'edit':     return handleConfigEdit(interaction);
            case 'reload':     return handleConfigReload(interaction);
            case 'timezones':  return handleConfigTimezones(interaction);
          }
          break;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('accept-offer_')) return handleAcceptOffer(interaction);
    }
    


  } catch (err) {
    console.error('[interaction] Error:', err);
    const msg = { content: `❌ **Unexpected Error**\n\`\`\`${err.message}\`\`\`\nThis has been logged. If it keeps happening, try \`/config reload\` to refresh settings, or check your Render logs for details.`, flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// =====================================================
// MESSAGE LISTENER — Stream Reminders
// =====================================================
client.on(Events.MessageCreate, async (message) => {
  // Allow Wamellow (a bot) through — block all other bots
  if (!message.guildId) return;
  const isWamellow = message.author.bot && message.author.username.toLowerCase().includes('wamellow');
  if (message.author.bot && !isWamellow) return;

  const config = await getConfig(message.guildId).catch(() => null);
  if (!config?.setup_complete) return;
  if (!config?.feature_game_results_reminder) return;

  if (message.channel.name?.toLowerCase() !== config.channel_streaming?.toLowerCase()) return;

  // Extract a Twitch or YouTube URL from the message
  const streamRegex = /https?:\/\/(?:www\.)?(?:twitch\.tv|youtube\.com\/(?:live\/|channel\/|@)?|youtu\.be\/)([^\s<>"'\/]+)/i;
  const match = message.content.match(streamRegex);
  if (!match) return;

  const handle  = match[1].replace(/[?#].*$/, '').trim(); // strip query strings/fragments
  const minutes = config.stream_reminder_minutes || 45;

  if (isWamellow || message.author.bot) {
    // Wamellow posted — look up the coach by handle
    if (!handle) return;
    const streamer = await getStreamerByHandle(message.guildId, handle).catch(() => null);
    if (!streamer) {
      console.warn(`[stream] Wamellow posted handle "${handle}" but no matching coach found in coach_streams`);
      return;
    }
    console.log(`[stream] Wamellow post matched handle "${handle}" → user ${streamer.user_id}`);
    scheduleStreamReminder(message.channel, streamer.user_id, message.guildId, minutes);
  } else {
    // Coach posted their own link — tag them directly
    scheduleStreamReminder(message.channel, message.author.id, message.guildId, minutes);
  }
});

// =====================================================
// GUILD AUTO-SETUP
// =====================================================
async function initGuild(guild) {
  try {
    const { data } = await supabase.from('config').select('guild_id').eq('guild_id', guild.id).single();
    if (data) {
      console.log(`[guild] Config exists for ${guild.name} (${guild.id})`);
      return;
    }

    await createDefaultConfig(guild.id, guild.name);
    await supabase.from('meta').upsert({
      guild_id:          guild.id,
      season:            1,
      week:              1,
      current_phase:     'preseason',
      current_sub_phase: 0,
    }, { onConflict: 'guild_id' });
    console.log(`[guild] Auto-created config for: ${guild.name} (${guild.id})`);

    const setupMsg =
      `👋 **Thanks for adding Dynasty Bot to ${guild.name}!**\n\n` +
      `To get started, run \`/setup\` in your server and I'll walk you through the configuration via DM.\n\n` +
      `⚙️ Setup covers:\n` +
      `• League name & abbreviation\n` +
      `• Feature group selection\n` +
      `• Channel assignments\n` +
      `• Role assignments\n` +
      `• Feature-specific settings\n\n` +
      `Until setup is complete, commands will not be available to members.\n\n` +
      `⚠️ **Important:** Make sure the bot was invited using the correct link to ensure it has the right permissions:\nhttp://bit.ly/46t7pjs`;

    // Try DM first
    let dmSent = false;
    try {
      const owner = await guild.fetchOwner();
      await owner.send(setupMsg);
      dmSent = true;
      console.log(`[guild] Setup DM sent to owner of ${guild.name}`);
    } catch {
      console.warn(`[guild] Could not DM owner of ${guild.name} — falling back to channel`);
    }

    // Fall back to system channel, then first available text channel
    if (!dmSent) {
      const fallback =
        guild.systemChannel ||
        guild.channels.cache
          .filter(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages'))
          .sort((a, b) => a.position - b.position)
          .first();

      if (fallback) {
        const owner = await guild.fetchOwner().catch(() => null);
        const mention = owner ? `<@${owner.id}> ` : '';
        await fallback.send(mention + setupMsg).catch(err => {
          console.warn(`[guild] Could not post setup message in ${guild.name}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.error(`[guild] Failed to init ${guild.name} (${guild.id}):`, err.message);
  }
}

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[guild] Joined: ${guild.name} (${guild.id})`);
  await initGuild(guild);
});

// =====================================================
// BOT READY
// =====================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  await registerCommands();

  console.log(`[bot] Syncing ${c.guilds.cache.size} guild(s)...`);
  for (const guild of c.guilds.cache.values()) await initGuild(guild);
  console.log(`[bot] Ready! Serving ${c.guilds.cache.size} guild(s).`);

  expireJobOffers();
  setInterval(expireJobOffers, 30 * 60 * 1000);
});

// =====================================================
// LOGIN
// =====================================================
client.login(DISCORD_TOKEN);
