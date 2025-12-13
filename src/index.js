// index.js

require("dotenv").config();
const Discord = require("discord.js");
const { IntentsBitField } = require("discord.js");

const { setupDatabase, loadState, globalState, getDbClient } = require("./database");
const { registerHandlers, registerSlashCommands, handleReactionRole, handleMessageDelete } = require("./handlers");
const { startMysteryBoxTimer } = require("./mysteryboxes"); // NEW IMPORT

const token = process.env.DISCORD_TOKEN;
const selfPingUrl = process.env.SELF_PING_URL;
const PREFIX = process.env.PREFIX || ".";


// ----------------------------------------------------
// --- Client Initialization and Intents ---
// ----------------------------------------------------

const client = new Discord.Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessageReactions,
    ],
    partials: [
        Discord.Partials.Message, 
        Discord.Partials.Channel, 
        Discord.Partials.Reaction
    ],
});

// ----------------------------------------------------
// --- Bot Startup ---
// ----------------------------------------------------

client.on("ready", async () => {
    console.log(`\n🤖 Logged in as ${client.user.tag}!`);

    try {
        // 1. Database Setup & Load
        await setupDatabase();
        await loadState(client); // Pass client to loadState to resume timers
        
        // 2. Resume Mystery Box Timer
        if (globalState.mysteryBoxChannelId && globalState.mysteryBoxInterval && globalState.mysteryBoxNextDrop) {
             startMysteryBoxTimer(client);
        }

        // 3. Register Commands & Handlers
        await registerSlashCommands(client);
        registerHandlers(client);
        registerCustomReactionHandlers();
        
        // 4. Restart Announcement Check
        if (globalState.restartChannelIdToAnnounce) {
            const channel = await client.channels.fetch(globalState.restartChannelIdToAnnounce).catch(() => null);
            if (channel) {
                await channel.send("✅ Bot has been restarted and is back online!");
            }
            // Clear the announcement flag in the DB
            await getDbClient().query(`UPDATE counting SET restart_channel_id = NULL WHERE id = 1`);
        }

        // 5. Set Activity Status
        client.user.setActivity(`${PREFIX}help | ${client.guilds.cache.size} servers`, {
            type: Discord.ActivityType.Watching,
        });

        // 6. Start Self-Ping (If configured)
        if (selfPingUrl) {
            const http = require("http");
            globalState.selfPingInterval = setInterval(() => {
                http.get(selfPingUrl).on("error", (err) => {
                    console.error("Self-ping failed:", err.message);
                });
            }, 5 * 60 * 1000); // Ping every 5 minutes
            console.log("✅ Self-ping interval started.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR during bot startup:", error);
        // Cleanly exit if setup fails
        process.exit(1); 
    }
});

// ----------------------------------------------------
// --- Reaction and Delete Handlers ---
// ----------------------------------------------------

function registerCustomReactionHandlers() {
    const dbClient = getDbClient();

    client.on(Discord.Events.MessageReactionAdd, (reaction, user) => 
        handleReactionRole(reaction, user, true, dbClient)
    );

    client.on(Discord.Events.MessageReactionRemove, (reaction, user) => 
        handleReactionRole(reaction, user, false, dbClient)
    );

    client.on(Discord.Events.MessageDelete, (message) => 
        handleMessageDelete(message, dbClient)
    );
}

// ----------------------------------------------------
// --- Login ---
// ----------------------------------------------------

client.login(token);