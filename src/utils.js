// src/utils.js

const Discord = require("discord.js");

// --- CONSTANTS ---
const PREFIX = ".";

// Color map for embeds (Discord Hex values)
const COLOR_MAP = {
    default: "#3498db", // Blue
    green: "#2ecc71",
    red: "#e74c3c",
    purple: "#9b59b6",
    blue: "#3498db",
    orange: "#e67e22",
};

// Role name for managing GIF permissions
const GIF_PERMS_ROLE_NAME = "Gif-Perms"; 

// List of words to filter - UPDATED PER USER REQUEST
const PROHIBITED_WORDS = [
    "nigga",
    "nigger",
    "chink",
    "nig",
];

// --- 8BALL RESPONSES ---
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
// Map to hold ongoing embed creation for each user
const userEmbedDrafts = new Map();
const COOLDOWN_TIME = 10000; // 10 seconds for status

// --- UTILITY FUNCTIONS ---

/**
 * Generates a random compatibility score and a ship name.
 * @param {string} name1 
 * @param {string} name2 
 * @returns {string} The generated ship name.
 */
function generateShipName(name1, name2) {
    // Simple logic: take the first half of name1 and the second half of name2
    const len1 = name1.length;
    const len2 = name2.length;
    
    const half1 = name1.substring(0, Math.floor(len1 / 2));
    const half2 = name2.substring(Math.floor(len2 / 2));
    
    return half1 + half2;
}

// --- EMBED COMMAND HANDLERS (Simplified for structure) ---

/**
 * Starts the interactive embed conversation with a user.
 */
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

/**
 * Handles the user's message response during the embed drafting process.
 */
async function handleEmbedDraftResponse(message, drafts) {
    const draft = drafts.get(message.author.id);
    if (!draft) return;

    const content = message.content;
    
    // Cleanup the user's message in the process
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
                // Fall through to post the embed
            } else {
                draft.currentFieldName = content;
                draft.step = draft.step.replace('name', 'value'); // Switch step to value
                message.channel.send(`Enter the **value** for the field named: \`${content}\` `);
                return; // Prevent fallthrough
            }
            // Fallthrough to 'post' handled below

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
            // Fallthrough to 'post'

        case 'post':
            // Send the final embed
            message.channel.send({ embeds: [draft.embed] });
            
            // Clean up
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
};