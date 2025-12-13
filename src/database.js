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
    mysteryBoxChannelId: null,
    mysteryBoxInterval: null,
    mysteryBoxNextDrop: null,
    mysteryBoxTimer: null,

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

        // Add restart_channel_id if missing
        await db.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='counting' AND column_name='restart_channel_id'
                ) THEN
                    ALTER TABLE counting ADD COLUMN restart_channel_id TEXT;
                END IF;
            END $$;
        `);

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

        // --- MYSTERY BOX CONFIG TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                id INTEGER PRIMARY KEY,
                channel_id TEXT
            );
        `);

        // 🔧 MIGRATIONS FOR MYSTERY BOX COLUMNS (CRITICAL FIX)
        await db.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='mystery_boxes' AND column_name='interval_ms'
                ) THEN
                    ALTER TABLE mystery_boxes ADD COLUMN interval_ms BIGINT;
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='mystery_boxes' AND column_name='next_drop_timestamp'
                ) THEN
                    ALTER TABLE mystery_boxes ADD COLUMN next_drop_timestamp BIGINT;
                END IF;
            END $$;
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

        console.log("✅ Database tables ensured and migrated.");

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
            `[DB] Loaded Counting State - Channel: ${globalState.nextNumberChannelId}, Next: ${globalState.nextNumber}`
        );

        // --- Load Mystery Box State ---
        const mysteryBoxResult = await db.query(
            `SELECT channel_id, interval_ms, next_drop_timestamp FROM mystery_boxes WHERE id = 1;`
        );

        if (mysteryBoxResult.rows.length === 0) {
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
            globalState.mysteryBoxInterval = row.interval_ms ? Number(row.interval_ms) : null;
            globalState.mysteryBoxNextDrop = row.next_drop_timestamp ? Number(row.next_drop_timestamp) : null;
        }

        console.log(
            `[DB] Loaded Mystery Box State - Channel: ${globalState.mysteryBoxChannelId}, Interval: ${globalState.mysteryBoxInterval}, Next Drop: ${globalState.mysteryBoxNextDrop}`
        );

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

async function saveMysteryBoxState(channelId, intervalMs, nextDropTimestamp) {
    try {
        globalState.mysteryBoxChannelId = channelId;
        globalState.mysteryBoxInterval = intervalMs;
        globalState.mysteryBoxNextDrop = nextDropTimestamp;

        await db.query(
            `
            UPDATE mystery_boxes
            SET channel_id = $1, interval_ms = $2, next_drop_timestamp = $3
            WHERE id = 1;
            `,
            [channelId, intervalMs, nextDropTimestamp],
        );

        console.log(`[DB] Mystery Box state saved.`);
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
