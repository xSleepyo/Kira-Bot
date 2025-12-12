// src/utils.js

const Discord = require("discord.js");
const { PermissionFlagsBits } = require("discord.js");
const { saveState, getState, getDbClient, globalState } = require('./database'); // Import database functions

// Command Prefix
const PREFIX = ".";

// Global memory store for embed drafts (stays outside handlers for continuity)
const userEmbedDrafts = {};

// STATUS COMMAND COOLDOWN LOCK
const statusCooldown = new Set();
const COOLDOWN_TIME = 2000; // 2 seconds

// ANSI Color Map
const COLOR_MAP = {
    RED: 0xff0000,
    GREEN: 0x00ff00,
    BLUE: 0x0000ff,
    YELLOW: 0xffff00,
    PURPLE: 0x9b59b6,
    CYAN: 0x00ffff,
    DEFAULT: 0x3498db,
};

// GIF PERMS Constant
const GIF_PERMS_ROLE_NAME = "GifPerms";

// --- Ship Name Generator ---
function generateShipName(name1, name2) {
    const len1 = name1.length;
    const len2 = name2.length;
    const half1 = Math.ceil(len1 / 2);
    const half2 = Math.ceil(len2 / 2);
    const part1 = name1.substring(0, half1);
    const part2 = name2.substring(len2 - half2);
    return part1 + part2;
}

// Magic 8-Ball Responses 
const eightBallResponses = [
    "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes, definitely.",
    "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.",
    "Signs point to yes.", "Reply hazy, try again.", "Ask again later.", "Better not tell you now.",
    "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.", "My reply is no.",
    "My sources say no.", "Outlook not so good.", "Very doubtful.",
];

// --- ANTI-SPAM: Prohibited Words List (Case-insensitive) ---
const PROHIBITED_WORDS = [
    "nigger", "nigga", "chink", "gook", "kike", "faggot",
];

// --- Server Setup (Keep Alive) ---
function keepAlive(app, axios, state) {
    app.get("/", (req, res) => {
        res.send("Bot is Alive!");
    });
    app.listen(process.env.PORT || 3000, () => {
        console.log(`Web server running on port ${process.env.PORT || 3000}`);
    });

    selfPing(axios, state);
}

