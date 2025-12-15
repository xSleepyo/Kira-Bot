// src/index.js

const { Client, GatewayIntentBits, Events } = require("discord.js");
const dotenv = require("dotenv");
const express = require("express"); 
// FIX: Corrected import name to 'initializeDatabase'
const { initializeDatabase, loadState, loadMysteryBoxState, globalState, getDbClient } = require("./database"); 
const { registerHandlers, registerSlashCommands, handleReactionRole, handleMessageDelete } = require("./handlers");
const { keepAlive } = require("./utils");
const mysteryboxes = require("./mysteryboxes");
const countdowns = require("./countdown"); 

dotenv.config();

// Initialize the Express app for keep-alive
const app = express();

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
// ----------------------------


// --- Initialization Function ---
async function initializeBot(client, app) {
    try {
        // 1. Initialize Database
        // FIX: Using 'initializeDatabase' instead of 'setupDatabase'
        await initializeDatabase();
        
        // 2. Load Global State
        globalState.botState = await loadState();
        globalState.mysteryBoxState = await loadMysteryBoxState();

        // 3. Register all event handlers
        registerHandlers(client);

        // 4. Register slash commands and resume timers on ready
        // FIX: Using Events.ClientReady to resolve DeprecationWarning
        client.once(Events.ClientReady, async () => { 
            console.log(`Bot is ready! Logged in as ${client.user.tag}`);
            
            await registerSlashCommands(client);
            
            // 5. Resume features that rely on timers/intervals
            await mysteryboxes.resumeMysteryBoxTimer(client, globalState.mysteryBoxState);
            await countdowns.resumeCountdowns(client);
            
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
        
        // 7. Reaction Role and Message Delete Handlers
        const dbClient = getDbClient();
        client.on(Events.MessageReactionAdd, (reaction, user) => handleReactionRole(reaction, user, true, dbClient));
        client.on(Events.MessageReactionRemove, (reaction, user) => handleReactionRole(reaction, user, false, dbClient));
        client.on(Events.MessageDelete, (message) => handleMessageDelete(message, dbClient));

        // 8. FIX: Handle the client's internal error events
        client.on('error', (error) => {
            console.error('CRITICAL CLIENT ERROR (Client.on(\'error\')):', error);
        });

        // 9. Start the Keep-Alive Server
        keepAlive(app);

        // 10. Log in
        await client.login(process.env.TOKEN);

    } catch (error) {
        console.error("Bot failed to initialize due to critical error:", error);
        client.destroy();
        process.exit(1); 
    }
}

initializeBot(client, app);