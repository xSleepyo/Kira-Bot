// src/countdown.js

const Discord = require("discord.js");
const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { getState, getDbClient } = require("./database");

const countdownTimers = new Map();
const UPDATE_INTERVAL_MS = 5000; // Update the message every 5 seconds

// --- Helper Functions ---

/**
 * Converts a string like '1y 5d 2m' into total milliseconds.
 */
function parseTimeInterval(timeString) {
    if (!timeString) return null;

    let totalMs = 0;
    const regex = /(\d+)(y|mo|d|h|m|s)/gi; 
    let match;

    while ((match = regex.exec(timeString)) !== null) {
        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();

        switch (unit) {
            case 'y': // Years (365 days)
                totalMs += value * 365 * 24 * 60 * 60 * 1000;
                break;
            case 'mo': // Months (Approx 30 days)
                totalMs += value * 30 * 24 * 60 * 60 * 1000;
                break;
            case 'd': // Days
                totalMs += value * 24 * 60 * 60 * 1000;
                break;
            case 'h': // Hours
                totalMs += value * 60 * 60 * 1000;
                break;
            case 'm': // Minutes
                totalMs += value * 60 * 1000;
                break;
            case 's': // Seconds
                totalMs += value * 1000;
                break;
        }
    }

    return totalMs >= 60000 ? totalMs : null; // Minimum 1 minute
}

/**
 * Converts a total number of milliseconds into a human-readable string (Countdown format).
 */
function formatCountdownTime(ms) {
    if (ms <= 0) return "TIME IS UP! 🚀";
    
    const totalSeconds = Math.floor(ms / 1000);

    const seconds = totalSeconds % 60;
    const minutes = Math.floor((totalSeconds / 60) % 60);
    const hours = Math.floor((totalSeconds / (60 * 60)) % 24);
    const totalDays = Math.floor(totalSeconds / (24 * 60 * 60));

    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;

    const parts = [];
    if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);

    return parts.join(", ");
}

/**
 * Creates the countdown embed message.
 */
function createCountdownEmbed(title, targetTimestamp) {
    const remainingMs = targetTimestamp - Date.now();
    const remainingTime = formatCountdownTime(remainingMs);
    const isFinished = remainingMs <= 0;
    const targetDate = new Date(targetTimestamp).toUTCString();
    
    return new Discord.EmbedBuilder()
        .setColor(isFinished ? 0xff0000 : 0x0099ff)
        .setTitle(`⌛ COUNTDOWN: ${title}`)
        .setDescription(
            `**Remaining Time:**\n# ${remainingTime}`
        )
        .addFields(
            { name: "Target Date (UTC)", value: targetDate, inline: false }
        )
        .setFooter({ text: isFinished ? "Countdown finished!" : "Updates every 5 seconds..." })
        .setTimestamp();
}

/**
 * Stops the countdown timer for a specific channel.
 */
function stopCountdownTimer(channelId) {
    const timer = countdownTimers.get(channelId);
    if (timer) {
        clearInterval(timer);
        countdownTimers.delete(channelId);
    }
}

/**
 * Starts or resumes the countdown timer for a specific channel. (CORE TIMER LOGIC)
 */
async function startCountdownTimer(client, channelId, messageId, title, targetTimestamp) {
    stopCountdownTimer(channelId); // Stop any existing timer for this channel

    const dbClient = getDbClient();
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
        if (!channel) throw new Error("Channel not found.");
    } catch (e) {
        console.error(`[COUNTDOWN] Failed to fetch channel ${channelId}. Deleting countdown state.`);
        await dbClient.query("DELETE FROM countdowns WHERE channel_id = $1", [channelId]);
        return;
    }

    let message;
    try {
        message = await channel.messages.fetch(messageId);
    } catch (e) {
        console.error(`[COUNTDOWN] Failed to fetch message ${messageId} in ${channelId}. Deleting countdown state.`);
        await dbClient.query("DELETE FROM countdowns WHERE channel_id = $1", [channelId]);
        return;
    }

    const interval = setInterval(async () => {
        const remainingMs = targetTimestamp - Date.now();
        const embed = createCountdownEmbed(title, targetTimestamp);
        
        try {
            await message.edit({ embeds: [embed] });
        } catch (e) {
            console.error(`[COUNTDOWN] Failed to edit message ${messageId}. Stopping timer.`, e.message);
            stopCountdownTimer(channelId);
            await dbClient.query("DELETE FROM countdowns WHERE channel_id = $1", [channelId]);
            return;
        }

        if (remainingMs <= 0) {
            stopCountdownTimer(channelId);
            await dbClient.query("DELETE FROM countdowns WHERE channel_id = $1", [channelId]);
            console.log(`[COUNTDOWN] Countdown in ${channelId} finished and stopped.`);
        }
    }, UPDATE_INTERVAL_MS);

    countdownTimers.set(channelId, interval);
    console.log(`[COUNTDOWN] Timer started/resumed for channel ${channelId}.`);
}

