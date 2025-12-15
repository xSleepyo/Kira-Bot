// src/handlers.js

const Discord = require("discord.js");
const axios = require("axios");
const { 
    PermissionFlagsBits, Events, SlashCommandBuilder, 
    ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, // <-- ADDED FOR INTERACTIVE HELP MENU
} = require("discord.js");
const { handleMysteryBoxesCommand, handleSetupResponse } = require("./mysteryboxes");
const countdowns = require("./countdown");

// Import data and utilities
const { 
    PREFIX, COLOR_MAP, GIF_PERMS_ROLE_NAME, PROHIBITED_WORDS, 
    generateShipName, eightBallResponses, statusCooldown, 
    COOLDOWN_TIME, userEmbedDrafts, startEmbedConversation 
} = require('./utils');

// Import database functions and state
const { 
    saveState, getState, globalState, getDbClient,
    getConfig, loadConfig, setConfig // <-- ADDED FOR /ENABLE COMMAND
} = require('./database');


// --- Helper to register all handlers on bot startup ---
function registerHandlers(client) {
    client.on("messageCreate", (message) => handleMessageCreate(client, message));
    client.on("interactionCreate", handleInteractionCreate);
    // Reaction and MessageDelete are registered in index.js for better flow
}


// --- CONFIGURATION FOR /HELP COMMAND (NEW) ---

const DASHBOARD_URL = "https://kira-discord-bot.onrender.com";
const DEFAULT_COLOR = COLOR_MAP.DEFAULT;

// Define all commands by category
const COMMAND_CATEGORIES = {
    'Admin/Setup': {
        emoji: '⚙️',
        description: 'Core bot management and server setup commands.',
        commands: [
            { name: `/setup counting`, description: 'Sets up the counting game channel.' },
            { name: `/setup mysterybox`, description: 'Sets up the mystery box drop channel.' },
            { name: `/setup reactionrole`, description: 'Creates a message for a reaction role.' },
            { name: `/setup gifperms`, description: 'Sets up a role for granting GIF/image embed permissions.' },
            { name: `/countdown`, description: 'Starts a self-updating countdown to a target time.' },
            { name: `/enable`, description: 'Toggles major features (games, fun, etc.) on/off.' },
            { name: `/${PREFIX}restart`, description: 'Gracefully restarts the bot process.' },
        ]
    },
    'Fun & Utility': {
        emoji: '✨',
        description: 'Interactive and general utility commands.',
        commands: [
            { name: `/${PREFIX}ship <user1> <user2>`, description: 'Generate a ship name between two users/names.' },
            { name: `/${PREFIX}8ball <question>`, description: 'Ask the Magic 8-Ball a question.' },
            { name: `/${PREFIX}status <text>`, description: 'Set a custom status for the bot (admin only).' },
            { name: `/${PREFIX}embed`, description: 'Starts the interactive embed builder.' },
            { name: `/${PREFIX}source`, description: 'Get a link to the bot\'s source code.' },
            { name: `/${PREFIX}ping`, description: 'Check the bot\'s latency.' },
        ]
    },
    'Misc.': {
        emoji: '📜',
        description: 'Other commands and information.',
        commands: [
            { name: `/help`, description: 'Displays this interactive help menu.' },
            { name: `/${PREFIX}list reactionroles`, description: 'Lists all active reaction roles.' },
        ]
    },
};

/**
 * Creates the initial main help embed.
 * @returns {EmbedBuilder} The welcome help embed.
 */
function createMainHelpEmbed() {
    const embed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle('📚 Kira Bot Command Menu')
        .setDescription(`Hello! I'm **Kira**, a multifunctional community bot.\n\n`
            + `Use **slash commands (\`/\`)** for admin and utility, and **prefix commands (\`${PREFIX}\`)** for fun.\n\n`
            + `Select a category from the dropdown below to view available commands.`)
        .addFields(
            { 
                name: 'Key Information', 
                value: `**Prefix:** \`${PREFIX}\`\n`
                    + `**Detailed Help:** \`/help <command>\` or Select a Category below.`
            },
            {
                name: 'Dashboard',
                value: `[**Click here to visit the Dashboard**](${DASHBOARD_URL})`
            }
        )
        .setTimestamp()
        .setFooter({ text: 'Use the dropdown menu below to navigate categories.' });

    // Add a field summarizing the categories
    const summaryValue = Object.keys(COMMAND_CATEGORIES)
        .map(cat => `${COMMAND_CATEGORIES[cat].emoji} **${cat}** - ${COMMAND_CATEGORIES[cat].description}`)
        .join('\n');

    embed.addFields({ name: 'Command Categories', value: summaryValue });

    return embed;
}