// --- Self-Pinging Function ---
function selfPing(axios, state) {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`; 

    // Use the globalState to manage the interval
    state.selfPingInterval = setInterval(async () => {
        try {
            const res = await axios.get(url); 
            console.log(`Self-Ping successful. Status: ${res.status}`);
        } catch (error) {
            console.error(`Self-Ping Error: ${error.message}`);
        }
    }, 180000); // Ping every 3 minutes
} 

// --- Interactive Embed Builder Functions (Moved here for separation from handlers) ---

/**
 * Starts the interactive conversation to build an embed.
 */
async function startEmbedConversation(interaction, userEmbedDrafts) {
    const userId = interaction.user.id;
    const channel = interaction.channel;
    const guild = interaction.guild;

    // Check for existing draft
    if (userEmbedDrafts[userId]) {
        return interaction.reply({
            content: "❌ You already have an active embed draft! Please finish or cancel it first.",
            ephemeral: true,
        });
    }

    // Initialize draft
    userEmbedDrafts[userId] = {
        title: "", description: "", footer: "",
        color: COLOR_MAP.DEFAULT,
        targetChannelId: null,
        status: "awaiting_title",
    };

    await interaction.reply({
        content: "✍️ **Embed Builder Started!** Please check the next message.",
        ephemeral: true,
    });

    await channel.send(
        `Hey ${interaction.user}, please type the **TITLE** you want for your embed. (Max 256 chars)`,
    );

    const collector = channel.createMessageCollector({
        filter: (m) => m.author.id === userId,
        time: 300000, // 5 minutes
    });

    const timeout = setTimeout(() => {
        if (userEmbedDrafts[userId]) {
            channel.send(`⏳ ${interaction.user} Embed draft cancelled due to 5-minute inactivity.`);
            delete userEmbedDrafts[userId];
            collector.stop();
        }
    }, 300000);

    collector.on("collect", async (m) => {
        clearTimeout(timeout); 

        const draft = userEmbedDrafts[userId];
        if (!draft) { collector.stop(); return; }

        const input = m.content.trim();
        if (input.toLowerCase() === "cancel") {
            delete userEmbedDrafts[userId];
            collector.stop();
            m.delete().catch(console.error);
            return channel.send(`🗑️ Embed draft successfully cancelled.`);
        }

        let shouldDeleteInput = true;

        switch (draft.status) {
            case "awaiting_title":
                // ... (Title logic)
                if (input.length > 256) {
                    shouldDeleteInput = false;
                    return channel.send("❌ Title is too long! Please keep it under 256 characters.");
                }
                draft.title = input;
                draft.status = "awaiting_description";
                return channel.send(`✅ Title set to: **${input}**.\n\nNext, please type the **DESCRIPTION**. (Supports live mentions and basic formatting like \`\\n\` for new lines).`);

            case "awaiting_description":
                // ... (Description logic)
                if (input.length > 4096) {
                    shouldDeleteInput = false;
                    return channel.send("❌ Description is too long! Please keep it under 4096 characters.");
                }
                draft.description = input;
                draft.status = "awaiting_footer";
                return channel.send(`✅ Description set.\n\nNext, please type the **FOOTER** text. (Optional - type "skip" if you don't want a footer). (Max 2048 chars)`);

            case "awaiting_footer":
                // ... (Footer logic)
                if (input.toLowerCase() === "skip") {
                    draft.footer = null;
                } else {
                    if (input.length > 2048) {
                        shouldDeleteInput = false;
                        return channel.send("❌ Footer is too long! Please keep it under 2048 characters.");
                    }
                    draft.footer = input;
                }
                draft.status = "awaiting_color";
                return channel.send(`✅ Footer set.\n\nFinally, please provide the **COLOR** for the sidebar. (Example: \`RED\`, \`BLUE\`, or hex code like \`0xFF0000\`)`);

            case "awaiting_color":
                // ... (Color logic)
                let newColor =
                    COLOR_MAP[input.toUpperCase()] ||
                    (input.toUpperCase().startsWith("0X") && parseInt(input)) ||
                    null;

                if (!newColor || isNaN(newColor)) {
                    shouldDeleteInput = false;
                    return channel.send("❌ Invalid color. Please use a valid color name (RED, BLUE) or a hex code (e.g., 0xFF0000).");
                }

                draft.color = newColor;
                draft.status = "awaiting_channel";

                return channel.send(`✅ Color set.\n\nNext, please **MENTION THE CHANNEL** where you want the embed sent (e.g., \`#announcements\`).`);

            case "awaiting_channel":
                // ... (Channel logic)
                const mentionedChannel = m.mentions.channels.first();

                if (!mentionedChannel || mentionedChannel.type !== Discord.ChannelType.GuildText) {
                    shouldDeleteInput = false;
                    return channel.send("❌ Please mention a valid text channel (e.g., `#general`).");
                }

                const permissions = mentionedChannel.permissionsFor(guild.members.me);
                if (!permissions || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
                    shouldDeleteInput = false;
                    return channel.send(`❌ I do not have permission to send messages and/or embeds in ${mentionedChannel}. Please check my permissions.`);
                }

                draft.targetChannelId = mentionedChannel.id;
                draft.status = "awaiting_send";

                const finalEmbed = new Discord.EmbedBuilder()
                    .setColor(draft.color)
                    .setTitle(draft.title)
                    .setDescription(draft.description)
                    .setTimestamp();

                if (draft.footer) {
                    finalEmbed.setFooter({ text: draft.footer });
                }

                channel.send({
                    content: `🎉 **Embed Complete!** It will be sent to ${mentionedChannel}. Here is the preview:`,
                    embeds: [finalEmbed],
                });
                return channel.send(`\nLast step: Type \`send\` to finalize and send the embed, or type \`cancel\` to discard it.`);

            case "awaiting_send":
                if (input.toLowerCase() === "send") {
                    // ... (Send logic)
                    const targetChannel = guild.channels.cache.get(draft.targetChannelId);
                    if (!targetChannel) {
                        delete userEmbedDrafts[userId];
                        collector.stop();
                        return channel.send(`❌ Could not find the target channel. Draft cleared.`);
                    }

                    const finalEmbedToSend = new Discord.EmbedBuilder()
                        .setColor(draft.color)
                        .setTitle(draft.title)
                        .setDescription(draft.description)
                        .setTimestamp();

                    if (draft.footer) {
                        finalEmbedToSend.setFooter({ text: draft.footer });
                    }

                    try {
                        await targetChannel.send({ embeds: [finalEmbedToSend] });
                        channel.send(`🥳 **Success!** Your embed has been sent to ${targetChannel}. Draft cleared.`);
                    } catch (e) {
                        channel.send(`❌ Failed to send embed to ${targetChannel}. Check my permissions (Send Messages, Embed Links).`);
                        console.error("Embed send error:", e);
                    }

                    delete userEmbedDrafts[userId];
                    collector.stop();
                } else {
                    shouldDeleteInput = false;
                    return channel.send(`Unrecognized command. Type \`send\` to send or \`cancel\` to discard.`);
                }
                break;
        }

        if (shouldDeleteInput) {
            m.delete().catch(console.error);
        }
    });

    collector.on("end", (collected) => {
        clearTimeout(timeout);
        if (
            userEmbedDrafts[userId] &&
            userEmbedDrafts[userId].status !== "awaiting_send"
        ) {
            channel.send(`⏳ Embed draft cancelled due to inactivity.`);
            delete userEmbedDrafts[userId];
        }
    });
}


module.exports = {
    PREFIX,
    COLOR_MAP,
    GIF_PERMS_ROLE_NAME,
    PROHIBITED_WORDS,
    generateShipName,
    eightBallResponses,
    statusCooldown,
    COOLDOWN_TIME,
    keepAlive,
    selfPing,
    userEmbedDrafts,
    startEmbedConversation,
};