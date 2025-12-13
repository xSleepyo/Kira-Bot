// index.js
// ===== RENDER FILE VISIBILITY DEBUG =====
const fs = require("fs");
const path = require("path");

console.log("=== RENDER STARTUP DEBUG ===");
console.log("process.cwd():", process.cwd());
console.log("__filename:", __filename);
console.log("__dirname:", __dirname);

console.log("Does ./src exist?", fs.existsSync(path.join(process.cwd(), "src")));
console.log(
  "Does ./src/index.js exist?",
  fs.existsSync(path.join(process.cwd(), "src", "index.js"))
);

console.log(
  "Directory listing of cwd:",
  fs.readdirSync(process.cwd())
);

if (fs.existsSync(path.join(process.cwd(), "src"))) {
  console.log(
    "Directory listing of src/:",
    fs.readdirSync(path.join(process.cwd(), "src"))
  );
}

console.log("=== END DEBUG ===");
// =======================================

const Discord = require("discord.js");
const express = require("express");
const axios = require("axios");
const { Events } = require("discord.js");

// --- Import Modularized Components ---
const { 
    setupDatabase, loadState, saveState, getState, getDbClient, globalState, 
} = require('./database'); // Note: Assuming database.js is in src/ and this is index.js in src/
const { keepAlive, selfPing } = require('./utils');
const { 
    registerHandlers, 
    registerSlashCommands, 
    handleReactionRole, 
    handleMessageDelete 
} = require('./handlers');
const { startMysteryBoxTimer } = require('./mysteryboxes'); // <--- NEW IMPORT

// --- Global Crash Handlers ---
process.on("unhandledRejection", (error) => {
    console.error("CRITICAL UNHANDLED PROMISE REJECTION:", error);
});

process.on("uncaughtException", (error) => {
    console.error("CRITICAL UNCAUGHT EXCEPTION:", error);
    try {
        // Only attempt to destroy client if it exists and is ready
        if (client && client.isReady()) { 
             client.destroy();
        }
    } catch (e) {
        console.error("Failed to destroy client:", e);
    }
    process.exit(1);
});
// -----------------------------

// --- CRITICAL FIX: FLAG TO PREVENT DOUBLE INITIALIZATION ---
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
    // FIX: Prevents a second instance from logging in immediately if the host tries to spawn two processes.
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

        // Start Keep Alive Server (for Render)
        keepAlive(express, axios);

        // Register event handlers from src/handlers.js
        registerHandlers(client); 
        
        // Start self-ping to keep the service alive
        selfPing(axios);

        // --- Bot Login and Initialization ---
        await client.login(token);

        client.on(Events.ClientReady, async () => {
            console.log(`✅ Kira Bot is ready! Logged in as ${client.user.tag}`);

            // Register Slash Commands (must be done after client is ready)
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
                    // Clear the stored ID regardless of success/failure
                    await saveState(globalState.nextNumberChannelId, globalState.nextNumber, null);
                }
            }
            
            // --- Resume Mystery Box Timer (NEW) ---
            if (globalState.mysteryBoxChannelId && globalState.mysteryBoxInterval) {
                console.log("[MYSTERY BOX] Checking for pending drop...");
                // The 'false' parameter tells the function to use the stored 'next_drop_timestamp'
                startMysteryBoxTimer(client, false); 
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
        // Reset the flag so that a retry might work if the error was temporary
        botInitialized = false; 
    }
}

initializeBot();