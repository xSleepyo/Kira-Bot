// src/handlers.js

const Discord = require("discord.js");
const axios = require("axios");
const { 
    PermissionFlagsBits, Events, SlashCommandBuilder, 
    ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder,
} = require("discord.js");
const { handleMysteryBoxesCommand, handleSetupResponse } = require("./mysteryboxes");
const countdowns = require("./countdown"); // This is now an object containing { data, execute, ... }

// Import data and utilities
const { 
    PREFIX, COLOR_MAP, GIF_PERMS_ROLE_NAME, PROHIBITED_WORDS, 
    generateShipName, eightBallResponses, statusCooldown, 
    COOLDOWN_TIME, userEmbedDrafts, startEmbedConversation,
    handleEmbedDraftResponse // <-- RESTORED for embed handling
} = require('./utils');

// Import database functions and state
const { 
    saveState, getState, globalState, getDbClient,
    // [FIXED] Removed invalid imports that caused 'getConfig is not a function' crash.
} = require('./database');

// --- CONFIGURATION ---
const DEFAULT_COLOR = COLOR_MAP.default;

// --- Helper to register all handlers on bot startup ---
function registerHandlers(client) {
    client.on("messageCreate", (message) => handleMessageCreate(client, message));
    client.on("interactionCreate", handleInteractionCreate);
    // Reaction and MessageDelete are registered in index.js for better flow
}


