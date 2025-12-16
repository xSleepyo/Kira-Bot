// src/utils.js

const Discord = require("discord.js");
const axios = require("axios"); // Added for self-ping functionality

// --- CONSTANTS ---
const PREFIX = ".";

const COLOR_MAP = {
    default: "#3498db", 
    green: "#2ecc71",
    red: "#e74c3c",
    purple: "#9b59b6",
    blue: "#3498db",
    orange: "#e67e22",
};

const GIF_PERMS_ROLE_NAME = "Gif-Perms"; 

const PROHIBITED_WORDS = [
    "nigga",
    "nigger",
    "chink",
    "nig",
];

const eightBallResponses = [
    "It is certain.",
    "It is decidedly so.",
    "Without a doubt.",
    "Yes - definitely.",
    "You may rely on it.",
    "As I see it, yes.",
    "Most likely.",
    "Outlook good.",
    "Yes.",
    "Signs point to yes.",
    "Reply hazy, try again.",
    "Ask again later.",
    "Better not tell you now.",
    "Cannot predict now.",
    "Concentrate and ask again.",
    "Don't count on it.",
    "My reply is no.",
    "My sources say no.",
    "Outlook not so good.",
    "Very doubtful.",
];

// --- EMBED DRAFT STATE ---
const userEmbedDrafts = new Map();
const COOLDOWN_TIME = 10000; 

// --- UTILITY FUNCTIONS ---

/**
 * Ensures the bot stays awake by hitting its own health check endpoint.
 */
function selfPing() {
    const url = process.env.PING_URL;
    if (!url) return console.log("[KEEP-ALIVE] No PING_URL found. Self-ping disabled.");

    setInterval(async () => {
        try {
            await axios.get(url);
            console.log(`[KEEP-ALIVE] Self-ping successful: ${url}`);
        } catch (err) {
            console.error(`[KEEP-ALIVE] Self-ping failed: ${err.message}`);
        }
    }, 1000 * 60 * 5); // Every 5 minutes
}

/**
 * Placeholder for any additional server-side keep-alive logic.
 */
function keepAlive(app) {
    console.log("[KEEP-ALIVE] Server health-check listener active.");
}

function generateShipName(name1, name2) {
    const len1 = name1.length;
    const len2 = name2.length;
    const half1 = name1.substring(0, Math.floor(len1 / 2));
    const half2 = name2.substring(Math.floor(len2 / 2));
    return half1 + half2;
}

// --- EMBED COMMAND HANDLERS ---

async function startEmbedConversation(interaction, drafts) {
    await interaction.deferReply({ ephemeral: true });
    
    if (drafts.has(interaction.user.id)) {
        return interaction.editReply("❌ You already have an active embed draft. Say `cancel` to stop it.");
    }
    
    drafts.set(interaction.user.id, {
        step: 'title',
        embed: new Discord.EmbedBuilder().setColor(COLOR_MAP.default),
        interaction: interaction,
    });
    
    interaction.editReply({ 
        content: "✅ **Embed Builder Started!**\nWhat should the **title** of your embed be? (or say `cancel`)", 
        ephemeral: true 
    });
}

async function handleEmbedDraftResponse(message, drafts) {
    const draft = drafts.get(message.author.id);
    if (!draft) return;

    const content = message.content;
    message.delete().catch(() => {});

    switch (draft.step) {
        case 'title':
            draft.embed.setTitle(content);
            draft.step = 'description';
            message.channel.send(`What should the **description** be? (Say \`skip\` to ignore)`);
            break;
        case 'description':
            if (content.toLowerCase() !== 'skip') {
                draft.embed.setDescription(content);
            }
            draft.step = 'field1_name';
            message.channel.send(`Enter the **name** for your first field, or say \`done\` to finish the embed.`);
            break;
        case 'field1_name':
        case 'field2_name':
        case 'field3_name':
            if (content.toLowerCase() === 'done') {
                draft.step = 'post';
            } else {
                draft.currentFieldName = content;
                draft.step = draft.step.replace('name', 'value');
                message.channel.send(`Enter the **value** for the field named: \`${content}\` `);
                return;
            }

        case 'field1_value':
        case 'field2_value':
        case 'field3_value':
            draft.embed.addFields({ name: draft.currentFieldName, value: content, inline: false });
            const nextFieldIndex = parseInt(draft.step[5]) + 1;
            if (nextFieldIndex <= 3) {
                 draft.step = `field${nextFieldIndex}_name`;
                 message.channel.send(`Enter the **name** for field ${nextFieldIndex}, or say \`done\` to finish.`);
                 return;
            }
            draft.step = 'post';

        case 'post':
            message.channel.send({ embeds: [draft.embed] });
            drafts.delete(message.author.id);
            message.channel.send("✅ Embed created successfully!");
            break;
            
        default:
            drafts.delete(message.author.id);
            message.channel.send("An error occurred. Embed builder cancelled.");
            break;
    }
}

module.exports = {
    PREFIX,
    COLOR_MAP,
    GIF_PERMS_ROLE_NAME,
    PROHIBITED_WORDS,
    generateShipName,
    eightBallResponses,
    COOLDOWN_TIME,
    userEmbedDrafts,
    startEmbedConversation,
    handleEmbedDraftResponse,
    selfPing, // Exported for index.js
    keepAlive  // Exported for index.js
};