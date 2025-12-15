// src/countdown.js

const Discord = require("discord.js");
const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js"); // Added imports
const { getDbClient } = require("./database");
const moment = require("moment"); // <-- IMPORTANT: Requires "moment": "^2.30.1" in package.json
const countdownTimers = new Map();

// Removed manual parseTimeInterval function (replaced by moment.js logic in execute)
// Removed manual formatTimeRemaining function (replaced by logic in createCountdownEmbed)

/**
 * Command data for the /countdown command.
 */
const data = new SlashCommandBuilder()
    .setName("countdown")
    .setDescription("Starts a self-updating countdown to a specific time/event (Admin only).")
    .addStringOption(option =>
        option.setName("title")
            .setDescription("A brief description of what the countdown is for.")
            .setRequired(true))
    .addChannelOption(option =>
        option.setName("channel")
            .setDescription("The text channel where the countdown message should be posted.")
            .setRequired(true)
            .addChannelTypes(Discord.ChannelType.GuildText))
    .addStringOption(option =>
        option.setName("time")
            .setDescription("The countdown duration (e.g., 1d 5h 30m). Units: y, mo, d, h, m, s.")
            .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

/**
 * Executes the /countdown command.
 */
async function execute(interaction) {
    const title = interaction.options.getString("title");
    const channel = interaction.options.getChannel("channel");
    const timeInput = interaction.options.getString("time");

    await interaction.deferReply({ ephemeral: true });

    // 1. Parse Time Input using moment.js logic
    const durationMatch = timeInput.match(/(\d+)([ymodhms])/g);
    if (!durationMatch) {
        return interaction.editReply({
            content: "❌ Invalid time format. Use units like `1y`, `5mo`, `3d`, `8h`, `30m`, `5s`. Example: `1d 5h 30m`.",
        });
    }

    let endTime = moment();
    for (const part of durationMatch) {
        const value = parseInt(part.slice(0, -1));
        const unit = part.slice(-1);
        
        let momentUnit;
        switch (unit) {
            case 'y': momentUnit = 'years'; break;
            case 'mo': momentUnit = 'months'; break;
            case 'd': momentUnit = 'days'; break;
            case 'h': momentUnit = 'hours'; break;
            case 'm': momentUnit = 'minutes'; break;
            case 's': momentUnit = 'seconds'; break;
            default: continue; 
        }
        endTime = endTime.add(value, momentUnit);
    }
    
    if (endTime.isSameOrBefore(moment())) {
        return interaction.editReply({
            content: "❌ The countdown must be set for a time in the future.",
        });
    }

    const endTimeISO = endTime.toISOString();
    
    // 2. Calculate initial interval (Dynamic interval for better performance/accuracy)
    let intervalMs = 60000; // Default to 1 minute
    const durationTotalMs = endTime.diff(moment());
    if (durationTotalMs < 3600000) { // If less than 1 hour
        intervalMs = 5000; // 5 seconds
    }
    
    // 3. Post the initial message
    const initialMessage = await channel.send({ 
        embeds: [createCountdownEmbed(title, endTime, intervalMs)]
    }).catch(e => {
        console.error("Error sending initial countdown message:", e);
        return null;
    });

    if (!initialMessage) {
        return interaction.editReply({
            content: `❌ Failed to post the countdown message in ${channel}. Check bot permissions (View Channel, Send Messages, Embed Links).`,
        });
    }

    // 4. Save to Database
    const dbClient = getDbClient();
    try {
        await dbClient.query(
            `INSERT INTO countdowns (guild_id, channel_id, message_id, end_time, title, interval_ms)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                interaction.guildId, 
                channel.id, 
                initialMessage.id, 
                endTimeISO, 
                title,
                intervalMs 
            ]
        );
    } catch (e) {
        console.error("Database error saving countdown:", e);
        await initialMessage.delete().catch(() => {});
        return interaction.editReply({
            content: "❌ Failed to save countdown to database. Deleting message. Check logs.",
        });
    }

    // 5. Start the Timer
    startCountdownTimer(interaction.client, initialMessage, title, endTimeISO, intervalMs);

    interaction.editReply({
        content: `✅ Countdown **'${title}'** successfully started in ${channel}!`,
    });
}

/**
 * Creates the Discord Embed for the countdown message.
 */
function createCountdownEmbed(title, endTime, intervalMs) {
    const now = moment();
    const duration = moment.duration(endTime.diff(now));
    
    let timeRemaining;
    if (duration.asMilliseconds() <= 0) {
        timeRemaining = "🎉 **EXPIRED!** The event has begun!";
    } else {
        const years = duration.years();
        const months = duration.months();
        const days = duration.days();
        const hours = duration.hours();
        const minutes = duration.minutes();
        const seconds = duration.seconds();

        let parts = [];
        if (years > 0) parts.push(`${years}y`);
        if (months > 0) parts.push(`${months}mo`);
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        
        // Show seconds only if interval is 5s or less than 1 minute remaining
        if (intervalMs <= 5000 || duration.asMinutes() < 1) {
             parts.push(`${seconds}s`);
        } else if (parts.length === 0) {
            // If less than a minute, but interval is 1m, show 0m
             parts.push(`${minutes}m`);
        }

        if (parts.length === 0 && duration.asSeconds() > 0) {
            timeRemaining = `Remaining: **${seconds} seconds**`;
        } else {
            timeRemaining = `Remaining: **${parts.join(', ')}**`;
        }
    }
    
    const embed = new Discord.EmbedBuilder()
        .setColor(duration.asMilliseconds() > 0 ? Discord.Colors.Blurple : Discord.Colors.Green)
        .setTitle(`⏳ Countdown: ${title}`)
        .setDescription(timeRemaining)
        .addFields(
            { name: "End Time", value: `<t:${endTime.unix()}:F> (<t:${endTime.unix()}:R>)`, inline: false }
        )
        .setFooter({ text: duration.asMilliseconds() > 0 ? "Updating live..." : "Completed." });

    return embed;
}

/**
 * Starts the interval timer for a single countdown.
 */
function startCountdownTimer(client, message, title, endTimeISO, intervalMs) {
    const endTime = moment(endTimeISO);
    
    if (endTime.isSameOrBefore(moment())) {
        updateCountdown(client, message.id, message.channel.id, title, endTimeISO, true);
        return;
    }

    // Use intervalMs from the DB to set the timer
    const interval = setInterval(() => {
        updateCountdown(client, message.id, message.channel.id, title, endTimeISO, false, interval);
    }, intervalMs);
    
    countdownTimers.set(message.id, interval);
}

/**
 * Updates the countdown message or stops the timer if expired.
 */
async function updateCountdown(client, messageId, channelId, title, endTimeISO, initialExpired = false, interval = null) {
    const endTime = moment(endTimeISO);
    const now = moment();
    
    const dbClient = getDbClient();
    
    if (initialExpired || endTime.isSameOrBefore(now)) {
        if (interval) clearInterval(interval);
        if (countdownTimers.has(messageId)) countdownTimers.delete(messageId);
        
        try {
            // Remove from DB when finished
            await dbClient.query('DELETE FROM countdowns WHERE message_id = $1', [messageId]);
        } catch (e) {
            console.error(`DB cleanup error for countdown ${messageId}:`, e);
        }
    }
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) {
            // If message is missing, clean up DB/timer
            if (interval) clearInterval(interval);
            if (countdownTimers.has(messageId)) countdownTimers.delete(messageId);
            await dbClient.query('DELETE FROM countdowns WHERE message_id = $1', [messageId]).catch(() => {});
            return;
        }

        // Use the interval repeat value to decide how to display seconds
        const intervalToUse = interval ? interval._repeat : 60000;
        const embed = createCountdownEmbed(title, endTime, intervalToUse); 
        await message.edit({ embeds: [embed] });
        
    } catch (e) {
        console.error(`Error updating countdown message ${messageId}:`, e);
        // Clean up if update fails (e.g., bot lost permissions)
        if (interval) clearInterval(interval);
        if (countdownTimers.has(messageId)) countdownTimers.delete(messageId);
        await dbClient.query('DELETE FROM countdowns WHERE message_id = $1', [messageId]).catch(() => {});
    }
}

/**
 * Loads all active countdowns from the DB and restarts their timers.
 */
async function resumeCountdowns(client) {
    const dbClient = getDbClient();
    try {
        // Only load countdowns that haven't expired yet
        const result = await dbClient.query(
            `SELECT * FROM countdowns WHERE end_time > NOW()`
        );
        
        console.log(`Resuming ${result.rows.length} active countdown(s).`);

        for (const row of result.rows) {
            startCountdownTimer(client, { id: row.message_id, channel: { id: row.channel_id } }, row.title, row.end_time, row.interval_ms);
        }
    } catch (e) {
        console.error("Error resuming countdowns from database:", e);
    }
}

/**
 * Clears all currently running timers (used for graceful shutdown/restart).
 */
function stopAllTimers() {
    for (const [id, interval] of countdownTimers) {
        clearInterval(interval);
    }
    countdownTimers.clear();
    console.log("All countdown timers stopped.");
}


module.exports = {
    data, 
    execute, 
    resumeCountdowns, 
    stopAllTimers, 
};