// --- Slash Command Definitions ---
// This array defines the structure for registering slash commands
const slashCommands = [
    // Counting Command
    new SlashCommandBuilder()
        .setName("setcounting")
        .setDescription("Sets the channel for the counting game.")
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("The channel to use for counting.")
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // Ship Command
    new SlashCommandBuilder()
        .setName("ship")
        .setDescription("Calculate the compatibility between two users.")
        .addUserOption(option =>
            option.setName("user1")
                .setDescription("The first user.")
                .setRequired(true)
        )
        .addUserOption(option =>
            option.setName("user2")
                .setDescription("The second user.")
                .setRequired(false)
        ),
    
    // Embed Command
    new SlashCommandBuilder()
        .setName("embed")
        .setDescription("Starts the interactive embed builder.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        
    // Reaction Role Command
    new SlashCommandBuilder()
        .setName("reactionrole")
        .setDescription("Creates a reaction role message (Admin only).")
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("The channel to send the message in.")
                .setRequired(true)
                .addChannelTypes(Discord.ChannelType.GuildText)
        )
        .addStringOption(option =>
            option.setName("message")
                .setDescription("The text to put in the message.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("role_emoji_pairs")
                .setDescription("A list of role ID and emoji pairs (e.g., 123|<emoji> 456|<emoji>)")
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // Help Command
    new SlashCommandBuilder()
        .setName("help")
        .setDescription("Shows the interactive help menu."),
];


// --- Slash Command Registration ---

/**
 * Registers slash commands globally (or per-guild in development).
 * @param {Discord.Client} client 
 */
async function registerSlashCommands(client) {
    // 1. Combine local commands with imported commands
    const allCommands = [...slashCommands];
    
    // 2. Add imported countdown command data
    if (countdowns.data) {
        allCommands.push(countdowns.data);
    } else {
        console.error("Countdown module is missing the exported 'data' object for slash commands.");
    }

    try {
        await client.application.commands.set(allCommands);
        console.log(`✅ Successfully registered ${allCommands.length} global slash commands.`);

    } catch (error) {
        console.error("[SLASH] Failed to register slash commands:", error);
    }
}


// --- INTERACTION HANDLER ---

async function handleInteractionCreate(interaction) {
    if (!interaction.isCommand()) return;

    // Check if the command is one of our imported commands
    if (countdowns.data && interaction.commandName === countdowns.data.name) {
        return countdowns.execute(interaction);
    }
    
    // Check if the command is one of our locally defined commands
    const command = slashCommands.find(c => c.name === interaction.commandName);

    if (!command) return;

    try {
        switch (interaction.commandName) {
            case 'setcounting':
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: "🚫 You need Administrator permissions.", ephemeral: true });
                }
                const channel = interaction.options.getChannel("channel");
                // Reset counting game
                await saveState(channel.id, 1, null);
                return interaction.reply({ content: `✅ Counting channel set to ${channel}. Counting restarted from 1.`, ephemeral: true });

            case 'ship':
                const user1 = interaction.options.getUser("user1");
                const user2 = interaction.options.getUser("user2") || interaction.user; // Defaults to the user running the command
                
                const shipName = generateShipName(user1.username, user2.username);
                const compatibility = Math.floor(Math.random() * 101);
                
                const embed = new EmbedBuilder()
                    .setColor(0xffc0cb)
                    .setTitle(`💖 Shipping Forecast: ${user1.username} & ${user2.username}`)
                    .setDescription(`Their ship name is **${shipName}**!`)
                    .addFields(
                        { name: "Compatibility Score", value: `${compatibility}%`, inline: true }
                    )
                    .setFooter({ text: "The love calculator never lies." });
                    
                return interaction.reply({ embeds: [embed] });

            case 'embed':
                // Deferred to the utility function
                return startEmbedConversation(interaction, userEmbedDrafts); 
                
            case 'reactionrole':
                // Simple version of reaction role command
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: "🚫 You need Administrator permissions.", ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });
                
                const rrChannel = interaction.options.getChannel("channel");
                const rrMessageText = interaction.options.getString("message");
                const pairsString = interaction.options.getString("role_emoji_pairs");
                
                const pairs = pairsString.split(/\s+/).map(pair => {
                    const [roleId, emojiName] = pair.split('|');
                    return { roleId, emojiName };
                }).filter(p => p.roleId && p.emojiName);

                if (pairs.length === 0) {
                    return interaction.editReply("❌ Invalid format. Use: `<role_id>|<emoji> <role_id>|<emoji>`");
                }
                
                const rrEmbed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle("Reaction Roles")
                    .setDescription(rrMessageText);
                
                const sentMessage = await rrChannel.send({ embeds: [rrEmbed] }).catch(e => {
                    console.error("Failed to send reaction role message:", e);
                    return null;
                });

                if (!sentMessage) {
                    return interaction.editReply("❌ Failed to send message. Check bot permissions in that channel.");
                }

                const db = getDbClient();
                for (const { roleId, emojiName } of pairs) {
                    await sentMessage.react(emojiName).catch(e => console.error(`Failed to react with ${emojiName}:`, e));
                    await db.query(
                        `INSERT INTO reaction_roles (guild_id, message_id, channel_id, emoji_name, role_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id, emoji_name) DO NOTHING`,
                        [interaction.guildId, sentMessage.id, rrChannel.id, emojiName, roleId]
                    ).catch(e => console.error("Error inserting reaction role:", e));
                }
                
                return interaction.editReply(`✅ Reaction role message created in ${rrChannel} with ${pairs.length} roles.`);

            case 'help':
                // Restored basic help for robustness
                const helpEmbed = new EmbedBuilder()
                    .setColor(DEFAULT_COLOR)
                    .setTitle("Kira Bot Help Menu")
                    .setDescription("Use the text command `.help` for a complete list of commands.")
                    .addFields(
                        { name: "Text Commands (Prefix: `.`):", value: "`.ping`, `.8ball <question>`, `.count <number>`, `.mysteryboxes` (admin setup), `.setrestartchannel <#channel | none>`, **.purge**, **.gifperms**, **.restart**, **.userinfo**, **.status**" },
                        { name: "Slash Commands:", value: "`/help`, `/countdown <title> <channel> <time>`, `/setcounting <channel>`, `/ship <user1> [user2]`, `/embed`, `/reactionrole` (Admin)" }
                    );
                
                return interaction.reply({ 
                    embeds: [helpEmbed], 
                    ephemeral: true 
                });
        }
    } catch (error) {
        console.error(`Error executing command ${interaction.commandName}:`, error);
        if (interaction.deferred || interaction.replied) {
            interaction.editReply({ content: "❌ There was an error while executing this command!", ephemeral: true }).catch(() => {});
        } else {
            interaction.reply({ content: "❌ There was an error while executing this command!", ephemeral: true }).catch(() => {});
        }
    }
}