/**
 * Creates a help embed for a specific category.
 * @param {string} categoryName The name of the category.
 * @returns {EmbedBuilder} The category help embed.
 */
function createCategoryHelpEmbed(categoryName) {
    const category = COMMAND_CATEGORIES[categoryName];
    if (!category) return createMainHelpEmbed(); // Fallback

    const commandList = category.commands
        .map(cmd => `**${cmd.name}**\n${cmd.description}`)
        .join('\n\n');

    const embed = new EmbedBuilder()
        .setColor(DEFAULT_COLOR)
        .setTitle(`${category.emoji} ${categoryName} Commands`)
        .setDescription(category.description)
        .addFields(
            { name: 'Commands', value: commandList || 'No commands found for this category.' },
            {
                name: 'Dashboard',
                value: `[**Click here to visit the Dashboard**](${DASHBOARD_URL})`
            }
        )
        .setTimestamp()
        .setFooter({ text: 'Select another category from the menu or choose "Main Menu".' });
        
    return embed;
}

/**
 * Creates the Select Menu component for navigation.
 * @param {string} [currentValue='main'] The currently selected value.
 * @returns {ActionRowBuilder} The action row containing the select menu.
 */
function createHelpSelectMenu(currentValue = 'main') {
    const options = [
        {
            label: 'Main Menu',
            value: 'main',
            description: 'Go back to the main help page.',
            emoji: '🏠',
            default: currentValue === 'main',
        },
        ...Object.keys(COMMAND_CATEGORIES).map(cat => ({
            label: cat,
            // Convert 'Admin/Setup' to 'adminsetup' for a valid value ID
            value: cat.toLowerCase().replace(/[^a-z0-9]/g, ''), 
            description: COMMAND_CATEGORIES[cat].description,
            emoji: COMMAND_CATEGORIES[cat].emoji,
            default: currentValue === cat.toLowerCase().replace(/[^a-z0-9]/g, ''),
        }))
    ];

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help_menu_select')
        .setPlaceholder('Select a command category...')
        .addOptions(options);

    return new ActionRowBuilder().addComponents(selectMenu);
}


// --- SLASH COMMAND DEFINITIONS (NEW) ---

const helpCommand = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays the interactive help menu.');

const enableCommand = new SlashCommandBuilder()
    .setName('enable')
    .setDescription('Toggles a major bot feature on or off.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
        option.setName('feature')
            .setDescription('The feature to toggle.')
            .setRequired(true)
            .addChoices(
                { name: 'Games (Counting)', value: 'games' },
                { name: 'Fun Commands (.ship, .8ball)', value: 'fun' },
                { name: 'Gif Permissions Cleanup', value: 'gifperms' },
                { name: 'Mystery Boxes', value: 'mysteryboxes' }
            )
    )
    .addBooleanOption(option =>
        option.setName('state')
            .setDescription('Set to true to enable, or false to disable.')
            .setRequired(true)
    );

const setupCommand = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Sets up core bot features like counting, mystery boxes, or reaction roles.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand => 
        subcommand.setName('counting')
            .setDescription('Set up the counting game channel.')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The text channel to use for the counting game.')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand => 
        subcommand.setName('mysterybox')
            .setDescription('Set up the channel for mystery box drops and their drop interval.')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The text channel where mystery boxes will drop.')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option.setName('interval')
                    .setDescription('The time between drops (e.g., 3h, 1.5h, 30m). Max 24h.')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand => 
        subcommand.setName('reactionrole')
            .setDescription('Creates a message and sets up a reaction role.')
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('The channel to send the reaction role message to.')
                    .setRequired(true)
            )
            .addRoleOption(option =>
                option.setName('role')
                    .setDescription('The role to be given/removed.')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option.setName('emoji')
                    .setDescription('The emoji for the reaction (native or custom).')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option.setName('message')
                    .setDescription('The content of the message.')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand => 
        subcommand.setName('gifperms')
            .setDescription('Designates a role that grants users permission to send GIFs/embeds.')
            .addRoleOption(option =>
                option.setName('role')
                    .setDescription('The role that grants GIF permissions.')
                    .setRequired(true)
            )
            .addStringOption(option => 
                option.setName('message')
                    .setDescription('The message to send with the role setup (e.g., info about the role).')
                    .setRequired(true)
            )
    );


