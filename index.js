require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 3000;

// Minimal health server for Render
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

// ---------------------------------------------------------
// DISCORD + SUPABASE
// ---------------------------------------------------------

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
  Partials
} = require('discord.js');

const { createClient } = require("@supabase/supabase-js");

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const jobOfferUsed = new Set();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ]
});

// ---------------------------------------------------------
// REGISTER GUILD COMMANDS
// ---------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('joboffers')
    .setDescription('Get your Headset Dynasty job offers')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('resetteam')
    .setDescription('Reset a user’s team')
    .addUserOption(option =>
      option
        .setName('coach')
        .setDescription('The coach to reset')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('listteams')
    .setDescription('Post a list of taken and available teams'),

  new SlashCommandBuilder()
    .setName('game-result')
    .setDescription('Submit a game result')
    .addStringOption(option =>
      option.setName('opponent')
        .setDescription('Opponent team')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option
        .setName('your_score')
        .setDescription('Your team score')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('opponent_score')
        .setDescription('Opponent score')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('summary')
        .setDescription('Game summary')
        .setRequired(true)
    )
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log("Commands registered.");
  } catch (err) {
    console.error(err);
  }
})();

// ---------------------------------------------------------
// BOT READY
// ---------------------------------------------------------

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------------------------------------------------------
// SLASH COMMANDS
// ---------------------------------------------------------

client.on('interactionCreate', async interaction => {
  // -----------------------
  // /joboffers
  // -----------------------
  if (interaction.isCommand() && interaction.commandName === 'joboffers') {
    if (jobOfferUsed.has(interaction.user.id)) {
      return interaction.reply({
        ephemeral: true,
        content: "⛔ You already received a job offer."
      });
    }

    jobOfferUsed.add(interaction.user.id);

    // Fetch all teams from Supabase
    const { data: allTeams, error } = await supabase
      .from("teams")
      .select("*");

    if (error) {
      console.error(error);
      return interaction.reply({ ephemeral: true, content: "Error fetching teams." });
    }

    // Filter: stars <= 2.0, not taken
    const available = allTeams.filter(t => parseFloat(t.stars) <= 2.0 && !t.takenBy);

    if (!available.length) return interaction.reply({ ephemeral: true, content: "No teams available." });

    // Randomly pick up to 5 offers
    let options = [...available];
    let offers = [];
    for (let i = 0; i < 5 && options.length > 0; i++) {
      const idx = Math.floor(Math.random() * options.length);
      offers.push(options[idx]);
      options.splice(idx, 1);
    }

    if (!client.userOffers) client.userOffers = {};
    client.userOffers[interaction.user.id] = offers;

    // Group by conference
    const grouped = {};
    offers.forEach(t => {
      if (!grouped[t.conference]) grouped[t.conference] = [];
      grouped[t.conference].push(t);
    });

    let dmText = '';
    for (const conf in grouped) {
      dmText += `__**${conf}**__\n`;
      grouped[conf].forEach((t, i) => {
        dmText += `${i + 1}️⃣ ${t.name} (${t.stars}★)\n`;
      });
      dmText += '\n';
    }

    try {
      await interaction.user.send(`Your job offers:\n\n${dmText}Reply with the number to accept.`);
      return interaction.reply({ ephemeral: true, content: "Check your DMs!" });
    } catch (err) {
      return interaction.reply({ ephemeral: true, content: "I cannot DM you. Enable DMs." });
    }
  }

  // -----------------------
  // /resetteam
  // -----------------------
  if (interaction.isCommand() && interaction.commandName === 'resetteam') {
    const coach = interaction.options.getUser('coach');

    const { data: userTeams, error } = await supabase
      .from("teams")
      .select("*")
      .eq("takenBy", coach.id)
      .limit(1);

    if (error) {
      console.error(error);
      return interaction.reply({ ephemeral: true, content: "Error fetching team." });
    }

    if (!userTeams || !userTeams.length) {
      return interaction.reply({ ephemeral: true, content: `${coach.username} has no team.` });
    }

    const team = userTeams[0];

    await supabase.from("teams").update({ takenBy: null }).eq("id", team.id);
    jobOfferUsed.delete(coach.id);

    return interaction.reply({ ephemeral: true, content: `Reset team ${team.name}.` });
  }

  // -----------------------
  // /listteams (Step 4)
  // -----------------------
  if (interaction.isCommand() && interaction.commandName === 'listteams') {
    await interaction.deferReply({ ephemeral: true });

    // Fetch teams grouped by conference
    const { data: allTeams, error } = await supabase.from("teams").select("*");
    if (error) return interaction.editReply("Error fetching teams.");

    const grouped = {};
    allTeams.filter(t => parseFloat(t.stars) <= 2.0).forEach(t => {
      if (!grouped[t.conference]) grouped[t.conference] = [];
      grouped[t.conference].push(t);
    });

    let text = '';
    for (const conf in grouped) {
      text += `\n__**${conf}**__\n`;
      grouped[conf].forEach(t => {
        text += t.takenBy ? `❌ **${t.name}** — <@${t.takenBy}>\n` : `🟢 **${t.name}** — Available\n`;
      });
    }

    const guild = client.guilds.cache.first();
    if (!guild) return interaction.editReply("No guild found.");

    const channel = guild.channels.cache.find(c => c.name === "member-list");
    if (!channel) return interaction.editReply("No 'member-list' channel found.");

    const embed = {
      title: "2★ and Below Teams",
      description: text,
      color: 0x2b2d31,
      timestamp: new Date()
    };

    await channel.send({ embeds: [embed] });
    return interaction.editReply("Team list updated.");
  }
});

// ---------------------------------------------------------
// DM ACCEPT OFFER
// ---------------------------------------------------------

client.on("messageCreate", async msg => {
  if (msg.guild || msg.author.bot) return;

  const userId = msg.author.id;
  if (!client.userOffers || !client.userOffers[userId]) return;

  const offers = client.userOffers[userId];
  const choice = parseInt(msg.content);

  if (isNaN(choice) || choice < 1 || choice > offers.length) {
    return msg.reply("Reply with the number of the team you choose.");
  }

  const team = offers[choice - 1];

  // Claim team in Supabase
  const { error } = await supabase.from("teams").update({ takenBy: userId }).eq("id", team.id);

  if (error) {
    console.error(error);
    return msg.reply("Error claiming team. Try again.");
  }

  msg.reply(`You claimed **${team.name}**!`);
  delete client.userOffers[userId];
});

// ---------------------------------------------------------
// AUTO-COMPLETE
// ---------------------------------------------------------

client.on('interactionCreate', async interaction => {
  if (!interaction.isAutocomplete()) return;
  const focused = interaction.options.getFocused(true);

  if (focused.name === "opponent") {
    const search = focused.value.toLowerCase();

    const { data: allTeams, error } = await supabase.from("teams").select("name");
    if (error || !allTeams) return interaction.respond([]);

    const list = allTeams
      .filter(t => t.name.toLowerCase().includes(search))
      .slice(0, 25)
      .map(x => ({ name: x.name, value: x.name }));

    return interaction.respond(list);
  }
});

client.login(process.env.DISCORD_TOKEN);