/**
 * Handles the slash command initiation.
 */
async function handleCountdownCommand(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "❌ You need Administrator permissions to set up a countdown.", ephemeral: true });
    }

    const title = interaction.options.getString('title', true);
    const channel = interaction.options.getChannel('channel', true);
    const timeString = interaction.options.getString('time', true);

    if (channel.type !== Discord.ChannelType.GuildText) {
        return interaction.reply({ content: "❌ The channel must be a text channel.", ephemeral: true });
    }
    
    const dbClient = getDbClient();
    const existingCountdown = await dbClient.query("SELECT * FROM countdowns WHERE channel_id = $1", [channel.id]);

    if (existingCountdown.rows.length > 0) {
        return interaction.reply({ 
            content: `❌ A countdown is already active in ${channel}.`, 
            ephemeral: true 
        });
    }

    const timeMs = parseTimeInterval(timeString);

    if (!timeMs) {
        return interaction.reply({ 
            content: "❌ Invalid or too short time. Please use a format like `1d 5h 30m` (min 1 minute). Units: `y, mo, d, h, m, s`.", 
            ephemeral: true 
        });
    }
    
    const targetTimestamp = Date.now() + timeMs;
    const initialEmbed = createCountdownEmbed(title, targetTimestamp);

    await interaction.deferReply({ ephemeral: true });

    // 1. Post the initial message to the channel
    const message = await channel.send({ embeds: [initialEmbed] }).catch(e => {
        console.error("Failed to post countdown message:", e);
        return null;
    });

    if (!message) {
        return interaction.editReply({ 
            content: "❌ Failed to post the countdown message in the channel. Check my permissions there." 
        });
    }

    // 2. Save the state to the database
    try {
        await dbClient.query(
            "INSERT INTO countdowns (channel_id, message_id, title, target_timestamp) VALUES ($1, $2, $3, $4)",
            [channel.id, message.id, title, targetTimestamp]
        );
    } catch (e) {
        console.error("Failed to save countdown state:", e);
        await message.delete().catch(() => {}); // Clean up the posted message
        return interaction.editReply({ 
            content: "❌ Database error saving the countdown state. Countdown aborted." 
        });
    }

    // 3. Start the repeating timer
    startCountdownTimer(interaction.client, channel.id, message.id, title, targetTimestamp);

    return interaction.editReply({ 
        content: `✅ Countdown **'${title}'** started in ${channel}! It will automatically update until completion.`,
    });
}


/**
 * Registers the countdown slash command definition.
 */
const countdownCommand = new SlashCommandBuilder()
    .setName('countdown')
    .setDescription('Starts a self-updating countdown to a specific time/event.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
        option.setName('title')
            .setDescription('A brief description of what the countdown is for.')
            .setRequired(true)
    )
    .addChannelOption(option =>
        option.setName('channel')
            .setDescription('The text channel where the countdown message should be posted.')
            .addChannelTypes(Discord.ChannelType.GuildText)
            .setRequired(true)
    )
    .addStringOption(option =>
        option.setName('time')
            .setDescription('The countdown duration (e.g., 1d 5h 30m). Units: y, mo, d, h, m, s.')
            .setRequired(true)
    );

module.exports = {
    data: countdownCommand,
    execute: handleCountdownCommand,
    startCountdownTimer, 
};