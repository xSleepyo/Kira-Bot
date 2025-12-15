// src/index.js

const Discord = require("discord.js");
const express = require("express");
const axios = require("axios");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const { 
    setupDatabase, loadState, saveState, getState, getDbClient, globalState, 
} = require('./database'); 
const { keepAlive, selfPing } = require('./utils');
const { 
    registerHandlers, 
    registerSlashCommands, 
    handleReactionRole, 
    handleMessageDelete 
} = require('./handlers');
const { startMysteryBoxTimer } = require('./mysteryboxes'); 

const countdowns = require('./countdown'); // <--- NEW IMPORT
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

const token = process.env.TOKEN;

async function initializeBot() {
    if (botInitialized) {
        console.log("⚠️ Initialization blocked: Bot is already logged in or recently started.");
        return;
    }
    botInitialized = true;

    try {
        console.log("Starting database setup...");
        await setupDatabase();
        
        console.log("Loading global state...");
        await loadState(); 

        keepAlive(express, axios);
        registerHandlers(client); 
        selfPing(axios);

        await client.login(token);

        client.on(Events.ClientReady, async () => {
            console.log(`✅ Kira Bot is ready! Logged in as ${client.user.tag}`);

            await registerSlashCommands(client);
            
            // Check for pending restart announcement (Counting Game feature)
            if (globalState.restartChannelIdToAnnounce) {
                try {
                    const channel = await client.channels.fetch(globalState.restartChannelIdToAnnounce);
                    if (channel) {
                        await channel.send("✅ **Restart complete!** I am back online.");
                    }
                } catch (e) {
                    console.error("Failed to send restart completion message:", e);
                } finally {
                    await saveState(globalState.nextNumberChannelId, globalState.nextNumber, null);
                }
            }
            
            // --- Resume Mystery Box Timer ---
            if (globalState.mysteryBoxChannelId && globalState.mysteryBoxInterval) {
                console.log("[MYSTERY BOX] Checking for pending drop...");
                startMysteryBoxTimer(client, false); 
            }
            
            // --- Resume Active Countdowns (NEW) ---
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
            
            // Set bot status
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


    } catch (error) {
        console.error("Bot failed to initialize due to critical error:", error);
        botInitialized = false; 
    }
}

initializeBot();