require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

const commands = [
  new SlashCommandBuilder()
    .setName("joboffers")
    .setDescription("Get your Headset Dynasty job offers"),

  new SlashCommandBuilder()
    .setName("resetteam")
    .setDescription("Reset a user’s team and free it back up")
    .addUserOption(option =>
      option
        .setName("coach")
        .setDescription("The coach to reset")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("listteams")
    .setDescription("Post a list of available/taken teams")
].map(c => c.toJSON());

(async () => {
  try {
    console.log("Uploading commands...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("Commands uploaded.");
  } catch (err) {
    console.error(err);
  }
})();
