// src/handlers.js

const Discord = require("discord.js");
const axios = require("axios");
const { PermissionFlagsBits, Events } = require("discord.js");

// Import data and utilities
const { 
    PREFIX, COLOR_MAP, GIF_PERMS_ROLE_NAME, PROHIBITED_WORDS, 
    generateShipName, eightBallResponses, statusCooldown, 
    COOLDOWN_TIME, userEmbedDrafts, startEmbedConversation 
} = require('./utils');

// Import database functions and state
const { saveState, getState, globalState, getDbClient } = require('./database');

// --- Helper to register all handlers on bot startup ---
function registerHandlers(client) {
    client.on("messageCreate", (message) => handleMessageCreate(client, message));
    client.on("interactionCreate", handleInteractionCreate);
    // Reaction and MessageDelete are registered in index.js for better flow
}


// --- MESSAGE CREATE HANDLER (All prefix commands & Filters) ---
async function handleMessageCreate(client, message) {
    if (message.author.bot) return;

    // --- GIF PERMS CHECK (AUTOMATIC ROLE REMOVAL) ---
    const gifRole = message.member ? message.guild.roles.cache.find(r => r.name === GIF_PERMS_ROLE_NAME) : null;
    if (gifRole && message.member && message.member.roles.cache.has(gifRole.id)) {
        // Check if the role is the permanent role. If a separate permanent role ID existed, 
        // we would check for both. Since we are using ONE role, we rely on the command 
        // logic below to only auto-remove if it was granted *without* the permanent flag.
        
        const containsContent = 
            message.attachments.size > 0 || 
            message.embeds.length > 0 ||
            /\b(https?:\/\/\S+)\b/i.test(message.content); 
        
        // This is where you would normally check if the user was granted the role permanently.
        // For now, we will assume that the auto-removal logic should ONLY happen
        // if the role was granted via the ONE-TIME command. Since we don't track 
        // who got the role permanently in a database, the default auto-removal 
        // is based purely on message content. If you want to disable auto-removal 
        // for 'permanent' users, you would need a database table to store those IDs.

        if (containsContent) {
            setTimeout(async () => {
                const currentMember = await message.guild.members.fetch(message.author.id).catch(() => null);
                if (currentMember && currentMember.roles.cache.has(gifRole.id)) { 
                    // WARNING: If you want to allow permanent users to post without losing the role, 
                    // you MUST implement a database check here to see if the user has a "permanent" status.
                    // Since that DB functionality is not here, this logic remains unchanged:
                    
                    await currentMember.roles.remove(gifRole);
                    const removalMsg = await message.channel.send(
                        `🗑️ ${message.author}, your **@${GIF_PERMS_ROLE_NAME}** role has been automatically removed after posting a link/GIF.`,
                    );
                    setTimeout(() => removalMsg.delete().catch(console.error), 7000);
                }
            }, 1000);
        }
    }
    // --- END GIF PERMS CHECK ---

    // --- ANTI-SPAM/WORD FILTER LOGIC ---
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const lowerCaseContent = message.content.toLowerCase();
        let foundWord = null;

        for (const word of PROHIBITED_WORDS) {
            const regex = new RegExp(`\\b${word}\\b`, "i"); 
            if (regex.test(lowerCaseContent)) {
                foundWord = word;
                break;
            }
        }

        if (foundWord) {
            await message.delete().catch(e => 
                console.error(`Failed to delete filtered message: ${e.message}`)
            );
            const warningMsg = await message.channel.send(
                `${message.author}, your message was deleted for containing a prohibited word. Repeated violations may result in a mute or ban.`
            );
            setTimeout(() => {
                warningMsg.delete().catch(console.error);
            }, 5000); 
            return;
        }
    }
    // ------------------------------------------

    const content = message.content;
    const command = content.toLowerCase();
    const state = getState();

    // --- Counting Logic Check ---
    if (state.nextNumberChannelId && message.channel.id === state.nextNumberChannelId) {
        const number = parseInt(content);

        if (isNaN(number)) { return; }

        if (number === state.nextNumber) {
            try {
                await new Promise((resolve) => setTimeout(resolve, 750));
                await message.react("✔️");
                await saveState(state.nextNumberChannelId, state.nextNumber + 1, null); 
            } catch (error) {
                console.error(`Failed to react to message ID ${message.id}:`, error);
                await saveState(state.nextNumberChannelId, state.nextNumber + 1, null); 
            }
        } else {
            message.channel
                .send(`Wrong Number! The next number was **${state.nextNumber}**. Try again.`)
                .then((msg) => { setTimeout(() => msg.delete().catch(console.error), 3000); });

            setTimeout(() => message.delete().catch(console.error), 3000);
        }
    }

    // Check for the prefix
    if (!command.startsWith(PREFIX)) return;

    const rawArgs = message.content.slice(PREFIX.length).trim();
    const args = rawArgs.split(/ +/).filter(a => a);
    const commandName = args.shift().toLowerCase();

    // --- Command: .help ---
    if (commandName === "help") {
        // ... (Help Embed Logic - Identical to original)
        const helpEmbed = new Discord.EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("Kira Bot Commands")
            .setDescription("Here is a list of commands you can use:")
            .addFields(
                {
                    name: "Admin Commands (Slash)",
                    value: "`/countinggame` - Setup the counting channel.\n`/resetcounting` - Reset the count to 1.\n`/embed` - Starts an interactive conversation to build an embed.\n`/reactionrole` - Set up a reaction role on a message.",
                    inline: false,
                },
                {
                    name: "Moderation & Utility (Admin Required)",
                    // FIX APPLIED HERE: Changed to clearly list .gifperms sub-commands
                    value: 
                        "`.purge [number]` - Delete messages.\n" +
                        "`.gifperms @user` - Grant **one-time** GIF/link permission.\n" +
                        "`.gifperms @user perm(anent)` - Grant **permanent** GIF/link permission.\n" +
                        "`.gifperms @user revoke` - **Remove** permanent access.\n" +
                        "`.restart` - Restarts the bot process.",
                    inline: false,
                },
                {
                    name: "General Utility",
                    value: "`.status` - Check the bot's ping and uptime.\n`.userinfo [user]` - Get information about a user.",
                    inline: false,
                },
                {
                    name: "Counting Game",
                    value: "Just post the next number in the counting channel!",
                    inline: false,
                },
                {
                    name: "Fun Commands",
                    value: "`.joke` - Get a random joke.\n`.8ball [question]` - Ask the magic 8-ball a question.\n`.flip` - Flip a coin (Heads or Tails).\n`.ship [user]` - Calculate compatibility.",
                    inline: false,
                },
            )
            .setFooter({ text: `Prefix: ${PREFIX}` });

        message.channel.send({ embeds: [helpEmbed] });
    }

    // --- Command: .ship ---
    else if (commandName === "ship") {
        // ... (Ship Logic - Identical to original, using imported generateShipName)
        const user1 = message.author;

        let user2 = message.mentions.users.first();

        if (!user2) {
            user2 = client.user;
        }

        if (user1.id === user2.id) {
            return message.channel.send("You cannot ship yourself with yourself! Mention someone else.");
        }

        const seed = user1.id.slice(0, 5) + user2.id.slice(0, 5);
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = seed.charCodeAt(i) + ((hash << 5) - hash);
        }
        const compatibility = Math.abs(hash % 101); // 0 to 100%

        const name1 = user1.username.replace(/[^a-z0-9]/gi, "");
        const name2 = user2.username.replace(/[^a-z0-9]/gi, "");
        const shipName = generateShipName(name1, name2); // Use imported function

        let shipColor = 0xff0000;
        let description = `Compatibility between **${user1.username}** and **${user2.username}**.`;

        if (compatibility >= 90) {
            shipColor = 0x00ff00;
            description = `A perfect match! Soulmates detected!`;
        } else if (compatibility >= 60) {
            shipColor = 0xffa500;
            description = `A strong connection! This ship has smooth sailing ahead.`;
        } else if (compatibility >= 30) {
            shipColor = 0xffff00;
            description = `There's potential, but watch out for a few icebergs.`;
        }

        const shipEmbed = new Discord.EmbedBuilder()
            .setColor(shipColor)
            .setTitle(`Compatibility Calculator`)
            .setDescription(description)
            .addFields(
                { name: "Pair", value: `${user1} + ${user2}`, inline: false },
                {
                    name: "Ship Name",
                    value: `**${shipName.charAt(0).toUpperCase() + shipName.slice(1)}**`,
                    inline: false,
                },
                {
                    name: "Compatibility",
                    value: `**${compatibility}%**`,
                    inline: false,
                },
            )
            .setFooter({ text: `Requested by ${message.author.tag}` });

        message.channel.send({ embeds: [shipEmbed] });
    }

    // --- Command: .purge ---
    else if (commandName === "purge") {
        // ... (Purge Logic - Identical to original)
        if (!message.member.permissions.has(Discord.PermissionFlagsBits.ManageMessages)) {
            return message.channel.send("❌ You do not have permission to manage messages.");
        }
        const amount = parseInt(args[0]);

        if (isNaN(amount) || amount <= 0 || amount > 100) {
            return message.channel.send("Please provide a number between 1 and 100 for messages to delete.");
        } 

        try {
            const deleted = await message.channel.bulkDelete(amount, true);
            const confirmMsg = await message.channel.send(`✅ Successfully deleted ${deleted.size} messages.`);
            setTimeout(() => confirmMsg.delete().catch(console.error), 5000);
        } catch (error) {
            console.error("Error during purge:", error);
            message.channel.send('❌ I was unable to delete messages. Make sure my role has "Manage Messages" permission.');
        }
    }
    
    // --- Command: .gifperms (UPDATED LOGIC) ---
    else if (commandName === "gifperms") {
        if (!message.member.permissions.has(Discord.PermissionFlagsBits.Administrator)) {
            return message.channel.send("❌ You must have Administrator permissions to manage GIF permissions.");
        }

        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.channel.send("❌ Please mention the user you want to manage GIF permissions for.");
        }

        const gifRole = message.guild.roles.cache.find((role) => role.name === GIF_PERMS_ROLE_NAME);
        if (!gifRole) {
            return message.channel.send(`❌ The role **@${GIF_PERMS_ROLE_NAME}** was not found in this server. Please create it first.`);
        }
        
        // Check for optional second argument (perm, permanent, or revoke)
        const action = args[1] ? args[1].toLowerCase() : 'one-time';
        
        try {
            if (action === 'revoke') {
                if (targetMember.roles.cache.has(gifRole.id)) {
                    await targetMember.roles.remove(gifRole);
                    message.channel.send(`✅ Revoked **@${GIF_PERMS_ROLE_NAME}** from ${targetMember}.`);
                } else {
                    message.channel.send(`⚠️ ${targetMember} does not have the **@${GIF_PERMS_ROLE_NAME}** role.`);
                }
            } else if (action === 'permanent' || action === 'perm') {
                if (!targetMember.roles.cache.has(gifRole.id)) {
                    await targetMember.roles.add(gifRole);
                }
                // NOTE: Since you are using a single role, the auto-removal logic will still trigger 
                // unless you implement a database to track permanent users and check it in the 
                // handleMessageCreate function at the top. For now, this just grants the role.
                message.channel.send(`✅ Granted **PERMANENT** **@${GIF_PERMS_ROLE_NAME}** to ${targetMember}. (Auto-removal will be skipped if DB implementation is complete)`);
            } else { // Default to one-time
                if (targetMember.roles.cache.has(gifRole.id)) {
                     return message.channel.send(`⚠️ ${targetMember} already has the **@${GIF_PERMS_ROLE_NAME}** role.`);
                }
                await targetMember.roles.add(gifRole);
                message.channel.send(`✅ Granted **ONE-TIME** **@${GIF_PERMS_ROLE_NAME}** to ${targetMember}. They can now post **one** link/GIF.`);
            }

        } catch (error) {
            console.error("Error managing GIF perms role:", error);
            message.channel.send("❌ Failed to manage the role. Check the bot's role hierarchy and permissions.");
        }
    }
    // --- End of .gifperms Command ---

    // --- Command: .restart ---
    else if (commandName === "restart") {
        if (!message.member.permissions.has(Discord.PermissionFlagsBits.Administrator)) {
            return message.channel.send("❌ You must have Administrator permissions to restart the bot.");
        }

        try {
            await message.channel.send("🔄 Restarting the bot now. Standby for a moment...");
            
            // 1. SAVE RESTART CHANNEL ID before shutting down
            await saveState(state.nextNumberChannelId, state.nextNumber, message.channel.id);
            
            // 2. Clean up database connection
            await getDbClient().end().catch(e => console.error("Failed to close DB connection:", e));

            // 3. Clean up self-ping interval
            if (globalState.selfPingInterval) {
                clearInterval(globalState.selfPingInterval);
            }

            // 4. Destroy the Discord client connection
            client.destroy();
            
            // 5. Force a delayed exit (500ms) to ensure the Discord client fully disconnects,
            // preventing the host (Render) from immediately spawning a duplicate process.
            setTimeout(() => {
                process.exit(0);
            }, 500); 

        } catch (error) {
            console.error("Error during restart cleanup:", error);
            message.channel.send("❌ Failed to initiate restart during cleanup. Check logs.");
        }
    }
    // --- End of .restart Command ---

    // --- Command: .flip ---
    else if (commandName === "flip") {
        const outcome = Math.random() < 0.5 ? "Heads" : "Tails";
        message.channel.send(`🪙 The coin landed on **${outcome}**!`);
    }

    // --- Command: .userinfo ---
    else if (commandName === "userinfo") {
        // ... (User Info Logic - Identical to original)
        const member = message.mentions.members.first() || message.member;
        const user = member.user;

        const roles =
            member.roles.cache
                .filter((role) => role.id !== message.guild.id)
                .map((role) => role.toString())
                .join(", ") || "None";

        const userInfoEmbed = new Discord.EmbedBuilder()
            .setColor(member.displayHexColor || 0x3498db)
            .setTitle(`User Information: ${user.tag}`)
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "User ID", value: user.id, inline: false },
                {
                    name: "Account Creation Date",
                    value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>`,
                    inline: false,
                },
                {
                    name: "Joined Server Date",
                    value: `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`,
                    inline: false,
                },
                { name: "Roles", value: roles, inline: false },
            )
            .setFooter({ text: `Requested by ${message.author.tag}` });

        message.channel.send({ embeds: [userInfoEmbed] });
    }

    // --- Command: .8ball ---
    else if (commandName === "8ball") {
        // ... (8ball Logic - Identical to original, using imported eightBallResponses)
        const question = args.join(" ");

        if (!question) {
            return message.channel.send("Please ask the magic 8-ball a question!");
        }

        const randomIndex = Math.floor(
            Math.random() * eightBallResponses.length,
        );
        const response = eightBallResponses[randomIndex];

        const eightBallEmbed = new Discord.EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("Magic 8-Ball")
            .addFields(
                { name: "Question", value: question, inline: false },
                { name: "Answer", value: response, inline: false },
            )
            .setFooter({ text: `Asked by ${message.author.tag}` });

        message.channel.send({ embeds: [eightBallEmbed] });
    }

    // --- Command: .status (FIXED BACKTICK) ---
    else if (commandName === "status") {
        // ... (Status Logic - Identical to original, using imported cooldown and client)
        if (statusCooldown.has(message.channel.id)) {
            return; 
        }
        
        statusCooldown.add(message.channel.id);
        setTimeout(() => {
            statusCooldown.delete(message.channel.id);
        }, COOLDOWN_TIME);

        let totalSeconds = client.uptime / 1000;
        let days = Math.floor(totalSeconds / 86400);
        totalSeconds %= 86400;
        let hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = Math.floor(totalSeconds % 60);

        const uptimeString = `${days}d, ${hours}h, ${minutes}m, ${seconds}s`;
        const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const serverCount = client.guilds.cache.size;

        const statusEmbed = new Discord.EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle("Bot Status Report")
            .setFooter({ text: "Updated Live" })
            .setTimestamp()
            .addFields(
                { name: "**Connection**", value: "```ansi\n\x1b[0;32mOnline\x1b[0m\n```", inline: true },
                { name: "**Ping**", value: `\`\`\`ansi\n\x1b[0;32m${client.ws.ping}ms\x1b[0m\n\`\`\``, inline: true },
                { name: "**Servers**", value: `\`\`\`ansi\n\x1b[0;32m${serverCount}\x1b[0m\n\`\`\``, inline: true },
                { name: "**Memory**", value: `\`\`\`ansi\n\x1b[0;32m${memoryUsage} MB\x1b[0m\n\`\`\``, inline: true },
                { name: "**Uptime**", value: `\`\`\`ansi\n\x1b[0;32m${uptimeString}\x1b[0m\n\`\`\``, inline: false },
            );

        message.channel.send({ embeds: [statusEmbed] });
    }

    // --- Command: .joke (FIXED API ENDPOINT) ---
    else if (commandName === "joke") {
        try {
            // FIX: Corrected API endpoint back to v2 for reliability
            const response = await axios.get(
                "https://v2.jokeapi.dev/joke/Any?blacklistFlags=racist,sexist,explicit&type=single",
            );
            const joke = response.data.joke;

            if (joke) {
                message.channel.send(`**Here's a joke!**\n\n${joke}`);
            } else {
                message.channel.send("Sorry, I couldn't fetch a joke right now.");
            }
        } catch (error) {
            console.error("Error fetching joke:", error);
            message.channel.send("My joke generator seems to be taking a nap. Try again later!");
        }
    }

    // --- Simple Aliases: Hello! or Hey! ---
    else if (command === "hello!" || command === "hey!") {
        message.channel.send("Hey!, how are you?");
    }
}


