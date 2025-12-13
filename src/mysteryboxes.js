// src/mysteryboxes.js

const Discord = require("discord.js");
const { PermissionFlagsBits } = require("discord.js");
// Import the new database functions
const { getDbClient, getState, saveMysteryBoxState, globalState } = require("./database");

const PREFIX = process.env.PREFIX || ".";
const COMPLETION_COMMAND = ".mysteryboxes done";
const CLAIM_TIMEOUT_MS = 60000;  // 60 seconds to claim the box
const TICKET_CHANNEL_HINT = "#create-a-ticket"; // Change this to your actual ticket channel name or instruction!

// State to track setup conversations
const setupDrafts = new Map();

// --- Helper Functions ---

function generateUniqueId(length = 8) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function parseTimeInterval(timeString) {
    if (!timeString) return null;

    let totalMs = 0;
    const regex = /(\d+)(w|d|h|m|s)/g;
    let match;

    while ((match = regex.exec(timeString.toLowerCase())) !== null) {
        const value = parseInt(match[1]);
        const unit = match[2];

        switch (unit) {
            case 'w': totalMs += value * 7 * 24 * 60 * 60 * 1000; break;
            case 'd': totalMs += value * 24 * 60 * 60 * 1000; break;
            case 'h': totalMs += value * 60 * 60 * 1000; break;
            case 'm': totalMs += value * 60 * 1000; break;
            case 's': totalMs += value * 1000; break;
        }
    }

    return totalMs >= 1000 && totalMs > 0 ? totalMs : null;
}

function formatTime(ms) {
    if (ms < 0) return "Time is up!";
    const totalSeconds = Math.floor(ms / 1000);
    const s = totalSeconds % 60;
    const m = Math.floor((totalSeconds / 60) % 60);
    const h = Math.floor((totalSeconds / (60 * 60)) % 24);
    const d = Math.floor(totalSeconds / (24 * 60 * 60));

    const parts = [];
    if (d > 0) parts.push(`${d} day${d !== 1 ? 's' : ''}`);
    if (h > 0) parts.push(`${h} hour${h !== 1 ? 's' : ''}`);
    if (m > 0) parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
    if (s > 0 || parts.length === 0) parts.push(`${s} second${s !== 1 ? 's' : ''}`);

    return parts.join(", ");
}

function stopMysteryBoxTimer() {
    if (globalState.mysteryBoxTimer) {
        clearTimeout(globalState.mysteryBoxTimer); 
        globalState.mysteryBoxTimer = null;
    }
}

// --- Drop Logic ---

