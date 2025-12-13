const Discord = require("discord.js");
const express = require("express");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const {
    setupDatabase,
    loadState,
    saveState,
    getDbClient,
    globalState,
} = require("./database");

const { keepAlive, selfPing } = require("./utils");
const {
    registerHandlers,
    registerSlashCommands,
    handleReactionRole,
    handleMessageDelete,
} = require("./handlers");

const { startMysteryBoxTimer } = require("./mysteryboxes");

// --- Global Crash Handlers ---
process.on("unhandledRejection", (error) => console.error("CRITICAL UNHANDLED PROMISE REJECTION:", error));
process.on("uncaughtException", (error) => {
    console.error("CRITICAL UNCAUGHT EXCEPTION:", error);
    try { if (client && client.isReady()) client.destroy(); } catch (e) { console.error(e); }
    process.exit(1);
});

// --- Prevent double initialization ---
let botInitialized = false;

// --- Discord Client ---
const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
        Discord.Partials.Message,
        Discord.Partials.Channel,
        Discord.Partials.Reaction,
    ],
});

const token = process.env.TOKEN;

async function initializeBot() {
    if (botInitialized) return console.log("⚠️ Bot already started.");
    botInitialized = true;

    try {
        console.log("Starting database setup...");
        await setupDatabase();

        console.log("Loading global state...");
        await loadState();

        // --- Keep-alive server ---
        const app = express();
        keepAlive(app);   // Start web server
        selfPing();       // Start self-ping interval

        // --- Register handlers ---
        registerHandlers(client);

        // --- Login ---
        await client.login(token);

        client.once(Events.ClientReady, async () => {
            console.log(`✅ Kira Bot is ready! Logged in as ${client.user.tag}`);

            await registerSlashCommands(client);

            if (globalState.restartChannelIdToAnnounce) {
                try {
                    const channel = await client.channels.fetch(globalState.restartChannelIdToAnnounce);
                    if (channel) await channel.send("✅ **Restart complete!** I am back online.");
                } catch (e) { console.error("Failed to send restart completion message:", e); }
                finally { await saveState(globalState.nextNumberChannelId, globalState.nextNumber, null); }
            }

            if (globalState.mysteryBoxChannelId && globalState.mysteryBoxInterval) {
                console.log("[MYSTERY BOX] Resuming timer...");
                startMysteryBoxTimer(client, false);
            }

            client.user.setPresence({
                activities: [{ name: "🎧 Listening to xSleepyo", type: Discord.ActivityType.Custom }],
                status: "online",
            });
        });

        // --- Reaction / message listeners ---
        client.on("messageReactionAdd", (reaction, user) =>
            handleReactionRole(reaction, user, true, getDbClient())
        );

        client.on("messageReactionRemove", (reaction, user) =>
            handleReactionRole(reaction, user, false, getDbClient())
        );

        client.on("messageDelete", (message) =>
            handleMessageDelete(message, getDbClient())
        );

    } catch (error) {
        console.error("Bot failed to initialize due to critical error:", error);
        botInitialized = false;
    }
}

initializeBot();
