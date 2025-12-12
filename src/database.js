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
        
        // --- NEW: Ensure permanent_gif_users table exists ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS permanent_gif_users (
                guild_id VARCHAR(20) NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                PRIMARY KEY (guild_id, user_id)
            );
        `);
        // ----------------------------------------------------

        console.log("✅ Database tables ensured.");
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to connect or setup database!", error);
        throw error;
    }
}

async function loadState() {
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

const getState = () => globalState;
const getDbClient = () => db;

module.exports = {
    setupDatabase,
    loadState,
    saveState,
    getState,
    getDbClient,
    globalState, // Exporting the mutable state object for convenience
};