// --- MESSAGE HANDLER ---

async function handleMessageCreate(client, message) {
    if (message.author.bot) return;

    // --- Embed Builder Response Handler (must run first) ---
    if (userEmbedDrafts.has(message.author.id)) {
        // Check if user is trying to cancel
        if (message.content.toLowerCase() === 'cancel') {
            userEmbedDrafts.delete(message.author.id);
            return message.channel.send("✅ Embed builder cancelled.");
        }
        
        // Call the response handler to resume interactive embed functionality
        if (handleEmbedDraftResponse) {
             return handleEmbedDraftResponse(message, userEmbedDrafts);
        }
    }
    
    // --- Mystery Box Setup Response Handler ---
    if (message.guild && message.content.startsWith(PREFIX)) {
        if (handleSetupResponse) {
             // Let the mystery box setup handler manage the conversation state
            await handleSetupResponse(message);
        }
    }

    // --- Text Commands ---
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args[0].toLowerCase();
    
    // --- Mystery Box Text Command ---
    if (command === 'mysteryboxes') {
        // The handler is responsible for checking if the user is in setup mode
        return handleMysteryBoxesCommand(client, message, args);
    }
    
    // --- Standard Text Commands ---
    switch (command) {
        case 'help':
            // Guaranteed basic .help functionality
            const helpEmbed = new EmbedBuilder()
                .setColor(DEFAULT_COLOR)
                .setTitle("Kira Bot Text Commands")
                .setDescription("List of available text and slash commands:")
                .addFields(
                    { name: "General/Utility", value: "`.ping`, `.8ball <question>`, `.userinfo [@user]`, `.status <text>` (Admin)" },
                    { name: "Counting Game", value: "`.count <number>`, `.setrestartchannel <#channel | none>` (Admin)" },
                    { name: "Admin Tools", value: "`.purge <amount>`, `.gifperms`, `.restart`, `.mysteryboxes`" }
                )
                .setFooter({ text: `Prefix: ${PREFIX}` });
            return message.channel.send({ embeds: [helpEmbed] });

        case 'ping':
            message.channel.send(`🏓 Pong! Latency is ${client.ws.ping}ms.`);
            break;

        case '8ball':
            const question = args.slice(1).join(" ");
            if (!question) return message.reply("Please ask a question.");
            const response = eightBallResponses[Math.floor(Math.random() * eightBallResponses.length)];
            message.reply(`**Question:** ${question}\n**🎱 Magic 8-Ball:** ${response}`);
            break;

        case 'purge':
            if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return message.reply("🚫 You need the `Manage Messages` permission to use this command.");
            }
            const amount = parseInt(args[1]);
            if (isNaN(amount) || amount < 1 || amount > 100) {
                return message.reply("❌ Please provide a number between 1 and 100 to purge.");
            }
            try {
                // Bulk delete includes the command message itself, so we delete 'amount' messages.
                await message.channel.bulkDelete(amount, true);
                message.channel.send(`✅ Successfully purged ${amount} messages.`).then(msg => {
                    setTimeout(() => msg.delete().catch(() => {}), 5000); // Delete confirmation after 5 seconds
                }).catch(() => {});
            } catch (e) {
                message.channel.send("❌ I encountered an error while trying to purge messages. Check my permissions.");
                console.error("Purge error:", e);
            }
            break;

        case 'gifperms':
            if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply("🚫 You need the `Administrator` permission to manage GIF permissions.");
            }
            const roleName = GIF_PERMS_ROLE_NAME;
            let gifRole = message.guild.roles.cache.find(role => role.name === roleName);

            if (!gifRole) {
                return message.reply(`❌ Role named \`${roleName}\` not found. Please create it first.`);
            }

            const member = message.member;
            if (member.roles.cache.has(gifRole.id)) {
                await member.roles.remove(gifRole).catch(e => console.error("Remove role error:", e));
                message.reply(`✅ Removed the \`${roleName}\` role from you.`);
            } else {
                await member.roles.add(gifRole).catch(e => console.error("Add role error:", e));
                message.reply(`✅ Added the \`${roleName}\` role to you.`);
            }
            break;

        case 'restart':
            if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply("🚫 You need the `Administrator` permission to restart the bot.");
            }
            await message.channel.send("🔄 Restarting bot...");
            // Gracefully destroy the client before exiting the process
            client.destroy(); 
            process.exit(0); 
            break;

        case 'userinfo':
            const targetUser = message.mentions.users.first() || client.users.cache.get(args[1]) || message.author;
            const targetMember = message.guild ? await message.guild.members.fetch(targetUser.id).catch(() => null) : null;
            
            const joinDate = targetMember ? targetMember.joinedAt.toDateString() : 'N/A';
            const registrationDate = targetUser.createdAt.toDateString();
            const rolesList = targetMember ? targetMember.roles.cache
                .filter(r => r.id !== message.guild.id) // Exclude @everyone role
                .map(r => r.name)
                .join(', ') || 'None' : 'N/A (DM/User not in guild)';
            
            const userInfoEmbed = new EmbedBuilder()
                .setColor(DEFAULT_COLOR)
                .setTitle(`User Info: ${targetUser.tag}`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: "ID", value: targetUser.id, inline: true },
                    { name: "Bot", value: targetUser.bot ? 'Yes' : 'No', inline: true },
                    { name: "Registered", value: registrationDate, inline: false },
                    { name: "Joined Server", value: joinDate, inline: false },
                    { name: "Roles", value: rolesList, inline: false }
                )
                .setFooter({ text: `Requested by ${message.author.tag}` });

            message.channel.send({ embeds: [userInfoEmbed] });
            break;

        case 'status':
            if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply("🚫 You need the `Administrator` permission to set the bot's status.");
            }
            const statusText = args.slice(1).join(" ");
            if (!statusText) {
                return message.reply("❌ Please provide the status text. Example: `.status Listening to music`");
            }
            
            // Set activity type to Listening (2) for a common custom status look
            client.user.setPresence({
                activities: [{ name: statusText, type: Discord.ActivityType.Listening }],
                status: "online",
            });
            message.channel.send(`✅ Bot status set to **Listening to ${statusText}**.`);
            break;

        case 'count':
            // --- Counting Game Logic ---
            if (!message.guild) return; // Only allow in guilds
            
            const state = globalState; // Use global state for efficiency
            
            if (state.nextNumberChannelId && message.channel.id !== state.nextNumberChannelId) {
                return message.reply(`This is not the counting channel. Go to <#${state.nextNumberChannelId}>.`);
            }
            
            // If the channel hasn't been set, and the user is an admin, set it now
            if (!state.nextNumberChannelId) {
                 if (message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await saveState(message.channel.id, 1, null);
                    return message.channel.send(`✅ Counting channel set to **#${message.channel.name}**. Start counting from **1**!`);
                } else {
                    return message.reply("The counting channel is not set. An admin must use `.setcounting <channel>` or say `1` in the desired channel.");
                }
            }

            const number = parseInt(message.content);
            if (isNaN(number)) return; // Ignore non-numeric messages in the counting channel

            if (number === state.nextNumber) {
                // Correct number
                state.nextNumber++;
                await saveState(state.nextNumberChannelId, state.nextNumber, state.restartChannelIdToAnnounce);
                message.react('✅').catch(() => {});
            } else {
                // Incorrect number
                const restartMessage = `❌ **${message.author.username}** messed up! They should have said **${state.nextNumber}**, but said **${number}**.\nCounting restarts from **1**!`;
                
                // Announce restart in a separate channel if configured
                if (state.restartChannelIdToAnnounce) {
                    const restartChannel = message.guild.channels.cache.get(state.restartChannelIdToAnnounce);
                    if (restartChannel) {
                        restartChannel.send(restartMessage).catch(e => console.error("Failed to send restart message:", e));
                    }
                }
                
                // Announce restart in the counting channel
                message.channel.send(restartMessage);
                
                // Reset state
                await saveState(state.nextNumberChannelId, 1, state.restartChannelIdToAnnounce);
                
                // Delete the incorrect message
                message.delete().catch(() => {});
            }
            break;
            
        case 'setrestartchannel':
            if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("🚫 Admin only.");
            const channelMention = message.mentions.channels.first();
            if (!channelMention && args[1]?.toLowerCase() !== 'none') return message.reply("❌ Please mention the channel to send restart messages to, or use `none` to disable.");

            if (args[1]?.toLowerCase() === 'none') {
                 await saveState(globalState.nextNumberChannelId, globalState.nextNumber, null);
                 return message.channel.send("✅ Counting restart announcement channel disabled.");
            }
            
            await saveState(globalState.nextNumberChannelId, globalState.nextNumber, channelMention.id);
            return message.channel.send(`✅ Counting restart announcements will be sent to ${channelMention}.`);

        // ... (other text commands) ...
    }
}


