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
    
    // Mystery Box State 
    // NOTE: This object only holds the config for the LAST guild loaded/saved.
    // For a multi-guild bot, this should be a Map: Map<guild_id, config>
    mysteryBoxGuildId: null, 
    mysteryBoxChannelId: null,
    mysteryBoxInterval: null, // Time in milliseconds (BIGINT from DB)
    mysteryBoxNextDrop: null, // Timestamp (Date.now()) of the next drop (BIGINT from DB)
    mysteryBoxTimer: null,    // The actual NodeJS Timer object
    
    // --- NEW Countdown State ---
    activeCountdowns: [], // Array to hold { channel_id, message_id, title, target_timestamp }
    
    selfPingInterval: null, 
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
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='counting' AND column_name='restart_channel_id') THEN
                    ALTER TABLE counting ADD COLUMN restart_channel_id TEXT;
                END IF;
            END $$;
        `).catch(e => console.log("Restart channel column check skipped or failed (might already exist).", e.message));

        // --- REACTION ROLES TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS reaction_roles (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                emoji_name TEXT NOT NULL,
                role_id TEXT NOT NULL,
                UNIQUE (message_id, emoji_name)
            );
        `);
        
        // --- MYSTERY BOX CONFIG TABLE (FIXED: Uses guild_id as PK to satisfy NOT NULL constraint) ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                guild_id TEXT PRIMARY KEY,
                channel_id TEXT,
                interval_ms BIGINT,
                next_drop_timestamp BIGINT
            );
        `);

        // --- MYSTERY REWARDS TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_rewards (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                reward_description TEXT NOT NULL
            );
        `);
        
        // --- MYSTERY CLAIMS TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_claims (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                claim_id TEXT UNIQUE NOT NULL,
                reward_description TEXT NOT NULL,
                is_used BOOLEAN DEFAULT FALSE,
                claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // --- COUNTDOWN TABLE (FIXED: Added guild_id, changed target_timestamp type) ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS countdowns (
                message_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,               
                channel_id TEXT NOT NULL,
                title TEXT NOT NULL,
                target_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
                interval_ms INTEGER NOT NULL
            );
        `);
        
        console.log("✅ Database tables ensured.");


    } catch (error) {
        console.error("CRITICAL ERROR: Database setup failed!", error);
        throw error;
    }
}

async function loadState() {
    try {
        // --- Load Counting State ---
        const countingResult = await db.query(
            `SELECT channel_id, next_number, restart_channel_id FROM counting WHERE id = 1;`
        );

        if (countingResult.rows.length === 0) {
            await db.query(
                `INSERT INTO counting (id, channel_id, next_number, restart_channel_id) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING;`,
                [null, 1, null],
            );
        } else {
            const row = countingResult.rows[0];
            globalState.nextNumberChannelId = row.channel_id || null;
            globalState.nextNumber = parseInt(row.next_number) || 1;
            globalState.restartChannelIdToAnnounce = row.restart_channel_id || null;
        }

        console.log(
            `[DB] Loaded Counting State - Channel ID: ${globalState.nextNumberChannelId}, Next Number: ${globalState.nextNumber}, Restart Announce Channel: ${globalState.restartChannelIdToAnnounce}`
        );
        
        // --- Load Mystery Box State ---
        // Load all rows, but only use the first one for the single-object globalState
        const mysteryBoxResult = await db.query(
            `SELECT guild_id, channel_id, interval_ms, next_drop_timestamp FROM mystery_boxes;`
        );
        
        if (mysteryBoxResult.rows.length > 0) {
            const row = mysteryBoxResult.rows[0];
            globalState.mysteryBoxGuildId = row.guild_id; 
            globalState.mysteryBoxChannelId = row.channel_id;
            globalState.mysteryBoxInterval = row.interval_ms ? Number(row.interval_ms) : null; 
            globalState.mysteryBoxNextDrop = row.next_drop_timestamp ? Number(row.next_drop_timestamp) : null; 
        } else {
             console.log("[DB] No Mystery Box config found. State is null, awaiting configuration.");
        }
        
        console.log(
            `[DB] Loaded Mystery Box State - Guild ID: ${globalState.mysteryBoxGuildId}, Channel ID: ${globalState.mysteryBoxChannelId}, Interval: ${globalState.mysteryBoxInterval}ms, Next Drop: ${globalState.mysteryBoxNextDrop}`
        );

        // --- Load Active Countdowns ---
        const countdownResult = await db.query(
            // NOTE: The target_timestamp is now a Date object in JS when retrieved from the DB 
            `SELECT channel_id, message_id, title, target_timestamp, interval_ms FROM countdowns;`
        );
        
        globalState.activeCountdowns = countdownResult.rows.filter(row => {
            // Compare the Date object returned from the DB against the current time
            return row.target_timestamp.getTime() > Date.now();
        });

        console.log(`[DB] Loaded ${globalState.activeCountdowns.length} active countdown(s).`);

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to load database state!", error);
        throw error;
    }
}

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

// Updated to accept guildId and use UPSERT logic for per-guild configuration
async function saveMysteryBoxState(guildId, channelId, intervalMs, nextDropTimestamp) {
    try {
        globalState.mysteryBoxGuildId = guildId; 
        globalState.mysteryBoxChannelId = channelId;
        globalState.mysteryBoxInterval = intervalMs;
        globalState.mysteryBoxNextDrop = nextDropTimestamp;

        await db.query(
            // Use UPSERT logic with guild_id as PK
            `INSERT INTO mystery_boxes (guild_id, channel_id, interval_ms, next_drop_timestamp) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (guild_id) 
             DO UPDATE SET channel_id = $2, interval_ms = $3, next_drop_timestamp = $4;`,
            [guildId, channelId, intervalMs, nextDropTimestamp],
        );
        
        console.log(`[DB] Mystery Box state saved for guild ${guildId}. Channel: ${channelId}, Next Drop: ${nextDropTimestamp}`);

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save mystery box state!", error);
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
};