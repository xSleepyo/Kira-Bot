// src/index.js

const { Client, GatewayIntentBits, Events } = require("discord.js");
const dotenv = require("dotenv");
const express = require("express"); // <-- ADDITION: Import Express
const { initializeDatabase, loadState, loadMysteryBoxState, globalState } = require("./database");
const { registerHandlers, registerSlashCommands, handleReactionRole, handleMessageDelete } = require("./handlers");
const { keepAlive } = require("./utils");
const mysteryboxes = require("./mysteryboxes");
const countdowns = require("./countdown"); // <-- IMPORT: countdowns

dotenv.config();

// Initialize the Express app for keep-alive (CRITICAL FIX)
const app = express(); // <-- FIX: Initialize Express app

// --- Discord Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});


// --- Initialization Function ---
async function initializeBot(client, app) {
    try {
        // 1. Initialize Database
        await initializeDatabase();
        
        // 2. Load Global State
        globalState.botState = await loadState();
        globalState.mysteryBoxState = await loadMysteryBoxState(); // <-- LOAD NEW MYSTERY BOX STATE

        // 3. Register all event handlers
        registerHandlers(client);

        // 4. Register slash commands and resume timers on ready
        client.once("ready", async () => {
            console.log(`Bot is ready! Logged in as ${client.user.tag}`);
            
            await registerSlashCommands(client);
            
            // 5. Resume features that rely on timers/intervals
            await mysteryboxes.resumeMysteryBoxTimer(client, globalState.mysteryBoxState);
            await countdowns.resumeCountdowns(client); // <-- RESUME COUNTDOWNS
            
            // 6. Handle post-restart message (if necessary)
            const restartChannelId = globalState.botState.restart_channel_id;
            if (restartChannelId) {
                const channel = await client.channels.fetch(restartChannelId).catch(() => null);
                if (channel) {
                    await channel.send("✅ Bot restart complete. All systems online.");
                    globalState.botState.restart_channel_id = null;
                    const { next_number_channel_id, next_number } = globalState.botState;
                    await require('./database').saveState(next_number_channel_id, next_number, null);
                }
            }
        });
        
        // 7. Reaction Role Handlers
        const dbClient = require('./database').getDbClient();
        client.on(Events.MessageReactionAdd, (reaction, user) => handleReactionRole(reaction, user, true, dbClient));
        client.on(Events.MessageReactionRemove, (reaction, user) => handleReactionRole(reaction, user, false, dbClient));

        // 8. Message Delete Handler
        client.on(Events.MessageDelete, (message) => handleMessageDelete(message, dbClient));

        // 9. Start the Keep-Alive Server
        keepAlive(app); // <-- FIX: Pass the initialized Express app

        // 10. Log in
        await client.login(process.env.TOKEN);

    } catch (error) {
        console.error("Bot failed to initialize due to critical error:", error);
        client.destroy();
        process.exit(1); 
    }
}

initializeBot(client, app); // <-- FIX: Pass the initialized Express app