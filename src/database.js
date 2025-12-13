// src/database.js

const { Client } = require("pg");

const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// Global object to hold all state variables
const globalState = {
    nextNumberChannelId: null,
    nextNumber: 1,
    restartChannelIdToAnnounce: null,
    selfPingInterval: null, // Stays here as it is tied to the running state
    
    // Mystery Box State
    mysteryBoxInterval: null,
    mysteryBoxChannelId: null,
    mysteryBoxNextDrop: null, // UTC timestamp of the next drop
    mysteryBoxTimer: null,   // Holds the setInterval/setTimeout reference
};

async function setupDatabase() {
    try {
        await db.connect();
        console.log("✅ PostgreSQL Database connected.");

        // Ensure counting table exists
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

        // Ensure reaction_roles table exists
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
        
        // Ensure permanent_gif_users table exists
        await db.query(`
            CREATE TABLE IF NOT EXISTS permanent_gif_users (
                guild_id VARCHAR(20) NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                PRIMARY KEY (guild_id, user_id)
            );
        `);
        
        // Mystery Box Configuration Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                id INTEGER PRIMARY KEY,
                guild_id TEXT NOT NULL,
                channel_id TEXT,
                drop_interval_ms BIGINT,
                next_drop_timestamp BIGINT
            );
        `);

        // Mystery Box Rewards Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_rewards (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                reward_description TEXT NOT NULL
            );
        `);

        // --- NEW: Mystery Box Claims Table ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_claims (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                claim_id TEXT UNIQUE NOT NULL, -- The unique ID the user will 'use'
                reward_description TEXT NOT NULL,
                claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                is_used BOOLEAN DEFAULT FALSE
            );
        `);
        // -------------------------------------

        console.log("✅ Database tables ensured.");
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to connect or setup database!", error);
        throw error;
    }
}

async function loadState(client) {
    try {
        const result = await db.query(
            "SELECT channel_id, next_number, restart_channel_id FROM counting WHERE id = 1",
        );

        if (result.rows.length > 0) {
            const row = result.rows[0];
            globalState.nextNumberChannelId = row.channel_id || null;
            globalState.nextNumber = parseInt(row.next_number) || 1;
            globalState.restartChannelIdToAnnounce = row.restart_channel_id || null;
        } else {
            // Ensure the initial row exists
            await db.query(
                `
                INSERT INTO counting (id, channel_id, next_number, restart_channel_id)
                VALUES (1, $1, $2, $3)
                ON CONFLICT (id) DO NOTHING;
            `,
                [null, 1, null],
            );
        }

        // Load Mystery Box State
        const mbResult = await db.query(
            "SELECT channel_id, drop_interval_ms, next_drop_timestamp FROM mystery_boxes WHERE id = 1",
        );
        if (mbResult.rows.length > 0) {
            const row = mbResult.rows[0];
            globalState.mysteryBoxChannelId = row.channel_id;
            globalState.mysteryBoxInterval = row.drop_interval_ms ? Number(row.drop_interval_ms) : null;
            globalState.mysteryBoxNextDrop = row.next_drop_timestamp ? Number(row.next_drop_timestamp) : null;
            
            // If the timer was running, restart the countdown
            if (globalState.mysteryBoxChannelId && globalState.mysteryBoxInterval && globalState.mysteryBoxNextDrop && client) {
                 const { startMysteryBoxTimer } = require('./mysteryboxes');
                 startMysteryBoxTimer(client); // Will calculate the remaining time
            }
        } else {
             await db.query(
                `
                INSERT INTO mystery_boxes (id, guild_id)
                VALUES (1, $1)
                ON CONFLICT (id) DO NOTHING;
            `,
                [process.env.GUILD_ID || '1'], // Assuming single guild bot for simplicity, or grab ID later
            );
        }

        console.log(
            `[DB] Loaded Channel ID: ${globalState.nextNumberChannelId}, Next Number: ${globalState.nextNumber}, Restart Announce Channel: ${globalState.restartChannelIdToAnnounce}`,
        );
    } catch (error) {
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

// Mystery Box State Save Function
async function saveMysteryBoxState(channelId, intervalMs, nextDropTimestamp) {
     try {
        // Update in-memory state
        globalState.mysteryBoxChannelId = channelId;
        globalState.mysteryBoxInterval = intervalMs;
        globalState.mysteryBoxNextDrop = nextDropTimestamp;

        // Update database
        await db.query(
            `
            UPDATE mystery_boxes
            SET channel_id = $1, drop_interval_ms = $2, next_drop_timestamp = $3
            WHERE id = 1;
        `,
            [channelId, intervalMs, nextDropTimestamp],
        );
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save Mystery Box state!", error);
    }
}

const getState = () => globalState;
const getDbClient = () => db;

module.exports = {
    setupDatabase,
    loadState,
    saveState,
    saveMysteryBoxState, 
    getState,
    getDbClient,
    globalState, 
};