// --- SLASH COMMAND HANDLERS ---

async function handleSetupCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'counting':
            const channel = interaction.options.getChannel('channel');
            if (channel.type !== Discord.ChannelType.GuildText) {
                return interaction.reply({ content: "The channel must be a text channel.", ephemeral: true });
            }

            // Save state to database and memory
            await saveState(channel.id, 1); 

            // Clear any active countdown in that channel
            await getDbClient().query(`DELETE FROM active_countdowns WHERE channel_id = $1`, [channel.id]);

            interaction.reply({ content: `✅ Counting game channel set to ${channel}. Counting starts from 1.`, ephemeral: true });
            break;

        case 'mysterybox':
            await handleMysteryBoxesCommand(interaction, getDbClient());
            break;

        case 'reactionrole':
            const rrChannel = interaction.options.getChannel('channel');
            const rrRole = interaction.options.getRole('role');
            const rrEmoji = interaction.options.getString('emoji');
            const rrMessage = interaction.options.getString('message');

            await interaction.deferReply({ ephemeral: true });

            try {
                const sentMessage = await rrChannel.send({ content: rrMessage });

                // Check for custom emoji
                const isCustomEmoji = rrEmoji.startsWith('<') && rrEmoji.endsWith('>');
                let emojiIdentifier = rrEmoji;

                if (isCustomEmoji) {
                    const match = rrEmoji.match(/<:.+?:(\d+)>/) || rrEmoji.match(/<a:.+?:(\d+)>/);
                    if (!match) {
                         return interaction.editReply({ content: `❌ Invalid custom emoji format.`, ephemeral: true });
                    }
                    emojiIdentifier = match[0]; // Use the full identifier for Discord
                }

                await sentMessage.react(rrEmoji);

                await getDbClient().query(
                    `INSERT INTO reaction_roles (guild_id, message_id, emoji, role_id) VALUES ($1, $2, $3, $4)`,
                    [interaction.guildId, sentMessage.id, emojiIdentifier, rrRole.id]
                );

                interaction.editReply({ content: `✅ Reaction Role set up in ${rrChannel} with emoji ${rrEmoji} for role ${rrRole}.`, ephemeral: true });

            } catch (error) {
                console.error("Error setting up reaction role:", error);
                interaction.editReply({ content: "❌ Failed to set up reaction role. Check bot permissions (manage messages, add reactions).", ephemeral: true });
            }
            break;

        case 'gifperms':
            const gifRole = interaction.options.getRole('role');
            const setupMessage = interaction.options.getString('message');
            
            // Send the setup message to the channel where the command was used
            await interaction.reply({ content: setupMessage, ephemeral: false });

            // This role name is now the constant used in the filter
            globalState.gifPermsRoleId = gifRole.id; 
            
            // No need to save to DB yet, as the logic relies on a role with a specific name existing.
            // The bot uses GIF_PERMS_ROLE_NAME from utils.js to find the role, 
            // but for future flexibility, we store the ID or ensure the name matches the constant.
            // For now, we rely on the bot finding the role named GIF_PERMS_ROLE_NAME.

            // Provide a confirmation to the admin privately
            await interaction.followUp({ content: `✅ GIF Permissions role designated as **${gifRole.name}**. Automatic removal of this role is now active when a user posts an embed/GIF.`, ephemeral: true });
            break;

        default:
            interaction.reply({ content: "Unknown setup command.", ephemeral: true });
            break;
    }
}

// --- HANDLER FOR /enable COMMAND (NEW) ---