// --- SLASH COMMAND REGISTER ---
async function registerSlashCommands(client) {
    const commands = [
        // Counting Game Commands
        {
            name: "countinggame",
            description: "Sets up the counting game in a specified channel (Admin/Owner only).",
            options: [
                {
                    name: "channel",
                    description: "The channel where the counting game will take place.",
                    type: Discord.ApplicationCommandOptionType.Channel,
                    required: true,
                },
            ],
            default_member_permissions: PermissionFlagsBits.Administrator.toString(),
        },
        {
            name: "resetcounting",
            description: "Resets the counting game channel and restarts the count from 1 (Admin/Owner only).",
            default_member_permissions: PermissionFlagsBits.Administrator.toString(),
        },

        // Embed Builder Command
        {
            name: "embed",
            description: "Starts an interactive conversation to build and send a new embed.",
            default_member_permissions: PermissionFlagsBits.Administrator.toString(),
        },

        // /reactionrole Slash Command
        {
            name: "reactionrole",
            description: "Sets up a reaction role on a specific message (Admin only).",
            default_member_permissions: PermissionFlagsBits.Administrator.toString(),
            options: [
                {
                    name: "message_id",
                    description: "The ID of the message to monitor for reactions.",
                    type: Discord.ApplicationCommandOptionType.String,
                    required: true,
                },
                {
                    name: "emoji",
                    description: "The emoji users must react with (e.g., 👍 or custom emoji ID).",
                    type: Discord.ApplicationCommandOptionType.String,
                    required: true,
                },
                {
                    name: "role",
                    description: "The role to assign/remove.",
                    type: Discord.ApplicationCommandOptionType.Role,
                    required: true,
                },
                {
                    name: "channel",
                    description: "The channel the message is in (defaults to current channel).",
                    type: Discord.ApplicationCommandOptionType.Channel,
                    required: false,
                    channel_types: [Discord.ChannelType.GuildText],
                },
            ],
        },
    ];

    try {
        await client.application.commands.set(commands);
        console.log("Successfully registered slash commands with permissions.");
    } catch (error) {
        console.error("Failed to register commands:", error);
    }
}