async function sendMysteryBoxDrop(client) {
    stopMysteryBoxTimer();

    const dbClient = getDbClient();
    const guildId = globalState.mysteryBoxChannelId ? (await client.channels.fetch(globalState.mysteryBoxChannelId)).guildId : null;
    
    if (!globalState.mysteryBoxChannelId || !guildId) {
        console.error("Mystery box drop failed: Channel ID not set or guild ID missing.");
        return;
    }

    let rewards;
    try {
        const rewardResult = await dbClient.query(
            `SELECT reward_description FROM mystery_rewards WHERE guild_id = $1`,
            [guildId]
        );
        rewards = rewardResult.rows.map(row => row.reward_description);
    } catch (e) {
        console.error("Failed to fetch rewards:", e);
        startMysteryBoxTimer(client, true); 
        return; 
    }

    if (rewards.length === 0) {
        const channel = await client.channels.fetch(globalState.mysteryBoxChannelId).catch(() => null);
        if (channel) {
             channel.send("⚠️ The mystery box drop failed! No rewards have been configured yet. Use `.mysteryboxes setup` to add rewards.");
        }
        startMysteryBoxTimer(client, true);
        return;
    }

    const channel = await client.channels.fetch(globalState.mysteryBoxChannelId).catch(() => null);
    if (!channel) {
        console.error(`Mystery box drop failed: Channel ID ${globalState.mysteryBoxChannelId} is invalid.`);
        await saveMysteryBoxState(null, null, null); 
        return;
    }

    const claimButton = new Discord.ButtonBuilder()
        .setCustomId('claim_mystery_box')
        .setLabel('🎁 CLAIM ME!')
        .setStyle(Discord.ButtonStyle.Success);

    const actionRow = new Discord.ActionRowBuilder().addComponents(claimButton);

    const embed = new Discord.EmbedBuilder()
        .setColor(0xffa500)
        .setTitle("🚨 MYSTERY BOX DROP! 🚨")
        .setDescription("A valuable Mystery Box has appeared! Click the button below **first** to claim your reward!")
        .setFooter({ text: `Hurry! You have ${CLAIM_TIMEOUT_MS / 1000} seconds to claim!` })
        .setTimestamp();
        
    const dropMessage = await channel.send({ 
        embeds: [embed], 
        components: [actionRow] 
    }).catch(e => console.error("Failed to send mystery box message:", e));

    if (!dropMessage) {
        startMysteryBoxTimer(client, true);
        return;
    }

    const filter = (i) => i.customId === 'claim_mystery_box';
    const collector = dropMessage.createMessageComponentCollector({ 
        filter, 
        time: CLAIM_TIMEOUT_MS,
        max: 1
    });
    
    let claimed = false;
    
    collector.on('collect', async (i) => {
        await i.deferUpdate().catch(() => {}); // <-- FIX: prevents 10062 Unknown interaction

        if (claimed) return;
        claimed = true;
        
        collector.stop();

        const rewardIndex = Math.floor(Math.random() * rewards.length);
        const reward = rewards[rewardIndex];
        const claimId = generateUniqueId(10);

        try {
            await dbClient.query(
                `INSERT INTO mystery_claims (guild_id, user_id, claim_id, reward_description) 
                 VALUES ($1, $2, $3, $4)`,
                [i.guild.id, i.user.id, claimId, reward]
            );

            const dmEmbed = new Discord.EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle("🎉 Congratulations! You claimed a Mystery Box!")
                .setDescription(`You successfully claimed a reward in **${i.guild.name}**!`)
                .addFields(
                    { name: "Your Reward", value: `**${reward}**`, inline: false },
                    { name: "Claim ID", value: `\`#${claimId}\``, inline: false },
                    { name: "How to Claim:", value: `To redeem this reward, please go to the server and create a ticket using the instructions in ${TICKET_CHANNEL_HINT}. In your ticket, provide the reward description and your **Claim ID: \`#${claimId}\`**.` }
                )
                .setFooter({ text: "Keep this DM safe!" })
                .setTimestamp();

            await i.user.send({ embeds: [dmEmbed] }).catch(e => {
                console.error(`Failed to DM user ${i.user.tag}:`, e.message);
                i.followUp({ content: `✅ You won **${reward}**! **BUT I COULDN'T DM YOU!** Please enable DMs and check the main channel for your Claim ID and instructions.`, ephemeral: true });
            });

            const winnerEmbed = new Discord.EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle("✅ MYSTERY BOX CLAIMED!")
                .setDescription(`**${i.user.username}** was the fastest and won a reward! Check your DMs for details.`)
                .setFooter({ text: "The next drop is now counting down." })
                .setTimestamp();
                
            const disabledClaimButton = Discord.ButtonBuilder.from(claimButton)
                .setDisabled(true)
                .setLabel('CLAIMED!');
            const disabledActionRow = new Discord.ActionRowBuilder().addComponents(disabledClaimButton);

            await i.update({
                embeds: [winnerEmbed],
                components: [disabledActionRow]
            }).catch(e => console.error("Failed to update mystery box message:", e));

        } catch (e) {
            console.error("Failed to save claim or DM user:", e);
            i.followUp({ content: "❌ A database error occurred while trying to save your claim. Please notify an admin.", ephemeral: true });
            claimed = false;
        }

        startMysteryBoxTimer(client, true);
    });

    collector.on('end', async (collected) => {
        if (!claimed) {
            const timeoutEmbed = Discord.EmbedBuilder.from(embed)
                .setColor(0xff0000)
                .setTitle("❌ MYSTERY BOX EXPIRED")
                .setDescription("No one claimed the box in time! Better luck next time.")
                .setFooter({ text: "The next drop is now counting down." });
                
            const disabledClaimButton = Discord.ButtonBuilder.from(claimButton).setDisabled(true).setLabel('EXPIRED');
            const disabledActionRow = new Discord.ActionRowBuilder().addComponents(disabledClaimButton);
            
            await dropMessage.edit({ 
                embeds: [timeoutEmbed], 
                components: [disabledActionRow] 
            }).catch(e => console.error("Failed to edit expired message:", e));
            
            startMysteryBoxTimer(client, true);
        }
    });
}

