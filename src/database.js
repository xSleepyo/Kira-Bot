// src/database.js

const { Client } = require("pg");

const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Global object to hold all state variables
const globalState = {
    // Counting Game State
    nextNumberChannelId: null,
    nextNumber: 1,
    restartChannelIdToAnnounce: null,
    
    // Mystery Box State (FIXES "interval_ms" error)
    mysteryBoxChannelId: null,
    mysteryBoxInterval: null, // Time in milliseconds (BIGINT from DB)
    mysteryBoxNextDrop: null, // Timestamp (Date.now()) of the next drop (BIGINT from DB)
    mysteryBoxTimer: null,    // The actual NodeJS Timer object
    
    // --- NEW Countdown State ---
    activeCountdowns: [], // Array to hold { channel_id, message_id, title, target_timestamp }
    
    // --- NEW Feature Toggle State (Per Guild) ---
    // Structure: { 'guildId': { 'games': true, 'fun': true, 'gifperms': true, 'mysteryboxes': true } }
    config: {}, 

    selfPingInterval: null, 
    isReady: false, // Tracks if bot has fully initialized all state
};

async function setupDatabase() {
    try {
        await db.connect();
        console.log("✅ PostgreSQL Database connected.");

        // --- COUNTING TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS counting (
                id INTEGER PRIMARY KEY,
                channel_id TEXT,
                next_number INTEGER
            );
        `);
        // Check and add restart_channel_id column
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'counting'::regclass AND attname = 'restart_channel_id') THEN
                    ALTER TABLE counting ADD COLUMN restart_channel_id TEXT;
                END IF;
            END $$;
        `);
        await db.query(`INSERT INTO counting (id, next_number) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;`);
        
        // --- REACTION ROLES TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS reaction_roles (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                emoji TEXT NOT NULL,
                role_id TEXT NOT NULL
            );
        `);

        // --- MYSTERY BOXES TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                id INTEGER PRIMARY KEY,
                channel_id TEXT,
                interval_ms BIGINT,
                next_drop_timestamp BIGINT
            );
        `);
        // Ensure initial row exists
        await db.query(`INSERT INTO mystery_boxes (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
        
        // --- COUNTDOWNS TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS active_countdowns (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                message_id TEXT,
                title TEXT NOT NULL,
                target_timestamp BIGINT NOT NULL
            );
        `);

        // --- CONFIG TABLE (NEW) ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS config (
                guild_id TEXT PRIMARY KEY,
                games_enabled BOOLEAN DEFAULT TRUE,
                fun_enabled BOOLEAN DEFAULT TRUE,
                gifperms_enabled BOOLEAN DEFAULT TRUE,
                mysteryboxes_enabled BOOLEAN DEFAULT TRUE
            );
        `);


        console.log("✅ Database tables ensured.");

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to connect or initialize database:", error);
        throw error;
    }
}


// --- STATE LOADING ---

async function loadState() {
    try {
        // Load Counting State
        const countingResult = await db.query(`SELECT * FROM counting WHERE id = 1;`);
        if (countingResult.rows.length > 0) {
            const row = countingResult.rows[0];
            globalState.nextNumberChannelId = row.channel_id;
            globalState.nextNumber = row.next_number;
            globalState.restartChannelIdToAnnounce = row.restart_channel_id;
        }

        // Load Mystery Box State
        const mysteryBoxResult = await db.query(`SELECT * FROM mystery_boxes WHERE id = 1;`);
        if (mysteryBoxResult.rows.length > 0) {
            const row = mysteryBoxResult.rows[0];
            globalState.mysteryBoxChannelId = row.channel_id;
            globalState.mysteryBoxInterval = row.interval_ms ? Number(row.interval_ms) : null;
            globalState.mysteryBoxNextDrop = row.next_drop_timestamp ? Number(row.next_drop_timestamp) : null;
            console.log(`[DB] Loaded Mystery Box state. Channel: ${globalState.mysteryBoxChannelId}, Next Drop: ${globalState.mysteryBoxNextDrop}`);
        }
        
        // Load Active Countdowns
        const countdownResult = await db.query(`SELECT * FROM active_countdowns;`);
        globalState.activeCountdowns = countdownResult.rows;
        console.log(`[DB] Loaded ${globalState.activeCountdowns.length} active countdown(s).`);

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to load database state!", error);
    }
}

// --- CONFIGURATION FUNCTIONS (NEW) ---

/**
 * Loads configuration for a specific guild and caches it in globalState.
 * @param {string} guildId The ID of the guild.
 * @returns {object} The guild's configuration.
 */
async function loadConfig(guildId) {
    try {
        const result = await db.query(
            `SELECT * FROM config WHERE guild_id = $1;`,
            [guildId]
        );

        if (result.rowCount === 0) {
            // Insert default config if none exists for this guild
            await db.query(
                `INSERT INTO config (guild_id) VALUES ($1);`,
                [guildId]
            );
            const defaultConfig = {
                games: true,
                fun: true,
                gifperms: true,
                mysteryboxes: true,
            };
            globalState.config[guildId] = defaultConfig;
            return defaultConfig;
        }

        const row = result.rows[0];
        const config = {
            games: row.games_enabled,
            fun: row.fun_enabled,
            gifperms: row.gifperms_enabled,
            mysteryboxes: row.mysteryboxes_enabled,
        };
        globalState.config[guildId] = config;
        return config;

    } catch (error) {
        console.error(`[DB] Failed to load config for guild ${guildId}:`, error);
        // Return defaults on failure
        return {
            games: true,
            fun: true,
            gifperms: true,
            mysteryboxes: true,
        };
    }
}

/**
 * Sets the enabled state for a specific feature and guild.
 * @param {string} guildId The ID of the guild.
 * @param {string} feature The feature key ('games', 'fun', 'gifperms', 'mysteryboxes').
 * @param {boolean} enabled The desired state (true/false).
 * @returns {boolean} True if successful, false otherwise.
 */
async function setConfig(guildId, feature, enabled) {
    try {
        const columnName = `${feature}_enabled`;

        await db.query(
            `INSERT INTO config (guild_id, ${columnName}) 
             VALUES ($1, $2)
             ON CONFLICT (guild_id) 
             DO UPDATE SET ${columnName} = $2;`,
            [guildId, enabled]
        );

        // Update global state cache
        if (!globalState.config[guildId]) {
            await loadConfig(guildId); 
        }
        globalState.config[guildId][feature] = enabled;

        return true;
    } catch (error) {
        console.error(`[DB] Failed to set config for guild ${guildId}, feature ${feature}:`, error);
        return false;
    }
}

// --- STATE SAVING ---
// ... (saveState, saveMysteryBoxState, saveCountdownState, deleteCountdownState remain the same) ...
async function saveState(channelId, nextNum, restartAnnounceId = null) {
    try {
        globalState.nextNumberChannelId = channelId;
        globalState.nextNumber = nextNum;
        globalState.restartChannelIdToAnnounce = restartAnnounceId;

        await db.query(
            `UPDATE counting SET channel_id = $1, next_number = $2, restart_channel_id = $3 WHERE id = 1;`,
            [channelId, nextNum, restartAnnounceId],
        );
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save database state!", error);
    }
}

async function saveMysteryBoxState(channelId, intervalMs, nextDropTimestamp) {
    try {
        globalState.mysteryBoxChannelId = channelId;
        globalState.mysteryBoxInterval = intervalMs;
        globalState.mysteryBoxNextDrop = nextDropTimestamp;

        await db.query(
            `UPDATE mystery_boxes SET channel_id = $1, interval_ms = $2, next_drop_timestamp = $3 WHERE id = 1;`,
            [channelId, intervalMs, nextDropTimestamp],
        );
        
        console.log(`[DB] Mystery Box state saved. Channel: ${channelId}, Next Drop: ${nextDropTimestamp}`);

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save mystery box state! (mysteryboxes)", error);
    }
}

async function saveCountdownState(guildId, channelId, messageId, title, targetTimestamp) {
    try {
        await db.query(
            `INSERT INTO active_countdowns (guild_id, channel_id, message_id, title, target_timestamp) 
             VALUES ($1, $2, $3, $4, $5);`,
            [guildId, channelId, messageId, title, targetTimestamp],
        );

        // Reload state to update in-memory list (not strictly necessary but safer)
        await loadState();
        
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save countdown state! (active_countdowns)", error);
    }
}

async function deleteCountdownState(messageId) {
    try {
        await db.query(
            `DELETE FROM active_countdowns WHERE message_id = $1;`,
            [messageId]
        );
        // Reload state to update in-memory list
        await loadState();

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to delete countdown state! (active_countdowns)", error);
    }
}

const getState = () => globalState;
const getDbClient = () => db;

module.exports = {
    setupDatabase,
    loadState,
    saveState,
    getState,
    getDbClient,
    globalState,
    saveMysteryBoxState,
    saveCountdownState,
    deleteCountdownState,
    loadConfig,
    setConfig,
    getConfig: (guildId) => globalState.config[guildId], // Helper to access cached config
};