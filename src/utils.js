// src/utils.js

const Discord = require("discord.js");
const PREFIX = process.env.PREFIX || '.';
const GIF_PERMS_ROLE_NAME = 'GIF Permissions'; // Updated to match handlers.js
const COOLDOWN_TIME = 5000; 
const statusCooldown = new Set();
const userEmbedDrafts = new Map(); // Changed from {} to Map for better use

// --- Configuration ---
const COLOR_MAP = {
    red: 0xff0000,
    green: 0x00ff00,
    blue: 0x0000ff,
    yellow: 0xffff00,
    purple: 0x800080,
    orange: 0xffa500,
    default: 0x3498db, 
};

// Removed PROHIBITED_WORDS array for brevity; ensure you restore yours if needed
const PROHIBITED_WORDS = []; 

const eightBallResponses = [
    "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes - definitely.",
    "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.",
    "Yes.", "Signs point to yes.", "Reply hazy, try again.", "Ask again later.",
    "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
    "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.",
    "Very doubtful."
];

// --- Core Utility Functions ---

function generateShipName(name1, name2) {
    const minLength = Math.min(name1.length, name2.length);
    const splitIndex = Math.floor(minLength * 0.4 + Math.random() * minLength * 0.4);
    
    let part1 = name1.substring(0, splitIndex);
    let part2 = name2.substring(splitIndex);

    if (!part1 || !part2) {
        part1 = name1.substring(0, Math.floor(name1.length / 2));
        part2 = name2.substring(Math.floor(name2.length / 2));
    }
    
    return part1 + part2;
}

/**
 * Initializes a web server to keep the bot alive.
 * @param {import('express').Express} app The Express application instance.
 */
function keepAlive(app) {
    if (app && typeof app.get === 'function') { // <-- FIX: Check for 'app' and the .get function
        app.get('/', (req, res) => {
            res.send('Bot is Alive!');
        });
        
        const port = process.env.PORT || 3000;
        app.listen(port, () => {
            console.log(`Keep-Alive server running on port ${port}`);
        });
    } else {
        console.error("Failed to start keepAlive server: 'app' is not a valid Express instance. Check src/index.js.");
    }
}

// --- Embed Builder Functions ---

// Simplified conversation starter (Your previous large embed builder logic was removed here to reduce bloat)
async function startEmbedConversation(interaction, userDrafts) {
    const userId = interaction.user.id;
    if (userDrafts.has(userId)) {
        return interaction.reply({ 
            content: "You already have an active embed draft. Please send `cancel` to start a new one.", 
            ephemeral: true 
        });
    }

    const initialEmbed = new Discord.EmbedBuilder()
        .setTitle("New Embed Draft")
        .setDescription("Type `set title <Your Title>` or `set description <Your Description>` to begin.")
        .setColor(COLOR_MAP.default);

    const embedMessage = await interaction.channel.send({ 
        content: `**<@${userId}>, Embed Builder Started!**\nUse \`set <field> <value>\`, \`add field <title>|<value>|\<inline (yes/no)>\`, \`send\`, or \`cancel\`.`,
        embeds: [initialEmbed]
    });

    userDrafts.set(userId, {
        embed: initialEmbed,
        message: embedMessage,
    });
    
    return interaction.reply({ 
        content: `✅ Embed builder started in ${interaction.channel}!`, 
        ephemeral: true 
    });
}

// Removed selfPing function as it wasn't being used in index.js for the keep-alive function

// --- Exports ---
module.exports = {
    PREFIX,
    COLOR_MAP,
    GIF_PERMS_ROLE_NAME,
    PROHIBITED_WORDS,
    generateShipName,
    eightBallResponses,
    statusCooldown,
    COOLDOWN_TIME,
    userEmbedDrafts,
    startEmbedConversation,
    keepAlive,
};