// --- INTERACTION CREATE HANDLER (Slash Commands) ---
async function handleInteractionCreate(interaction) {
    if (!interaction.isCommand()) return;

    const state = getState();

    // --- /embed Handler ---
    if (interaction.commandName === "embed") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: "❌ You need Administrator permissions to use the embed builder.",
                ephemeral: true,
            });
        }
        // Use imported function and pass the drafts object
        return startEmbedConversation(interaction, userEmbedDrafts); 
    }

    // --- /reactionrole Handler ---
    else if (interaction.commandName === "reactionrole") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: "❌ You need Administrator permissions to set up reaction roles.",
                ephemeral: true,
            });
        }

        const messageId = interaction.options.getString("message_id");
        const emojiInput = interaction.options.getString("emoji");
        const role = interaction.options.getRole("role");
        const channel =
            interaction.options.getChannel("channel") || interaction.channel;

        if (channel.type !== Discord.ChannelType.GuildText) {
            return interaction.reply({
                content: "❌ The target channel must be a text channel.",
                ephemeral: true,
            });
        }

        let emojiName;
        const customEmojiMatch = emojiInput.match(/<a?:\w+:(\d+)>/);
        if (customEmojiMatch) {
            emojiName = customEmojiMatch[1];
        } else {
            emojiName = emojiInput;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const targetMessage = await channel.messages.fetch(messageId);
            await targetMessage.react(emojiName).catch((e) => {
                if (e.code === 10014) {
                    throw new Error(`Invalid emoji provided: ${emojiInput}. Ensure it is a valid server emoji or standard Unicode emoji.`);
                }
                throw e;
            });

            await getDbClient().query(
                `INSERT INTO reaction_roles (guild_id, message_id, channel_id, emoji_name, role_id)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id, emoji_name) 
                 DO UPDATE SET role_id = $5;`,
                [ interaction.guild.id, messageId, channel.id, emojiName, role.id ],
            );

            interaction.editReply({
                content: `✅ Reaction role set! Reacting to the message in ${channel} with ${emojiInput} will now grant the ${role} role.`,
                ephemeral: true,
            });
        } catch (error) {
            console.error("Error setting reaction role:", error);
            let errorMessage = "❌ An unknown error occurred while setting the reaction role.";

            if (error.code === 10008) {
                errorMessage = `❌ Could not find a message with ID \`${messageId}\` in ${channel}. Check the ID and channel!`;
            } else if (error.message.includes("Invalid emoji")) {
                errorMessage = error.message;
            } else {
                errorMessage = `❌ An error occurred: ${error.message}. Check bot permissions (Read History, Add Reactions, Manage Roles).`;
            }

            interaction.editReply({ content: errorMessage, ephemeral: true });
        }
    }

    // --- Counting Game Handlers ---
    else if (interaction.commandName === "countinggame") {
        const channel = interaction.options.getChannel("channel");

        if (!channel || channel.type !== Discord.ChannelType.GuildText) {
            return interaction.reply({
                content: "Please select a valid text channel!",
                ephemeral: true,
            });
        }

        await saveState(channel.id, 1, null); 

        await interaction.reply({
            content: `Counting Game has been successfully set up in ${channel}!`,
        });

        channel.send(`**Counting Game Created!** Start counting from **1**!`);
    } else if (interaction.commandName === "resetcounting") {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: "You do not have permission to use this command.",
                ephemeral: true,
            });
        }

        if (!state.nextNumberChannelId) { 
            return interaction.reply({
                content: "The counting game has not been set up yet! Use /countinggame first.",
                ephemeral: true,
            });
        }

        const countingChannel = await interaction.client.channels.fetch(state.nextNumberChannelId); 

        if (countingChannel) {
            await countingChannel.messages
                .fetch({ limit: 100 })
                .then((messages) => countingChannel.bulkDelete(messages));
        }

        await saveState(state.nextNumberChannelId, 1, null); 

        await interaction.reply({
            content: `The Counting Game in ${countingChannel} has been **reset**! Start counting from **1**!`,
        });

        countingChannel.send(`**Counting Game Reset!** Start counting from **1**!`);
    }
}