async function handleEnableCommand(interaction) {
    if (!interaction.inGuild() || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "You must be an administrator to use this command in a server.", ephemeral: true });
    }

    const feature = interaction.options.getString('feature');
    const enabled = interaction.options.getBoolean('state');
    const guildId = interaction.guildId;
    const action = enabled ? 'Enabled' : 'Disabled';

    await interaction.deferReply({ ephemeral: true });

    const success = await setConfig(guildId, feature, enabled);

    if (success) {
        let featureName = feature.charAt(0).toUpperCase() + feature.slice(1);
        if (feature === 'gifperms') featureName = 'Gif Permissions Cleanup'; // Better display name

        const replyEmbed = new EmbedBuilder()
            .setColor(enabled ? COLOR_MAP.GREEN : COLOR_MAP.RED)
            .setTitle(`Feature Toggle Successful!`)
            .setDescription(`**${featureName}** has been **${action}** for this server.`);
        
        // Special message for Gif Perms
        if (feature === 'gifperms') {
            replyEmbed.addFields({
                name: "Note on Gif Permissions",
                value: `When enabled, the bot will automatically remove the role named \`${GIF_PERMS_ROLE_NAME}\` from any user who sends a message containing an image, GIF, or embed.`,
                inline: false
            });
        }
        
        await interaction.editReply({ embeds: [replyEmbed] });
    } else {
        await interaction.editReply({ content: "❌ An error occurred while updating the configuration.", ephemeral: true });
    }
}


