// src/database.js

const { Client } = require("pg");

const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const globalState = {
    nextNumberChannelId: null,
    nextNumber: 1,
    restartChannelIdToAnnounce: null,
    mysteryBoxGuildId: null,
    mysteryBoxChannelId: null,
    mysteryBoxInterval: null, 
    mysteryBoxNextDrop: null, 
    activeCountdowns: [], 
};

async function setupDatabase() {
    try {
        await db.connect();
        console.log("✅ PostgreSQL Database connected.");

        // Create standard tables
        await db.query(`CREATE TABLE IF NOT EXISTS counting (id SERIAL PRIMARY KEY, channel_id TEXT, next_number INT DEFAULT 1);`);
        await db.query(`CREATE TABLE IF NOT EXISTS restart_info (id SERIAL PRIMARY KEY, channel_id TEXT);`);
        await db.query(`CREATE TABLE IF NOT EXISTS countdowns (message_id TEXT PRIMARY KEY, channel_id TEXT, title TEXT, target_timestamp BIGINT);`);
        
        // Setup Mystery Box table
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                guild_id TEXT PRIMARY KEY,
                channel_id TEXT,
                next_drop_timestamp BIGINT
            );
        `);

        // FIX: Manually add interval_ms if it was missing from the initial creation
        await db.query(`ALTER TABLE mystery_boxes ADD COLUMN IF NOT EXISTS interval_ms BIGINT;`);

    } catch (error) {
        console.error("Failed to setup database:", error);
    }
}

async function loadState() {
    try {
        const countingRes = await db.query("SELECT * FROM counting LIMIT 1;");
        if (countingRes.rows.length > 0) {
            globalState.nextNumberChannelId = countingRes.rows[0].channel_id;
            globalState.nextNumber = countingRes.rows[0].next_number;
        }

        const restartRes = await db.query("SELECT * FROM restart_info LIMIT 1;");
        if (restartRes.rows.length > 0) {
            globalState.restartChannelIdToAnnounce = restartRes.rows[0].channel_id;
        }

        const boxRes = await db.query("SELECT * FROM mystery_boxes LIMIT 1;");
        if (boxRes.rows.length > 0) {
            globalState.mysteryBoxGuildId = boxRes.rows[0].guild_id;
            globalState.mysteryBoxChannelId = boxRes.rows[0].channel_id;
            globalState.mysteryBoxInterval = boxRes.rows[0].interval_ms; 
            globalState.mysteryBoxNextDrop = boxRes.rows[0].next_drop_timestamp;
        }

        const countdownRes = await db.query("SELECT * FROM countdowns;");
        globalState.activeCountdowns = countdownRes.rows;

        console.log("✅ State loaded from Database.");
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to load state!", error);
        throw error; 
    }
}

async function saveRestartChannel(channelId) {
    globalState.restartChannelIdToAnnounce = channelId;
    await db.query("DELETE FROM restart_info;");
    await db.query("INSERT INTO restart_info (channel_id) VALUES ($1);", [channelId]);
}

async function clearLastRestartChannel() {
    globalState.restartChannelIdToAnnounce = null;
    await db.query("DELETE FROM restart_info;");
}

async function saveMysteryBoxState(guildId, channelId, intervalMs, nextDropTimestamp) {
    await db.query(
        `INSERT INTO mystery_boxes (guild_id, channel_id, interval_ms, next_drop_timestamp) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (guild_id) 
         DO UPDATE SET channel_id = $2, interval_ms = $3, next_drop_timestamp = $4;`,
        [guildId, channelId, intervalMs, nextDropTimestamp],
    );
}

const getDbClient = () => db;

module.exports = {
    setupDatabase,
    loadState,
    getDbClient,
    globalState,
    saveRestartChannel,
    clearLastRestartChannel,
    saveMysteryBoxState
};