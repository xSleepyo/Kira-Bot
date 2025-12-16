// src/index.js

const Discord = require("discord.js");
const express = require("express"); 
const axios = require("axios");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const { 
    setupDatabase, 
    loadState, 
    getDbClient, 
    globalState,
    clearLastRestartChannel 
} = require('./database'); 

const utils = require('./utils');
const { 
    registerHandlers, 
    registerSlashCommands, 
    handleReactionRole, 
    handleMessageDelete 
} = require('./handlers');
const { startMysteryBoxTimer } = require('./mysteryboxes'); 

const countdowns = require('./countdown'); 

// --- Global Crash Handlers ---
process.on("unhandledRejection", (error) => {
    console.error("CRITICAL UNHANDLED PROMISE REJECTION:", error);
});

process.on("uncaughtException", (error) => {
    console.error("CRITICAL UNCAUGHT EXCEPTION:\t", error);
    try {
        if (client && client.isReady()) { 
             client.destroy();
        }
    } catch (e) {
        console.error("Failed to destroy client:\t", e);
    }
    process.exit(1); 
});

let botInitialized = false;

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMessageReactions,
    ],
});

async function initializeBot() {
    try {
        await setupDatabase();
        await loadState();

        const app = express(); 
        const PORT = process.env.PORT || 3000;

        app.get('/', (req, res) => res.send('Bot is online!'));

        app.listen(PORT, () => {
            console.log(`[SERVER] Health check server listening on port ${PORT}`);
        });

        // Correctly call keepAlive from the utils object
        if (utils.keepAlive) utils.keepAlive(app);

        registerHandlers(client);
        await client.login(process.env.TOKEN);

        client.on(Events.ClientReady, async () => {
            console.log(`\n✅ Bot is ready! Logged in as ${client.user.tag}`);

            if (globalState.restartChannelIdToAnnounce) {
                const channelId = globalState.restartChannelIdToAnnounce;
                const channel = client.channels.cache.get(channelId);
                if (channel) await channel.send("✅ **Restart complete.** I'm back online!");
                await clearLastRestartChannel().catch(console.error);
            }
            
            await registerSlashCommands(client);
            
            // Correctly call selfPing from the utils object
            if (process.env.PING_URL && utils.selfPing) {
                console.log("[KEEP-ALIVE] Starting self-ping timer.");
                utils.selfPing(); 
            }

            if (globalState.mysteryBoxChannelId) {
                console.log("[MYSTERY BOX] Starting drop timer...");
                startMysteryBoxTimer(client, false);
            }
            
            if (countdowns.resumeCountdowns) { 
                countdowns.resumeCountdowns(client);
            }
            
            client.user.setPresence({
                activities: [{ name: "🎧 Listening to xSleepyo", type: Discord.ActivityType.Custom }],
                status: "online",
            });
        });

        client.on("messageReactionAdd", (reaction, user) =>
            handleReactionRole(reaction, user, true, getDbClient()),
        );
        client.on("messageReactionRemove", (reaction, user) =>
            handleReactionRole(reaction, user, false, getDbClient()),
        );
        client.on("messageDelete", (message) => handleMessageDelete(message, getDbClient()));

        botInitialized = true;
    } catch (error) {
        console.error("Bot failed to initialize due to critical error:", error);
        botInitialized = false; 
    }
}

initializeBot();