// --- Start Timer ---
function startMysteryBoxTimer(client, updateNextDrop = false) {
    stopMysteryBoxTimer();
    
    const intervalMs = globalState.mysteryBoxInterval;
    const nextDropTimestamp = globalState.mysteryBoxNextDrop;
    
    if (!intervalMs || !globalState.mysteryBoxChannelId) return;

    let delayMs;
    let nextDrop;
    
    if (updateNextDrop || !nextDropTimestamp) {
        nextDrop = Date.now() + intervalMs;
        delayMs = intervalMs;
        saveMysteryBoxState(globalState.mysteryBoxChannelId, intervalMs, nextDrop);
    } else {
        nextDrop = nextDropTimestamp;
        delayMs = nextDrop - Date.now();
        if (delayMs <= 0) delayMs = 1000;
    }

    console.log(`[MYSTERY BOX] Next drop scheduled in ${formatTime(delayMs)}`);
    
    globalState.mysteryBoxTimer = setTimeout(() => {
        sendMysteryBoxDrop(client);
    }, delayMs);
}

// --- Setup and Commands ---

async function handleSetup(message) {
    const userId = message.author.id;
    if (setupDrafts.has(userId)) return message.channel.send("⚠️ You are already in a setup process.");

    setupDrafts.set(userId, { step: 1, channel: null, interval: null, rewards: [] });
    message.channel.send("**Mystery Box Setup (Step 1/3):** Please **mention the channel** where you want the drops.");
}

async function handleSetupResponse(message) {
    const userId = message.author.id;
    const draft = setupDrafts.get(userId);
    if (!draft) return;

    const dbClient = getDbClient();

    if (draft.step === 1) {
        const channel = message.mentions.channels.first();
        if (!channel || channel.type !== Discord.ChannelType.GuildText) return message.channel.send("❌ Invalid channel.");
        draft.channel = channel;
        draft.step = 2;
        message.channel.send(`✅ Channel set to ${channel}. Step 2/3: Drop interval? e.g., 1d 5h`);
        return;
    }

    if (draft.step === 2) {
        const intervalMs = parseTimeInterval(message.content);
        if (!intervalMs) return message.channel.send("❌ Invalid time format.");
        draft.interval = intervalMs;
        draft.step = 3;
        message.channel.send(`✅ Interval set to ${formatTime(intervalMs)}. Step 3/3: Enter rewards, one by one. Type \`${COMPLETION_COMMAND}\` when done.`);
        try {
            await dbClient.query(`DELETE FROM mystery_rewards WHERE guild_id = $1`, [message.guild.id]);
            draft.rewards = [];
            message.channel.send("🗑️ Previous rewards cleared.");
        } catch (e) {
            console.error(e);
            message.channel.send("❌ Error clearing previous rewards. Setup aborted.");
            setupDrafts.delete(userId);
        }
        return;
    }

    if (draft.step === 3) {
        const rewardText = message.content.trim();
        if (rewardText.toLowerCase() === COMPLETION_COMMAND) {
            if (draft.rewards.length === 0) return message.channel.send("❌ Enter at least one reward.");
            try {
                const rewardQueries = draft.rewards.map(reward => 
                    dbClient.query(`INSERT INTO mystery_rewards (guild_id, reward_description) VALUES ($1, $2)`, [message.guild.id, reward])
                );
                await Promise.all(rewardQueries);
                await saveMysteryBoxState(draft.channel.id, draft.interval, null);
                message.channel.send(`🎉 Setup Complete! Channel: ${draft.channel}, Interval: ${formatTime(draft.interval)}, Rewards Added: ${draft.rewards.length}`);
            } catch (e) {
                console.error(e);
                message.channel.send("❌ Database error. Setup aborted.");
            } finally {
                setupDrafts.delete(userId);
            }
            return;
        }

        draft.rewards.push(rewardText);
        message.channel.send(`✅ Reward #${draft.rewards.length} added: \`${rewardText}\`. Enter next or type \`${COMPLETION_COMMAND}\` to finish.`);
    }
}