// --- MESSAGE CREATE HANDLER (All prefix commands & Filters) ---
async function handleMessageCreate(client, message) {
    if (message.author.bot || !message.guild) return;

    // Load or ensure config is loaded for this guild
    const config = getConfig(message.guildId) || await loadConfig(message.guildId); 

    // --- GIF PERMS CHECK (AUTOMATIC ROLE REMOVAL) ---
    // Only run if feature is enabled
    if (config.gifperms) { 
        const gifRole = message.member ? message.guild.roles.cache.find(r => r.name === GIF_PERMS_ROLE_NAME) : null;
        
        if (gifRole && message.member && message.member.roles.cache.has(gifRole.id)) {
            const hasAttachmentOrEmbed = message.attachments.size > 0 || message.embeds.some(e => e.type === 'image' || e.type === 'gifv' || e.type === 'video');

            if (hasAttachmentOrEmbed) {
                await message.member.roles.remove(gifRole)
                    .then(() => {
                        console.log(`[GIFPERMS] Removed ${gifRole.name} from ${message.author.tag}`);
                    })
                    .catch(e => console.error(`[GIFPERMS] Failed to remove role:`, e));
            }
        }
    }


    // --- COUNTING GAME LOGIC ---
    // Only run if feature is enabled
    if (config.games && message.channel.id === globalState.nextNumberChannelId) {
        // ... (rest of existing counting logic)
        const expectedNumber = globalState.nextNumber;
        const sentNumber = parseInt(message.content);

        if (sentNumber === expectedNumber) {
            globalState.nextNumber++;
            await saveState(globalState.nextNumberChannelId, globalState.nextNumber);
            await message.react('✅');
        } else {
            message.reply(`❌ Wrong number! The next number was **${expectedNumber}**. Starting over at 1.`)
                .then(reply => {
                    setTimeout(() => {
                        reply.delete().catch(console.error);
                        message.delete().catch(console.error);
                    }, 5000);
                })
                .catch(console.error);

            // Reset state
            globalState.nextNumber = 1;
            await saveState(globalState.nextNumberChannelId, 1);
        }
        return; 
    }

    // --- PREFIX COMMANDS (Legacy and Fun) ---
    if (message.content.startsWith(PREFIX)) {
        const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        // --- CORE COMMANDS (Always available) ---
        if (command === "restart" && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.channel.send("Restarting bot... (You will see the 'Instance failed' message, which is expected.)")
                .then(async (m) => {
                    await saveState(globalState.nextNumberChannelId, globalState.nextNumber, m.channel.id);
                    process.exit(0);
                });
            return;
        } else if (command === "help") {
            // Deprecated prefix help command. Advise slash command.
            message.reply(`The \`${PREFIX}help\` command is deprecated. Please use the new interactive slash command: \`/help\``);
            return;
        } else if (command === "source") {
            const embed = new Discord.EmbedBuilder()
                .setColor(COLOR_MAP.DEFAULT)
                .setTitle("Kira Bot Source Code")
                .setDescription("The full source code for Kira is available on GitHub.")
                .addFields({ 
                    name: "Repository Link", 
                    value: "[GitHub Repository](https://github.com/your-username/your-repo)" 
                })
                .setTimestamp();
            message.channel.send({ embeds: [embed] });
            return;
        } else if (command === "ping") {
            const embed = new Discord.EmbedBuilder()
                .setColor(COLOR_MAP.DEFAULT)
                .setTitle("Pong! 🏓")
                .setDescription(`Latency is ${Date.now() - message.createdTimestamp}ms.\nAPI Latency is ${Math.round(client.ws.ping)}ms.`)
                .setTimestamp();
            message.channel.send({ embeds: [embed] });
            return;
        } else if (command === "status" && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            const newStatus = args.join(' ');

            if (statusCooldown.has(message.author.id)) {
                return message.reply(`Please wait ${COOLDOWN_TIME / 1000} seconds before changing status again.`);
            }

            if (!newStatus) {
                return message.reply("Please provide a new status to set.");
            }

            client.user.setPresence({
                activities: [{ name: newStatus, type: Discord.ActivityType.Custom }],
                status: "online",
            });

            statusCooldown.add(message.author.id);
            setTimeout(() => {
                statusCooldown.delete(message.author.id);
            }, COOLDOWN_TIME);

            message.reply(`✅ Bot status set to: **${newStatus}**`);
            return;
        } else if (command === "embed" && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            startEmbedConversation(message.author.id, message.channel);
            return;
        } else if (command === "list") {
            if (args[0] === "reactionroles") {
                const db = getDbClient();
                const result = await db.query(
                    `SELECT message_id, emoji, role_id FROM reaction_roles WHERE guild_id = $1`,
                    [message.guildId]
                );
                
                if (result.rowCount === 0) {
                    return message.reply("No reaction roles found for this server.");
                }

                const list = result.rows.map(row => {
                    const role = message.guild.roles.cache.get(row.role_id);
                    return `Message ID: \`${row.message_id}\`, Emoji: ${row.emoji}, Role: ${role ? role.name : 'Unknown Role'}`;
                }).join('\n');

                const embed = new Discord.EmbedBuilder()
                    .setColor(COLOR_MAP.DEFAULT)
                    .setTitle("Active Reaction Roles")
                    .setDescription(list)
                    .setTimestamp();

                return message.channel.send({ embeds: [embed] });
            }
        }


        // --- FUN COMMANDS (Config check is here) ---
        if (config.fun) { 
            if (command === "ship") {
                if (args.length < 2) {
                    return message.reply("Please provide two names to ship (e.g., `.ship Alice Bob`).");
                }
                const name1 = args[0];
                const name2 = args[1];
                const shipName = generateShipName(name1, name2);
                message.channel.send(`💖 **${name1}** + **${name2}** = **${shipName}**`);
                return;
            } else if (command === "8ball") {
                if (!args.length) {
                    return message.reply("Ask the Magic 8-Ball a question!");
                }
                const response = eightBallResponses[Math.floor(Math.random() * eightBallResponses.length)];
                message.reply(`🎱 **${message.content.slice(PREFIX.length + command.length).trim()}**\n> ${response}`);
                return;
            }
        }

        // --- Unknown Command ---
        if (
            command !== "ship" && 
            command !== "8ball" && 
            command !== "restart" && 
            command !== "help" && 
            command !== "source" && 
            command !== "ping" && 
            command !== "status" &&
            command !== "embed" &&
            command !== "list"
        ) {
             message.reply({ 
                content: `Unknown command \`${PREFIX}${command}\`. Try \`/help\` for a list of all commands.`, 
                ephemeral: true 
            }).then(m => setTimeout(() => m.delete().catch(console.error), 5000)).catch(console.error);
        }
    }
}