// --- REACTION ROLE HANDLERS ---

/**
 * Handles adding/removing roles based on message reactions.
 * @param {Discord.MessageReaction} reaction 
 * @param {Discord.User} user 
 * @param {boolean} added - True if reaction was added, false if removed.
 * @param {pg.Client} db - PostgreSQL client.
 */
async function handleReactionRole(reaction, user, added, db) {
    if (user.bot || !reaction.message.guild) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Error fetching partial reaction:', error);
            return;
        }
    }
    
    // Construct the emoji identifier
    const emojiName = reaction.emoji.id || reaction.emoji.name;

    try {
        const result = await db.query(
            "SELECT role_id FROM reaction_roles WHERE message_id = $1 AND emoji_name = $2 AND guild_id = $3",
            [reaction.message.id, emojiName, reaction.message.guild.id]
        );

        if (result.rowCount === 0) return;

        const roleId = result.rows[0].role_id;
        const guild = reaction.message.guild;
        const member = await guild.members.fetch(user.id).catch(() => null);

        if (!member) return;
        
        const role = guild.roles.cache.get(roleId);

        if (!role) {
            console.error(`Role ID ${roleId} not found.`);
            // Optionally, delete the entry from the DB here
            return;
        }

        if (added) {
            await member.roles.add(role).catch(console.error);
        } else {
            await member.roles.remove(role).catch(console.error);
        }
    } catch (error) {
        console.error("Error handling reaction role:", error);
    }
}


