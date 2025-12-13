// src/handlers.js

const Discord = require("discord.js");
const axios = require("axios");
const { PermissionFlagsBits, Events } = require("discord.js");
const { handleMysteryBoxesCommand, handleSetupResponse } = require("./mysteryboxes"); // NEW IMPORT

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
        
        const containsContent = 
            message.attachments.size > 0 || 
            message.embeds.length > 0 ||
            /\b(https?:\/\/\S+)\b/i.test(message.content); 
        
        if (containsContent) {
            try {
                // 1. Check if user has PERMANENT access saved in the database
                const dbClient = getDbClient();
                const permCheck = await dbClient.query(
                    `SELECT 1 FROM permanent_gif_users WHERE guild_id = $1 AND user_id = $2`,
                    [message.guild.id, message.author.id]
                );
                
                // If a row is found (permCheck.rowCount > 0), the user has PERMANENT access. Skip removal.
                if (permCheck.rowCount > 0) {
                    return; // Skip auto-removal for permanent users
                }

                // 2. If no permanent record found, proceed with auto-removal for one-time users
                setTimeout(async () => {
                    const currentMember = await message.guild.members.fetch(message.author.id).catch(() => null);
                    if (currentMember && currentMember.roles.cache.has(gifRole.id)) { 
                        
                        await currentMember.roles.remove(gifRole);
                        const removalMsg = await message.channel.send(
                            `🗑️ ${message.author}, your **@${GIF_PERMS_ROLE_NAME}** role has been automatically removed after posting a link/GIF. (One-time permission used)`,
                        );
                        setTimeout(() => removalMsg.delete().catch(console.error), 7000);
                    }
                }, 1000);

            } catch (error) {
                console.error("Database error during GIF perm check:", error);
                // Fail safe: If DB check fails, prevent removal to be safe.
                return;
            }
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
    if (!command.startsWith(PREFIX)) {
        // --- NEW: Check if user is in a Mystery Box setup conversation (Step 3) ---
        if (message.content.toLowerCase().startsWith(PREFIX + 'mysteryboxes done') || !message.content.startsWith(PREFIX)) {
            handleSetupResponse(message);
        }
        // --------------------------------------------------------------------------
        return;
    }

    const rawArgs = message.content.slice(PREFIX.length).trim();
    const args = rawArgs.split(/ +/).filter(a => a);
    const commandName = args.shift().toLowerCase();
    
    // --- Route to Mystery Boxes Handler (Must come before help/default) ---
    if (commandName === 'mysteryboxes') {
        return handleMysteryBoxesCommand(client, message, args);
    }

    // --- Command: .help (UPDATED) ---
    if (commandName === "help") {
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
                    value: 
                        "`.purge [number]` - Delete messages.\n" +
                        "`.gifperms @user` - Grant **one-time** GIF/link permission.\n" +
                        "`.gifperms @user perm(anent)` - Grant **permanent** GIF/link permission.\n" +
                        "`.gifperms @user revoke` - **Remove** permanent access.\n" +
                        "`.mysteryboxes setup/start/time/reset/rewards/check/use` - Manage the scheduled Mystery Box drops and claims.\n" + // UPDATED LINE
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
        // ... (Ship Logic - Unchanged)
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
        // ... (Purge Logic - Unchanged)
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
    
    // --- Command: .gifperms ---
    else if (commandName === "gifperms") {
        // ... (Gif Perms Logic - Unchanged)
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
        
        const action = args[1] ? args[1].toLowerCase() : 'one-time';
        const dbClient = getDbClient(); 
        
        try {
            if (action === 'revoke') {
                if (targetMember.roles.cache.has(gifRole.id)) {
                    await targetMember.roles.remove(gifRole);
                }
                // 1. Remove from permanent DB table
                const result = await dbClient.query(
                    `DELETE FROM permanent_gif_users WHERE guild_id = $1 AND user_id = $2`,
                    [message.guild.id, targetMember.id]
                );
                
                if (result.rowCount > 0) {
                    message.channel.send(`✅ Revoked **@${GIF_PERMS_ROLE_NAME}** and removed **permanent** status from ${targetMember}.`);
                } else {
                    message.channel.send(`⚠️ Revoked **@${GIF_PERMS_ROLE_NAME}** from ${targetMember}. User did not have permanent status.`);
                }
                
            } else if (action === 'permanent' || action === 'perm') {
                if (!targetMember.roles.cache.has(gifRole.id)) {
                    await targetMember.roles.add(gifRole);
                }
                // 1. Add to permanent DB table (ON CONFLICT DO NOTHING handles duplicates)
                await dbClient.query(
                    `INSERT INTO permanent_gif_users (guild_id, user_id) VALUES ($1, $2) ON CONFLICT (guild_id, user_id) DO NOTHING`,
                    [message.guild.id, targetMember.id]
                );
                
                message.channel.send(`✅ Granted **PERMANENT** **@${GIF_PERMS_ROLE_NAME}** to ${targetMember}. Auto-removal is now disabled for them.`);
                
            } else { // Default to one-time
                if (targetMember.roles.cache.has(gifRole.id)) {
                     return message.channel.send(`⚠️ ${targetMember} already has the **@${GIF_PERMS_ROLE_NAME}** role. Use \`.gifperms @user revoke\` first to reset status.`);
                }
                // 1. Ensure user is NOT marked as permanent
                await dbClient.query(
                    `DELETE FROM permanent_gif_users WHERE guild_id = $1 AND user_id = $2`,
                    [message.guild.id, targetMember.id]
                );
                
                await targetMember.roles.add(gifRole);
                message.channel.send(`✅ Granted **ONE-TIME** **@${GIF_PERMS_ROLE_NAME}** to ${targetMember}. They can now post **one** link/GIF before the role is automatically removed.`);
            }

        } catch (error) {
            console.error("Database error managing GIF perms role:", error);
            message.channel.send("❌ Failed to manage the role or update the database. Check the bot's role hierarchy and database connection.");
        }
    }
    // --- End of .gifperms Command ---

    // --- Command: .restart ---
    else if (commandName === "restart") {
        // ... (Restart Logic - Unchanged)
        if (!message.member.permissions.has(Discord.PermissionFlagsBits.Administrator)) {
            return message.channel.send("❌ You must have Administrator permissions to restart the bot.");
        }

        try {
            await message.channel.send("🔄 Restarting the bot now. Standby for a moment...");
            
            // 1. SAVE RESTART CHANNEL ID before shutting down
            await saveState(state.nextNumberChannelId, state.nextNumber, message.channel.id);
            
            // 2. Clean up database connection
            const dbClient = getDbClient();
            if (dbClient && dbClient.end) {
                 await dbClient.end().catch(e => console.error("Failed to close DB connection:", e));
            }

            // 3. Clean up self-ping interval
            if (globalState.selfPingInterval) {
                clearInterval(globalState.selfPingInterval);
            }
            
            // 4. Clean up mystery box timer
            if (globalState.mysteryBoxTimer) {
                clearTimeout(globalState.mysteryBoxTimer);
            }

            // 5. Destroy the Discord client connection
            client.destroy();
            
            // 6. Exit the process immediately. PM2 catches exit code 0 and automatically restarts.
            console.log("Process exiting cleanly. PM2 will handle the relaunch.");
            process.exit(0); 

        } catch (error) {
            console.error("Error during restart execution/cleanup:", error);
            message.channel.send("❌ Failed to initiate restart. Check logs.");
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
        // ... (User Info Logic - Unchanged)
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
        // ... (8ball Logic - Unchanged)
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

    // --- Command: .status ---
    else if (commandName === "status") {
        // ... (Status Logic - Unchanged)
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

    // --- Command: .joke ---
    else if (commandName === "joke") {
        // ... (Joke Logic - Unchanged)
        try {
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
    // ... (rest of the registerSlashCommands function is unchanged)
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
        // ... (Reaction Role Logic - Unchanged)
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
        // ... (Counting Game Logic - Unchanged)
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
        // ... (Reset Counting Logic - Unchanged)
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