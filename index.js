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
  ChannelType,
  PermissionFlagsBits,
  Partials
} = require('discord.js');

const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Load teams.json
let teams = [];
try {
  teams = JSON.parse(fs.readFileSync('./teams.json'));
} catch (e) {
  console.error("Error reading teams.json:", e);
  teams = { conferences: [] };
}

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
// REGISTER GUILD COMMANDS (testing)
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

  // Test Supabase connection
  (async () => {
    const { data, error } = await supabase
      .from("teams")
      .select("id")
      .limit(1);

    console.log("Supabase test:", { data, error });
  })();
});

// ---------------------------------------------------------
// AUTO-COMPLETE
// ---------------------------------------------------------

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === "opponent") {
      const search = focused.value.toLowerCase();

      const list = [];
      for (const conf of teams.conferences) {
        for (const t of conf.teams) {
          if (t.name.toLowerCase().includes(search)) {
            list.push(t.name);
          }
        }
      }

      return interaction.respond(
        list.slice(0, 25).map(x => ({ name: x, value: x }))
      );
    }
  }

  if (!interaction.isCommand()) return;
  const name = interaction.commandName;

  // ---------------------------------------------------------
  // COMMAND: /joboffers
  // ---------------------------------------------------------
  if (name === "joboffers") {
    if (jobOfferUsed.has(interaction.user.id)) {
      return interaction.reply({
        ephemeral: true,
        content: "⛔ You already received a job offer."
      });
    }

    jobOfferUsed.add(interaction.user.id);

    // Old system: any 2★ or below team not taken
    const available = [];
    for (const conf of teams.conferences) {
      for (const t of conf.teams) {
        if (!t.takenBy && t.stars <= 2) available.push(t);
      }
    }

    if (available.length === 0) {
      return interaction.reply({
        ephemeral: true,
        content: "No teams available."
      });
    }

    let options = [...available];
    let offers = [];

    for (let i = 0; i < 5 && options.length > 0; i++) {
      const idx = Math.floor(Math.random() * options.length);
      offers.push(options[idx]);
      options.splice(idx, 1);
    }

    if (!client.userOffers) client.userOffers = {};
    client.userOffers[interaction.user.id] = offers;

    try {
      await interaction.user.send(
        `Your job offers:\n\n` +
        offers.map((t, i) => `${i + 1}️⃣ ${t.name}`).join("\n\n") +
        "\n\nReply with the number to accept."
      );

      return interaction.reply({
        ephemeral: true,
        content: "Check your DMs!"
      });

    } catch (err) {
      return interaction.reply({
        ephemeral: true,
        content: "I cannot DM you. Enable DMs."
      });
    }
  }

  // ---------------------------------------------------------
  // COMMAND: /resetteam
  // ---------------------------------------------------------
  if (name === "resetteam") {
    const coach = interaction.options.getUser("coach");

    let team = null;
    for (const conf of teams.conferences) {
      for (const t of conf.teams) {
        if (t.takenBy === coach.id) team = t;
      }
    }

    if (!team) {
      return interaction.reply({
        ephemeral: true,
        content: `${coach.username} has no team.`
      });
    }

    team.takenBy = null;
    jobOfferUsed.delete(coach.id);
    fs.writeFileSync("./teams.json", JSON.stringify(teams, null, 2));

    return interaction.reply({
      ephemeral: true,
      content: `Reset team ${team.name}.`
    });
  }

  // ---------------------------------------------------------
  // COMMAND: /listteams
  // ---------------------------------------------------------
  if (name === "listteams") {
    await interaction.deferReply({ ephemeral: true });

    await sendTeamList(client);

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

  // Claim team
  for (const conf of teams.conferences) {
    for (const t of conf.teams) {
      if (t.name === team.name) {
        t.takenBy = userId;
      }
    }
  }

  fs.writeFileSync("./teams.json", JSON.stringify(teams, null, 2));

  msg.reply(`You claimed **${team.name}**!`);
  delete client.userOffers[userId];
});

// ---------------------------------------------------------
// SUPPORTING: Send team list
// ---------------------------------------------------------

async function sendTeamList(client) {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const channel = guild.channels.cache.find(c => c.name === "member-list");
  if (!channel) return;

  const data = JSON.parse(fs.readFileSync('./teams.json'));
  let text = "";

  for (const conf of data.conferences) {
    text += `\n__**${conf.name}**__\n`;
    const low = conf.teams.filter(t => t.stars <= 2);

    for (const t of low) {
      if (t.takenBy) {
        text += `❌ **${t.name}** — <@${t.takenBy}>\n`;
      } else {
        text += `🟢 **${t.name}** — Available\n`;
      }
    }
  }

  const embed = {
    title: "2★ and Below Teams",
    description: text,
    color: 0x2b2d31,
    timestamp: new Date()
  };

  await channel.send({ embeds: [embed] });
}

client.login(process.env.DISCORD_TOKEN);