// --- MESSAGE DELETE CLEANUP ---
async function handleMessageDelete(message, db) {
    if (message.partial) return;

    try {
        // Cleanup Reaction Roles
        const rrResult = await db.query(
            "DELETE FROM reaction_roles WHERE message_id = $1 AND guild_id = $2 RETURNING *",
            [message.id, message.guild.id],
        );

        if (rrResult.rowCount > 0) {
            console.log(
                `[DB CLEANUP] Removed ${rrResult.rowCount} reaction role entries associated with deleted message ID: ${message.id}`
            );
        }
        
        // Cleanup Countdowns
        const cdResult = await db.query(
            "DELETE FROM countdowns WHERE message_id = $1 AND channel_id = $2 RETURNING *",
            [message.id, message.channel.id]
        );
        
        if (cdResult.rowCount > 0) {
             console.log(`[DB CLEANUP] Removed countdown entry for deleted message ID: ${message.id}`);
             // Stop the timer if it was running
             // NOTE: Since the countdown module is imported, we should use its stop function if available
             // Assuming a stop function that clears *all* timers, as per common patterns.
             if (countdowns.stopAllTimers) {
                 // In a real multi-guild bot, you'd need a way to stop *only* the timer for the deleted message ID.
                 // For simplicity, we just log that the DB entry is gone. The timer will eventually fail on edit/fetch.
             }
        }

    } catch (error) {
        console.error("Error during message delete cleanup:", error);
    }
}


// --- EXPORTS ---
module.exports = {
    registerHandlers,
    registerSlashCommands,
    handleReactionRole,
    handleMessageDelete,
    handleMessageCreate,
};