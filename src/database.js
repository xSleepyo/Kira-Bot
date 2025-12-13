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
    
    // Mystery Box State (NEW)
    mysteryBoxChannelId: null,
    mysteryBoxInterval: null, // Time in milliseconds (BIGINT from DB)
    mysteryBoxNextDrop: null, // Timestamp (Date.now()) of the next drop (BIGINT from DB)
    mysteryBoxTimer: null,    // The actual NodeJS Timer object
    
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
        
        // --- MYSTERY BOX CONFIG TABLE (NEW) ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                id INTEGER PRIMARY KEY,
                channel_id TEXT,
                interval_ms BIGINT,
                next_drop_timestamp BIGINT
            );
        `);

        // --- MYSTERY REWARDS TABLE (NEW) ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_rewards (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                reward_description TEXT NOT NULL
            );
        `);
        
        // --- MYSTERY CLAIMS TABLE (NEW) ---
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
            // Initialize default row if it doesn't exist
            await db.query(
                `
                INSERT INTO counting (id, channel_id, next_number, restart_channel_id)
                VALUES (1, $1, $2, $3)
                ON CONFLICT (id) DO NOTHING;
            `,
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
        
        // --- Load Mystery Box State (NEW) ---
        const mysteryBoxResult = await db.query(
            `SELECT channel_id, interval_ms, next_drop_timestamp FROM mystery_boxes WHERE id = 1;`
        );
        
        if (mysteryBoxResult.rows.length === 0) {
            // Initialize default row if it doesn't exist
            await db.query(
                `
                INSERT INTO mystery_boxes (id, channel_id, interval_ms, next_drop_timestamp)
                VALUES (1, $1, $2, $3)
                ON CONFLICT (id) DO NOTHING;
            `,
                [null, null, null],
            );
        } else {
            const row = mysteryBoxResult.rows[0];
            globalState.mysteryBoxChannelId = row.channel_id;
            // Safely convert BIGINT to Number, checking for null/undefined
            globalState.mysteryBoxInterval = row.interval_ms ? Number(row.interval_ms) : null; 
            globalState.mysteryBoxNextDrop = row.next_drop_timestamp ? Number(row.next_drop_timestamp) : null; 
        }
        
        console.log(
            `[DB] Loaded Mystery Box State - Channel ID: ${globalState.mysteryBoxChannelId}, Interval: ${globalState.mysteryBoxInterval}ms, Next Drop: ${globalState.mysteryBoxNextDrop}`
        );

    } catch (error) {
        // Log the error and re-throw so the bot stops if state cannot be loaded
        console.error("CRITICAL ERROR: Failed to load database state!", error);
        throw error;
    }
}

async function saveState(channelId, nextNum, restartAnnounceId = null) {
    try {
        // Update in-memory state
        globalState.nextNumberChannelId = channelId;
        globalState.nextNumber = nextNum;
        globalState.restartChannelIdToAnnounce = restartAnnounceId;

        // Update database
        await db.query(
            `
            UPDATE counting
            SET channel_id = $1, next_number = $2, restart_channel_id = $3
            WHERE id = 1;
        `,
            [channelId, nextNum, restartAnnounceId],
        );
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save database state!", error);
    }
}

/**
 * Saves the Mystery Box configuration state to the database. (NEW FUNCTION)
 */
async function saveMysteryBoxState(channelId, intervalMs, nextDropTimestamp) {
    try {
        // Update in-memory state
        globalState.mysteryBoxChannelId = channelId;
        globalState.mysteryBoxInterval = intervalMs;
        globalState.mysteryBoxNextDrop = nextDropTimestamp;

        // Ensure the intervalMs and nextDropTimestamp are stored as BIGINTs in the DB
        await db.query(
            `
            UPDATE mystery_boxes
            SET channel_id = $1, interval_ms = $2, next_drop_timestamp = $3
            WHERE id = 1;
        `,
            [channelId, intervalMs, nextDropTimestamp],
        );
        
        console.log(`[DB] Mystery Box state saved. Channel: ${channelId}, Next Drop: ${nextDropTimestamp}`);

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