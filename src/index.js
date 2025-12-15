// src/index.js

const Discord = require("discord.js");
const express = require("express");
const axios = require("axios");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const { 
    setupDatabase, loadState, saveState, getDbClient, globalState, loadConfig // Added loadConfig
} = require('./database'); 
const { keepAlive, selfPing } = require('./utils');
const { 
    registerHandlers, 
    registerSlashCommands, 
    handleReactionRole, 
    handleMessageDelete 
} = require('./handlers');
const { startMysteryBoxTimer } = require('./mysteryboxes'); 

const countdowns = require('./countdown'); 
// ------------------------------------

// --- Global Crash Handlers ---
process.on("unhandledRejection", (error) => {
    console.error("CRITICAL UNHANDLED PROMISE REJECTION:", error);
});

process.on("uncaughtException", (error) => {
    console.error("CRITICAL UNCAUGHT EXCEPTION:", error);
    try {
        if (client && client.isReady()) { 
             client.destroy();
        }
    } catch (e) {
        console.error("Failed to destroy client:", e);
    }
    process.exit(1);
});
// -----------------------------

let botInitialized = false;

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

async function initializeBot() {
    if (botInitialized) return;

    try {
        // 1. Initialize Database
        await setupDatabase();
        await loadState();

        // 2. Start Keep Alive Server (for web service hosting like Render/Heroku)
        keepAlive(client);
        
        // 3. Register Event Handlers (messageCreate, interactionCreate)
        registerHandlers(client);

        // 4. Login to Discord
        await client.login(process.env.DISCORD_TOKEN);

        // 5. Ready Event
        client.on(Events.ClientReady, async () => {
            if (!client.user) {
                console.error("Client user is null on ready.");
                return;
            }

            // A. Set the ready state
            globalState.isReady = true;
            console.log(`Bot is ready! Logged in as ${client.user.tag}`);

            // B. Load Config for all Guilds (NEW)
            for (const guild of client.guilds.cache.values()) {
                await loadConfig(guild.id);
                console.log(`[CONFIG] Loaded settings for guild: ${guild.name}`);
            }

            // C. Register Commands
            await registerSlashCommands(client);

            // D. Handle Restart Announcement
            if (globalState.restartChannelIdToAnnounce) {
                try {
                    const channel = await client.channels.fetch(globalState.restartChannelIdToAnnounce);
                    if (channel) {
                        channel.send("✅ Bot restart complete. All systems online.");
                    }
                } catch (e) {
                    console.error("Failed to announce restart:", e);
                }
                await saveState(globalState.nextNumberChannelId, globalState.nextNumber, null); // Clear announcement ID
            }
            
            // E. Start Timers (Mystery Boxes)
            if (globalState.mysteryBoxChannelId && globalState.mysteryBoxInterval) {
                startMysteryBoxTimer(client, false); 
            }
            
            // F. Resume Active Countdowns
            if (globalState.activeCountdowns.length > 0) {
                console.log(`[COUNTDOWN] Resuming ${globalState.activeCountdowns.length} active countdown(s)...`);
                for (const countdown of globalState.activeCountdowns) {
                    countdowns.startCountdownTimer(
                        client, 
                        countdown.channel_id, 
                        countdown.message_id, 
                        countdown.title, 
                        Number(countdown.target_timestamp) 
                    );
                }
            }
            
            // G. Set bot status
            client.user.setPresence({
                activities: [{ name: "🎧 Listening to xSleepyo", type: Discord.ActivityType.Custom }],
                status: "online",
            });
        });

        // 6. Reaction and Message Delete Handlers (Attached to client outside the ready event)
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