// src/mysteryboxes.js

const Discord = require("discord.js");
const { PermissionFlagsBits } = require("discord.js");
const { getDbClient, getState, saveMysteryBoxState, globalState } = require("./database");

const PREFIX = process.env.PREFIX || ".";
const COMPLETION_COMMAND = ".mysteryboxes done";
const CLAIM_TIMEOUT_MS = 60000;  // 60 seconds to claim the box
const TICKET_CHANNEL_HINT = "#create-a-ticket"; // Change this to your actual ticket channel name or instruction!

// State to track setup conversations
const setupDrafts = new Map();

// --- Helper Functions ---

/**
 * Generates a short, unique alphanumeric ID for rewards.
 * @param {number} length - Length of the ID.
 * @returns {string} The unique ID.
 */
function generateUniqueId(length = 8) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

/**
 * Converts a string like '1d 5h 2m' into total milliseconds.
 * @param {string} timeString - The time string (e.g., '1w 3d 5h 2m 15s').
 * @returns {number | null} Total milliseconds or null on failure.
 */
function parseTimeInterval(timeString) {
    if (!timeString) return null;

    let totalMs = 0;
    const regex = /(\d+)(w|d|h|m|s)/g;
    let match;

    while ((match = regex.exec(timeString.toLowerCase())) !== null) {
        const value = parseInt(match[1]);
        const unit = match[2];

        switch (unit) {
            case 'w': // Weeks
                totalMs += value * 7 * 24 * 60 * 60 * 1000;
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

    // Must be at least 1 second and must have successfully parsed something
    return totalMs >= 1000 && totalMs > 0 ? totalMs : null;
}

/**
 * Converts a total number of milliseconds into a human-readable string.
 * @param {number} ms - The total milliseconds.
 * @returns {string} The formatted time string.
 */
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

/**
 * Stops the current mystery box timer.
 */
function stopMysteryBoxTimer() {
    if (globalState.mysteryBoxTimer) {
        clearTimeout(globalState.mysteryBoxTimer);
        globalState.mysteryBoxTimer = null;
    }
}

// --- Drop Logic ---

/**
 * Sends a mystery box embed to the specified channel.
 * @param {Discord.Client} client
 */
async function sendMysteryBoxDrop(client) {
    stopMysteryBoxTimer(); // Stop the timer once the drop is initiated

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
        startMysteryBoxTimer(client, true); // Schedule next drop for a check
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
        startMysteryBoxTimer(client, true); // Schedule next drop if sending failed
        return;
    }

    // Setup Collector for the button
    const filter = (i) => i.customId === 'claim_mystery_box';
    const collector = dropMessage.createMessageComponentCollector({ 
        filter, 
        time: CLAIM_TIMEOUT_MS,
        max: 1 // Only the first interaction matters
    });
    
    let claimed = false;
    
    collector.on('collect', async (i) => {
        if (claimed) return;
        claimed = true;
        
        collector.stop();

        // Randomly select a reward
        const rewardIndex = Math.floor(Math.random() * rewards.length);
        const reward = rewards[rewardIndex];
        const claimId = generateUniqueId(10); // Generate a unique ID

        try {
            // 1. Save the claim to the database
            await dbClient.query(
                `INSERT INTO mystery_claims (guild_id, user_id, claim_id, reward_description) 
                 VALUES ($1, $2, $3, $4)`,
                [i.guild.id, i.user.id, claimId, reward]
            );

            // 2. Send DM to the winner with ticket instructions
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


            // 3. Update the drop message
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
            // Revert claimed flag if database failed
            claimed = false;
        }

        // Start the timer for the *next* drop
        startMysteryBoxTimer(client, true);
    });

    collector.on('end', async (collected) => {
        if (!claimed) {
            // Box timed out
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
            
            // Start the timer for the *next* drop
            startMysteryBoxTimer(client, true);
        }
    });
}

/**
 * Calculates time and starts the scheduled timer for the next mystery box drop.
 * @param {Discord.Client} client
 * @param {boolean} updateNextDrop - If true, calculates and saves a new next_drop_timestamp.
 */
function startMysteryBoxTimer(client, updateNextDrop = false) {
    stopMysteryBoxTimer();
    
    const intervalMs = globalState.mysteryBoxInterval;
    const nextDropTimestamp = globalState.mysteryBoxNextDrop;
    
    if (!intervalMs || !globalState.mysteryBoxChannelId) {
        return; // Configuration is incomplete or not started
    }

    let delayMs;
    let nextDrop;
    
    if (updateNextDrop || !nextDropTimestamp) {
        // Calculate new drop time
        nextDrop = Date.now() + intervalMs;
        delayMs = intervalMs;
        
        saveMysteryBoxState(globalState.mysteryBoxChannelId, intervalMs, nextDrop);
    } else {
        // Use loaded drop time
        nextDrop = nextDropTimestamp;
        delayMs = nextDrop - Date.now();
        
        // If the drop time is in the past, schedule it immediately or for the next cycle
        if (delayMs <= 0) {
            delayMs = 1000; // Drop 1 second after startup if overdue
        }
    }

    console.log(`[MYSTERY BOX] Next drop scheduled in ${formatTime(delayMs)}`);
    
    globalState.mysteryBoxTimer = client.setTimeout(() => {
        sendMysteryBoxDrop(client);
    }, delayMs);
}

// --- Setup Commands and Handlers (mostly unchanged) ---

/**
 * Starts the interactive setup conversation.
 */
async function handleSetup(message) {
    const userId = message.author.id;
    if (setupDrafts.has(userId)) {
        return message.channel.send("⚠️ You are already in a setup process. Please complete it or wait for the timeout.");
    }

    setupDrafts.set(userId, { step: 1, channel: null, interval: null, rewards: [] });
    message.channel.send(
        "**Mystery Box Setup (Step 1/3):**\n" +
        "Please **mention the channel** where you want the mystery boxes to drop.",
    );
}

/**
 * Handles the interactive setup responses.
 */
async function handleSetupResponse(message) {
    const userId = message.author.id;
    const draft = setupDrafts.get(userId);

    if (!draft) return; // Not in a setup conversation

    const dbClient = getDbClient();

    // Step 1: Channel selection
    if (draft.step === 1) {
        const channel = message.mentions.channels.first();
        if (!channel || channel.type !== Discord.ChannelType.GuildText) {
            return message.channel.send("❌ Invalid channel. Please mention a valid text channel.");
        }
        draft.channel = channel;
        draft.step = 2;
        message.channel.send(
            `✅ Channel set to ${channel}. **(Step 2/3)**\n` +
            "How often should the mystery boxes drop? (e.g., `1d 5h 2m 30s`)\n" +
            "**Units allowed:** `w` (weeks), `d` (days), `h` (hours), `m` (minutes), `s` (seconds).",
        );
        return;
    }

    // Step 2: Interval selection
    if (draft.step === 2) {
        const intervalMs = parseTimeInterval(message.content);
        if (!intervalMs) {
            return message.channel.send("❌ Invalid time format. Please use units like `1d 5h` (e.g., `1w 3d 5h 2m 15s`).");
        }
        draft.interval = intervalMs;
        draft.step = 3;
        message.channel.send(
            `✅ Drop interval set to **${formatTime(intervalMs)}**. **(Step 3/3)**\n` +
            "Now, enter the text for the rewards one by one (e.g., `2,000 Gold` or `VIP Role for 1 Week`).\n" +
            `Type \`${COMPLETION_COMMAND}\` when finished.`,
        );
        
        // Clear existing rewards for this guild before starting the new list
        try {
            await dbClient.query(`DELETE FROM mystery_rewards WHERE guild_id = $1`, [message.guild.id]);
            draft.rewards = [];
            message.channel.send("🗑️ Previous rewards have been cleared. Starting a fresh list.");
        } catch (e) {
            console.error("Failed to clear previous rewards:", e);
            message.channel.send("❌ Error clearing previous rewards. Setup aborted.");
            setupDrafts.delete(userId);
        }
        
        return;
    }

    // Step 3: Reward entry
    if (draft.step === 3) {
        const rewardText = message.content.trim();
        
        // Check for completion command
        if (rewardText.toLowerCase() === COMPLETION_COMMAND) {
            if (draft.rewards.length === 0) {
                 return message.channel.send("❌ You must enter at least one reward before completing the setup.");
            }
            
            // Save all rewards and config to the database
            try {
                // Bulk insert rewards
                const rewardQueries = draft.rewards.map(reward => 
                    dbClient.query(`INSERT INTO mystery_rewards (guild_id, reward_description) VALUES ($1, $2)`, [message.guild.id, reward])
                );
                await Promise.all(rewardQueries);
                
                // Save box configuration
                await saveMysteryBoxState(draft.channel.id, draft.interval, null); // Set next drop to null until start is called
                
                message.channel.send(
                    `🎉 **Setup Complete!**\n` +
                    `Channel: ${draft.channel}\n` +
                    `Interval: **${formatTime(draft.interval)}**\n` +
                    `Rewards Added: ${draft.rewards.length}\n\n` +
                    `Use \`${PREFIX}mysteryboxes start\` to begin the drop timer!`
                );
            } catch (e) {
                console.error("Failed to save rewards or config:", e);
                message.channel.send("❌ Database error during completion. Setup aborted.");
            } finally {
                setupDrafts.delete(userId);
            }
            
            return;
        }

        // Add the reward and confirm
        draft.rewards.push(rewardText);
        message.channel.send(`✅ Reward #${draft.rewards.length} added: \`${rewardText}\`. Enter the next reward or type \`${COMPLETION_COMMAND}\` to finish.`);
    }
}

// --- Main Command Handlers (Updated for check/use) ---

async function handleMysteryBoxesCommand(client, message, args) {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.channel.send("❌ You must have Administrator permissions to manage Mystery Box Drops.");
    }
    
    // Check if the user is in a setup conversation
    if (setupDrafts.has(message.author.id)) {
        if (message.content.toLowerCase() !== COMPLETION_COMMAND) {
            return handleSetupResponse(message);
        }
    }

    const command = args[0] ? args[0].toLowerCase() : 'help';
    const dbClient = getDbClient();

    switch (command) {
        case 'setup':
            return handleSetup(message);
            
        case 'start':
            // ... (Start logic - unchanged)
            if (!globalState.mysteryBoxChannelId || !globalState.mysteryBoxInterval) {
                 return message.channel.send("❌ Mystery box setup is incomplete. Please run `.mysteryboxes setup` first.");
            }
            
            if (globalState.mysteryBoxTimer) {
                return message.channel.send(`⚠️ The drop timer is already running! Next drop is scheduled for ${formatTime(globalState.mysteryBoxNextDrop - Date.now())}.`);
            }
            
            await saveMysteryBoxState(globalState.mysteryBoxChannelId, globalState.mysteryBoxInterval, Date.now() + globalState.mysteryBoxInterval);
            startMysteryBoxTimer(client, false); 
            
            return message.channel.send(`✅ Mystery Box drops started! First drop scheduled in **${formatTime(globalState.mysteryBoxInterval)}** in <#${globalState.mysteryBoxChannelId}>.`);

        case 'time':
            // ... (Time logic - unchanged)
            if (!globalState.mysteryBoxTimer || !globalState.mysteryBoxNextDrop) {
                return message.channel.send("❌ The Mystery Box timer is not currently running. Use `.mysteryboxes start` to begin.");
            }
            
            const remaining = globalState.mysteryBoxNextDrop - Date.now();
            const timeString = formatTime(remaining);

            return message.channel.send(`⏳ Next Mystery Box Drop in: **${timeString}**`);

        case 'reset':
            // ... (Reset logic - unchanged)
            stopMysteryBoxTimer();
            setupDrafts.delete(message.author.id); 
            
            try {
                await saveMysteryBoxState(null, null, null);
                await dbClient.query(`DELETE FROM mystery_rewards WHERE guild_id = $1`, [message.guild.id]);
                await dbClient.query(`DELETE FROM mystery_claims WHERE guild_id = $1`, [message.guild.id]); // Clear claims on reset
                
                return message.channel.send("✅ Mystery Boxes completely **reset** (timer stopped, config cleared, and all rewards/claims deleted). Run `.mysteryboxes setup` to start fresh.");
            } catch (e) {
                 console.error("Failed to reset mystery boxes:", e);
                 return message.channel.send("❌ Error occurred during database reset. Check console for details.");
            }

        case 'rewards':
            // ... (Rewards logic - unchanged)
            const dbRewards = await dbClient.query(
                `SELECT reward_description FROM mystery_rewards WHERE guild_id = $1`,
                [message.guild.id]
            ).catch(e => {
                console.error("Failed to fetch rewards:", e);
                return { rows: [] };
            });

            if (dbRewards.rows.length === 0) {
                return message.channel.send("ℹ️ No rewards have been configured yet. Use `.mysteryboxes setup` to add rewards.");
            }

            const rewardsList = dbRewards.rows.map((row, index) => 
                `**${index + 1}.** ${row.reward_description}`
            ).join('\n');

            const rewardsEmbed = new Discord.EmbedBuilder()
                .setColor(0x0099ff)
                .setTitle(`🎁 Current Mystery Box Rewards (${dbRewards.rows.length} total)`)
                .setDescription(rewardsList)
                .setFooter({ text: `These rewards are randomly selected for drops.` })
                .setTimestamp();
            
            return message.channel.send({ embeds: [rewardsEmbed] });
            
        // --- NEW COMMAND: .mysteryboxes check @user ---
        case 'check':
            const targetUserCheck = message.mentions.users.first();
            if (!targetUserCheck) {
                return message.channel.send("❌ Please mention the user you want to check their claims for (e.g., `.mysteryboxes check @user`).");
            }

            try {
                const claimsResult = await dbClient.query(
                    `SELECT claim_id, reward_description, is_used, claimed_at 
                     FROM mystery_claims 
                     WHERE guild_id = $1 AND user_id = $2 
                     ORDER BY claimed_at DESC`,
                    [message.guild.id, targetUserCheck.id]
                );

                if (claimsResult.rows.length === 0) {
                    return message.channel.send(`ℹ️ ${targetUserCheck.username} has no Mystery Box claims on record in this server.`);
                }
                
                let unusedList = '';
                let usedList = '';
                let unusedCount = 0;
                let usedCount = 0;

                claimsResult.rows.forEach(row => {
                    const status = row.is_used ? '✅ USED' : '⚠️ UNUSED';
                    const line = `\`#${row.claim_id}\` | ${row.reward_description} (${status})\n`;
                    if (row.is_used) {
                        usedList += line;
                        usedCount++;
                    } else {
                        unusedList += line;
                        unusedCount++;
                    }
                });

                const checkEmbed = new Discord.EmbedBuilder()
                    .setColor(0x3498db)
                    .setTitle(`🎁 Claims for ${targetUserCheck.username}`)
                    .setDescription(`Total Claims: ${claimsResult.rows.length} | Unused: ${unusedCount} | Used: ${usedCount}`)
                    .addFields(
                        { 
                            name: `Unused Claims (${unusedCount})`, 
                            value: unusedList || "No unused claims found.", 
                            inline: false 
                        },
                        { 
                            name: `Used/Redeemed Claims (${usedCount})`, 
                            value: usedList.substring(0, 1024) || "No redeemed claims found.", 
                            inline: false 
                        }
                    )
                    .setFooter({ text: `Use .mysteryboxes use @user #IDNumber to redeem.` })
                    .setTimestamp();

                return message.channel.send({ embeds: [checkEmbed] });

            } catch (e) {
                console.error("Failed to check claims:", e);
                return message.channel.send("❌ Error fetching claims from database.");
            }

        // --- NEW COMMAND: .mysteryboxes @user use #IDNumber ---
        case 'use':
            const targetUserUse = message.mentions.users.first();
            if (!targetUserUse) {
                 return message.channel.send("❌ Please mention the user whose reward you are marking as used (e.g., `.mysteryboxes @user use #IDNumber`).");
            }
            
            const claimIdToUse = args[2] ? args[2].replace(/^#/, '').toUpperCase() : null; // Remove leading # and uppercase for consistency
            if (!claimIdToUse) {
                 return message.channel.send("❌ Please provide the unique Claim ID to mark as used (e.g., `#A1B2C3D4`).");
            }

            try {
                // Check if the claim exists and belongs to the user and is unused
                const claimCheck = await dbClient.query(
                    `SELECT id, reward_description, is_used 
                     FROM mystery_claims 
                     WHERE guild_id = $1 AND user_id = $2 AND claim_id = $3`,
                    [message.guild.id, targetUserUse.id, claimIdToUse]
                );

                if (claimCheck.rows.length === 0) {
                    return message.channel.send(`❌ Claim ID **#${claimIdToUse}** was not found for ${targetUserUse} in this server.`);
                }
                
                const claim = claimCheck.rows[0];
                
                if (claim.is_used) {
                    return message.channel.send(`⚠️ Claim ID **#${claimIdToUse}** (**${claim.reward_description}**) has already been marked as **USED**.`);
                }

                // Mark as used
                await dbClient.query(
                    `UPDATE mystery_claims 
                     SET is_used = TRUE 
                     WHERE id = $1`,
                    [claim.id]
                );
                
                return message.channel.send(`✅ Successfully marked Claim ID **#${claimIdToUse}** (**${claim.reward_description}**) for ${targetUserUse} as **USED**.`);

            } catch (e) {
                 console.error("Failed to mark claim as used:", e);
                 return message.channel.send("❌ Error updating claim status in database.");
            }
            
        case 'done':
            if (setupDrafts.has(message.author.id)) {
                 return handleSetupResponse(message);
            }
            
        default:
            // ... (Help Embed - Updated to include new commands)
            const helpEmbed = new Discord.EmbedBuilder()
                .setColor(0x3498db)
                .setTitle("Mystery Box Drop Commands")
                .setDescription("All commands require Administrator permissions.")
                .addFields(
                    {
                        name: "`.mysteryboxes setup`",
                        value: "Starts the interactive setup to choose the channel, set the drop interval, and define the rewards.",
                        inline: false,
                    },
                    {
                        name: "`.mysteryboxes start`",
                        value: "Starts the drop timer using the configured settings and sends the first drop.",
                        inline: true,
                    },
                    {
                        name: "`.mysteryboxes time`",
                        value: "Shows the remaining time until the next Mystery Box drop.",
                        inline: true,
                    },
                    {
                        name: "`.mysteryboxes rewards`",
                        value: "View the list of all currently configured rewards.",
                        inline: true,
                    },
                    {
                        name: "`.mysteryboxes check @user`",
                        value: "View a user's claimed rewards and their unique Claim IDs.",
                        inline: false,
                    },
                    {
                        name: "`.mysteryboxes @user use #ID`",
                        value: "Marks a specific Claim ID (e.g., `#A1B2C3D4`) as redeemed/used.",
                        inline: false,
                    },
                    {
                        name: "`.mysteryboxes reset`",
                        value: "Stops the timer and clears all configuration, rewards, and claims.",
                        inline: false,
                    },
                );
            return message.channel.send({ embeds: [helpEmbed] });
    }
}

module.exports = {
    handleMysteryBoxesCommand,
    startMysteryBoxTimer, 
    handleSetupResponse, 
};