// --- INTERACTION HANDLER (Slash Commands & Components) ---
async function handleInteractionCreate(interaction) {
    if (!interaction.isReady()) return;

    // The bot must be ready and the DB connected before handling interactions
    if (!globalState.isReady) {
        return interaction.reply({
            content: "❌ Bot is still initializing. Please wait a moment and try again.",
            ephemeral: true,
        }).catch(console.error);
    }

    // Ensure config is loaded for guild-specific interactions
    if (interaction.inGuild() && !globalState.config[interaction.guildId]) {
        await loadConfig(interaction.guildId);
    }

    // Handle initial embed creation responses
    if (interaction.isModalSubmit() && interaction.customId.startsWith('embedModal_')) {
        await handleEmbedModalSubmit(interaction);
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('embed_')) {
        await handleEmbedButton(interaction);
        return;
    }

    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        switch (commandName) {
            case 'setup':
                await handleSetupCommand(interaction);
                break;
            case 'countdown':
                await countdowns.handleCountdownCommand(interaction);
                break;
            case 'help': // <-- NEW: Handle /help Slash Command
                const helpEmbed = createMainHelpEmbed();
                const helpMenuRow = createHelpSelectMenu('main');
                await interaction.reply({
                    embeds: [helpEmbed],
                    components: [helpMenuRow],
                    ephemeral: false, 
                });
                break;
            case 'enable': // <-- NEW: Handle /enable Slash Command
                await handleEnableCommand(interaction);
                break;
            default:
                await interaction.reply({ content: `Unknown command: /${commandName}`, ephemeral: true });
                break;
        }
    } else if (interaction.isStringSelectMenu()) { // <-- NEW: Handle Select Menu Interaction
        if (interaction.customId === 'help_menu_select') {
            const selectedValue = interaction.values[0];
            
            let newEmbed;
            let categoryKey;

            if (selectedValue === 'main') {
                newEmbed = createMainHelpEmbed();
                categoryKey = 'main';
            } else {
                // Find the original category key from the value (e.g., 'adminsetup' -> 'Admin/Setup')
                categoryKey = Object.keys(COMMAND_CATEGORIES).find(key => 
                    key.toLowerCase().replace(/[^a-z0-9]/g, '') === selectedValue
                );
                if (categoryKey) {
                    newEmbed = createCategoryHelpEmbed(categoryKey);
                } else {
                    newEmbed = createMainHelpEmbed();
                    categoryKey = 'main';
                }
            }

            // Create a new select menu component with the currently selected value highlighted
            const newMenuRow = createHelpSelectMenu(categoryKey.toLowerCase().replace(/[^a-z0-9]/g, ''));

            // Update the original message with the new embed and menu
            await interaction.update({
                embeds: [newEmbed],
                components: [newMenuRow],
            }).catch(console.error);
        }
    }
}


// --- SLASH COMMAND REGISTRATION ---\
async function registerSlashCommands(client) {
    const commands = [
        setupCommand, 
        countdowns.countdownCommand,
        helpCommand, // <-- NEW
        enableCommand, // <-- NEW
    ];

    try {
        console.log(`[SLASH] Started refreshing ${commands.length} application (/) commands.`);
        
        // This registers global commands. Use interaction.guild.commands.set(commands) for guild commands
        const data = await client.application.commands.set(commands);

        console.log(`[SLASH] Successfully reloaded ${data.size} application (/) commands.`);
    } catch (error) {
        console.error("[SLASH] Failed to register slash commands:", error);
    }
}


// --- REACTION ROLE LOGIC ---
// ... (handleReactionRole remains the same) ...
async function handleReactionRole(reaction, user, added, db) {
    if (user.bot || reaction.message.partial || reaction.partial) return;

    try {
        const messageId = reaction.message.id;
        const guildId = reaction.message.guild.id;
        let emojiIdentifier = reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;

        // Ensure custom emojis are stored correctly
        if (reaction.emoji.id) {
            emojiIdentifier = `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`;
        } else {
            emojiIdentifier = reaction.emoji.name;
        }

        const result = await db.query(
            "SELECT role_id FROM reaction_roles WHERE message_id = $1 AND emoji = $2 AND guild_id = $3",
            [messageId, emojiIdentifier, guildId],
        );

        if (result.rowCount === 0) return; // Not a configured reaction role

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
// ... (handleMessageDelete remains the same) ...
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


// --- EXPORTS ---
module.exports = {
    registerHandlers,
    registerSlashCommands,
    handleReactionRole,
    handleMessageDelete,
    handleInteractionCreate,
    helpCommand, // Exported for registration
    enableCommand, // Exported for registration
};