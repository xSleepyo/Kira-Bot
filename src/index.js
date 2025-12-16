// src/index.js

const Discord = require("discord.js");
const express = require("express"); // ADDED: Required to create the app instance
const axios = require("axios");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const { 
    setupDatabase, 
    loadState, 
    getDbClient, 
    globalState, 
    clearLastRestartChannel // <--- ADDED: Function to clear the saved channel ID
} = require('./database'); 
// [FIXED] keepAlive is the function that needs the app, so we import express here
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
    console.error("CRITICAL UNCAUGHT EXCEPTION:\t", error);
    try {
        if (client && client.isReady()) { 
             client.destroy();
        }
    } catch (e) {
        console.error("Failed to destroy client:\t", e);
    }
    // [FIXED] Exit after unhandled exception
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
    // Removed partials since it's not strictly necessary for this set of handlers
});

/**
 * Initializes the bot, database, and keepAlive server.
 */
async function initializeBot() {
    try {
        // 1. Database Setup and State Load
        await setupDatabase();
        await loadState();

        // 2. Start Keep-Alive Server
        const app = express(); // [FIXED] Initialize Express application
        keepAlive(app);        // [FIXED] Pass the app instance to keepAlive

        // 3. Register General Handlers
        registerHandlers(client);

        // 4. Log in the bot (This is where the TOKEN error occurs)
        await client.login(process.env.TOKEN);

        // 5. Client Ready Event
        client.on(Events.ClientReady, async () => {
            console.log(`\n✅ Bot is ready! Logged in as ${client.user.tag}`);

            // --- RESTART COMPLETION CHECK (ADDED LOGIC) ---
            if (globalState.lastRestartChannelId) {
                const channelId = globalState.lastRestartChannelId;
                const channel = client.channels.cache.get(channelId);
                
                if (channel) {
                    await channel.send("✅ **Restart complete.** I'm back online!");
                } else {
                    console.log(`Warning: Failed to find channel with ID ${channelId} to send restart message.`);
                }

                // Clear the flag immediately after trying to send the message
                await clearLastRestartChannel().catch(console.error);
            }
            // ----------------------------------------------
            
            // A. Register Slash Commands
            await registerSlashCommands(client);
            
            // B. Resume Keep-Alive Ping (if needed)
            if (process.env.PING_URL) {
                console.log("[KEEP-ALIVE] Starting self-ping timer.");
                selfPing();
            }

            // C. Start Mystery Box Timer
            if (globalState.mysteryBoxChannelId) {
                console.log("[MYSTERY BOX] Starting drop timer...");
                startMysteryBoxTimer(client, false);
            }
            
            // D. Resume Countdowns
            if (countdowns.resumeCountdowns) { // Check if function exists
                countdowns.resumeCountdowns(client); 
            } else if (globalState.activeCountdowns.length > 0) {
                 // Fallback if the utility function wasn't imported/updated correctly
                console.log(`[COUNTDOWN] Resuming ${globalState.activeCountdowns.length} active countdown(s)...`);
                for (const countdown of globalState.activeCountdowns) {
                    // Assuming startCountdownTimer now expects an object structure for channel/message ID
                    countdowns.startCountdownTimer(
                        client, 
                        countdown.channel_id, 
                        countdown.message_id, 
                        countdown.title, 
                        Number(countdown.target_timestamp) 
                    );
                }
            }
            
            // E. Set bot status
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
        // Do not exit here to allow manual token fix if needed, but log the error clearly
        // For production, you might want to process.exit(1) on token error.
        botInitialized = false; 
    }
}

initializeBot();