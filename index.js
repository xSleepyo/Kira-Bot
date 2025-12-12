// index.js

const Discord = require("discord.js");
const express = require("express");
const axios = require("axios");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const { setupDatabase, loadState, saveState, getState, getDbClient, globalState } = require('./src/database');
const { keepAlive, selfPing } = require('./src/utils');
const { 
    registerHandlers, 
    registerSlashCommands, 
    handleReactionRole, 
    handleMessageDelete 
} = require('./src/handlers');

// --- Global Crash Handlers ---
process.on("unhandledRejection", (error) => {
    console.error("CRITICAL UNHANDLED PROMISE REJECTION:", error);
});

process.on("uncaughtException", (error) => {
    console.error("CRITICAL UNCAUGHT EXCEPTION:", error);
    try {
        client.destroy();
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
        console.log("Bot initialization skipped: another process is likely running.");
        return;
    }
    botInitialized = true;
    console.log("Bot initialization started...");

    try {
        await setupDatabase();
        await loadState();

        // Pass globalState directly to keepAlive so it can manage the interval
        keepAlive(express(), axios, globalState); 
        
        client.login(token);
        
        // Register all listeners once the client is ready
        client.on(Events.ClientReady, async () => {
            console.log(`Logged in as ${client.user.tag}!`);
            
            // Register all handlers and commands
            registerHandlers(client);
            registerSlashCommands(client);

            // Handle persistence checks for restart completion
            if (globalState.restartChannelIdToAnnounce) {
                try {
                    const channel = await client.channels.fetch(globalState.restartChannelIdToAnnounce);
                    if (channel) {
                        await channel.send("✅ **Restart complete!** I am back online.");
                    }
                } catch (e) {
                    console.error("Failed to send restart completion message:", e);
                } finally {
                    // Clear the stored ID regardless of success/failure
                    await saveState(globalState.nextNumberChannelId, globalState.nextNumber, null);
                }
            }
            
            // Set bot status
            client.user.setPresence({
                activities: [{ name: "🎧 Listening to xSleepyo", type: Discord.ActivityType.Custom }],
                status: "online",
            });
        });

        // Register reaction and message delete listeners outside of ClientReady
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