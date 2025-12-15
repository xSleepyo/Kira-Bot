// src/index.js

const { Client, GatewayIntentBits, Events } = require("discord.js");
const dotenv = require("dotenv");
const express = require("express"); 
// Import all necessary functions from database.js
const { setupDatabase, loadState, saveState, globalState, getDbClient } = require("./database"); 
const { registerHandlers, registerSlashCommands, handleReactionRole, handleMessageDelete } = require("./handlers");
const { keepAlive } = require("./utils");
// FIX: Importing the correct function name (startMysteryBoxTimer) to fix the TypeError
const { startMysteryBoxTimer } = require("./mysteryboxes"); 
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
        await setupDatabase(); // Using setupDatabase to match your export
        
        // 2. Load Global State (updates properties on the globalState object)
        await loadState(); 

        // 3. Register all event handlers
        registerHandlers(client);

        // 4. Register slash commands and resume timers on ready
        client.once(Events.ClientReady, async () => { // FIX: Using Events.ClientReady
            console.log(`Bot is ready! Logged in as ${client.user.tag}`);
            
            await registerSlashCommands(client);
            
            // 5. Resume features that rely on timers/intervals
            // FIX: Corrected function call to startMysteryBoxTimer
            await startMysteryBoxTimer(client, globalState); 
            await countdowns.resumeCountdowns(client);
            
            // 6. Handle post-restart message (if necessary)
            const restartChannelId = globalState.restartChannelIdToAnnounce; // Accessing the correct globalState property
            if (restartChannelId) {
                const channel = await client.channels.fetch(restartChannelId).catch(() => null);
                if (channel) {
                    await channel.send("✅ Bot restart complete. All systems online.");
                    
                    // Clear the restart flag in the database
                    const nextChannelId = globalState.nextNumberChannelId;
                    const nextNumber = globalState.nextNumber;
                    await saveState(nextChannelId, nextNumber, null); 
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
        keepAlive(app); // Assumes keepAlive and app are defined

        // 10. Log in
        await client.login(process.env.TOKEN);

    } catch (error) {
        console.error("Bot failed to initialize due to critical error:", error);
        client.destroy();
        process.exit(1); 
    }
}

initializeBot(client, app);