// --- Main Command Handler ---

async function handleMysteryBoxesCommand(client, message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.channel.send("❌ Admin required.");
    
    if (setupDrafts.has(message.author.id) && message.content.toLowerCase() !== COMPLETION_COMMAND) return handleSetupResponse(message);

    const command = args[0] ? args[0].toLowerCase() : 'help';
    const dbClient = getDbClient();

    switch (command) {
        case 'setup': return handleSetup(message);
        case 'start': 
            if (!globalState.mysteryBoxChannelId || !globalState.mysteryBoxInterval) return message.channel.send("❌ Setup incomplete.");
            if (globalState.mysteryBoxTimer) return message.channel.send(`⚠️ Timer already running! Next drop in ${formatTime(globalState.mysteryBoxNextDrop - Date.now())}.`);
            await saveMysteryBoxState(globalState.mysteryBoxChannelId, globalState.mysteryBoxInterval, Date.now() + globalState.mysteryBoxInterval);
            startMysteryBoxTimer(client, false);
            return message.channel.send(`✅ Mystery Box drops started! First drop in ${formatTime(globalState.mysteryBoxInterval)} in <#${globalState.mysteryBoxChannelId}>.`);
        case 'time':
            if (!globalState.mysteryBoxTimer || !globalState.mysteryBoxNextDrop) return message.channel.send("❌ Timer not running.");
            return message.channel.send(`⏳ Next Mystery Box Drop in: **${formatTime(globalState.mysteryBoxNextDrop - Date.now())}**`);
        case 'reset':
            stopMysteryBoxTimer();
            setupDrafts.delete(message.author.id);
            try {
                await saveMysteryBoxState(null, null, null);
                await dbClient.query(`DELETE FROM mystery_rewards WHERE guild_id = $1`, [message.guild.id]);
                await dbClient.query(`DELETE FROM mystery_claims WHERE guild_id = $1`, [message.guild.id]);
                return message.channel.send("✅ Mystery Boxes completely reset.");
            } catch (e) {
                console.error(e);
                return message.channel.send("❌ Error during reset.");
            }
        case 'rewards':
            const dbRewards = await dbClient.query(`SELECT reward_description FROM mystery_rewards WHERE guild_id = $1`, [message.guild.id]).catch(e => ({ rows: [] }));
            if (dbRewards.rows.length === 0) return message.channel.send("ℹ️ No rewards configured yet.");
            const rewardsList = dbRewards.rows.map((row, idx) => `**${idx+1}.** ${row.reward_description}`).join('\n');
            const rewardsEmbed = new Discord.EmbedBuilder()
                .setColor(0x0099ff)
                .setTitle(`🎁 Current Rewards (${dbRewards.rows.length})`)
                .setDescription(rewardsList)
                .setFooter({ text: "Randomly selected for drops." })
                .setTimestamp();
            return message.channel.send({ embeds: [rewardsEmbed] });
        case 'check':
            const targetUserCheck = message.mentions.users.first();
            if (!targetUserCheck) return message.channel.send("❌ Mention a user to check claims.");
            try {
                const claimsResult = await dbClient.query(`SELECT claim_id, reward_description, is_used, claimed_at FROM mystery_claims WHERE guild_id = $1 AND user_id = $2 ORDER BY claimed_at DESC`, [message.guild.id, targetUserCheck.id]);
                if (claimsResult.rows.length === 0) return message.channel.send(`ℹ️ ${targetUserCheck.username} has no claims.`);
                let unusedList = '', usedList = '', unusedCount = 0, usedCount = 0;
                claimsResult.rows.forEach(row => {
                    const status = row.is_used ? '✅ USED' : '⚠️ UNUSED';
                    const line = `\`#${row.claim_id}\` | ${row.reward_description} (${status})\n`;
                    if (row.is_used) { usedList += line; usedCount++; } else { unusedList += line; unusedCount++; }
                });
                const checkEmbed = new Discord.EmbedBuilder()
                    .setColor(0x3498db)
                    .setTitle(`🎁 Claims for ${targetUserCheck.username}`)
                    .setDescription(`Total Claims: ${claimsResult.rows.length} | Unused: ${unusedCount} | Used: ${usedCount}`)
                    .addFields(
                        { name: `Unused Claims (${unusedCount})`, value: unusedList || "No unused claims found.", inline:false },
                        { name: `Used/Redeemed Claims (${usedCount})`, value: usedList.substring(0,1024) || "No redeemed claims found.", inline:false }
                    )
                    .setFooter({ text: `Use .mysteryboxes use @user #IDNumber to redeem.` })
                    .setTimestamp();
                return message.channel.send({ embeds: [checkEmbed] });
            } catch (e) { console.error(e); return message.channel.send("❌ Error fetching claims."); }
        case 'use':
            const targetUserUse = message.mentions.users.first();
            if (!targetUserUse) return message.channel.send("❌ Mention a user.");
            const claimIdToUse = args[2] ? args[2].replace(/^#/, '').toUpperCase() : null;
            if (!claimIdToUse) return message.channel.send("❌ Provide a Claim ID.");
            try {
                const claimCheck = await dbClient.query(`SELECT id, reward_description, is_used FROM mystery_claims WHERE guild_id = $1 AND user_id = $2 AND claim_id = $3`, [message.guild.id, targetUserUse.id, claimIdToUse]);
                if (claimCheck.rows.length === 0) return message.channel.send(`❌ Claim ID **#${claimIdToUse}** not found.`);
                const claim = claimCheck.rows[0];
                if (claim.is_used) return message.channel.send(`⚠️ Claim ID **#${claimIdToUse}** already marked USED.`);
                await dbClient.query(`UPDATE mystery_claims SET is_used = TRUE WHERE id = $1`, [claim.id]);
                return message.channel.send(`✅ Claim ID **#${claimIdToUse}** marked USED.`);
            } catch (e) { console.error(e); return message.channel.send("❌ Error updating claim."); }
        case 'done':
            if (setupDrafts.has(message.author.id)) return handleSetupResponse(message);
        default:
            const helpEmbed = new Discord.EmbedBuilder()
                .setColor(0x3498db)
                .setTitle("Mystery Box Drop Commands")
                .setDescription("All commands require Administrator permissions.")
                .addFields(
                    { name: "`.mysteryboxes setup`", value:"Starts interactive setup.", inline:false },
                    { name: "`.mysteryboxes start`", value:"Starts the drop timer.", inline:true },
                    { name: "`.mysteryboxes time`", value:"Shows remaining time.", inline:true },
                    { name: "`.mysteryboxes rewards`", value:"View all rewards.", inline:true },
                    { name: "`.mysteryboxes check @user`", value:"View user's claims.", inline:false },
                    { name: "`.mysteryboxes @user use #ID`", value:"Mark a claim as used.", inline:false },
                    { name: "`.mysteryboxes reset`", value:"Stop timer and clear all.", inline:false }
                );
            return message.channel.send({ embeds: [helpEmbed] });
    }
}

module.exports = {
    handleMysteryBoxesCommand,
    startMysteryBoxTimer, 
    handleSetupResponse, 
};