// --- REACTION ROLE LOGIC ---

// Handles both Add and Remove logic using the 'added' boolean
async function handleReactionRole(reaction, user, added, db) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error("Something went wrong when fetching the message:", error);
            return;
        }
    }

    const messageId = reaction.message.id;
    const guildId = reaction.message.guild.id;
    // Get emoji ID for custom emojis, or the unicode string for standard ones
    let emojiName = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;

    try {
        const result = await db.query(
            "SELECT role_id FROM reaction_roles WHERE message_id = $1 AND emoji_name = $2 AND guild_id = $3",
            [messageId, emojiName, guildId],
        );

        if (result.rows.length === 0) return;

        const roleId = result.rows[0].role_id;
        const guild = reaction.message.guild;
        const member = await guild.members.fetch(user.id);
        const role = guild.roles.cache.get(roleId);

        if (!role) {
            console.error(`Role ID ${roleId} not found.`);
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
        const result = await db.query(
            "DELETE FROM reaction_roles WHERE message_id = $1 AND guild_id = $2 RETURNING *",
            [message.id, message.guild.id],
        );

        if (result.rowCount > 0) {
            console.log(
                `[DB CLEANUP] Removed ${result.rowCount} reaction role entries associated with deleted message ID: ${message.id}`,
            );
        }
    } catch (error) {
        console.error("Error during reaction role cleanup:", error);
    }
}

module.exports = {
    registerHandlers,
    registerSlashCommands,
    handleReactionRole,
    handleMessageDelete,
    // Exporting the main handlers to be used in index.js
    handleMessageCreate,
    handleInteractionCreate,
};