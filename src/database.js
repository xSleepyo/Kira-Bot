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
    restartChannelIdToAnnounce: null, //
    
    mysteryBoxGuildId: null,
    mysteryBoxChannelId: null,
    mysteryBoxInterval: null, 
    mysteryBoxNextDrop: null, 
    mysteryBoxTimer: null,    
    
    activeCountdowns: [], 
    selfPingInterval: null, 
};

async function setupDatabase() {
    try {
        await db.connect();
        console.log("✅ PostgreSQL Database connected.");

        // --- COUNTING TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS counting (
                id SERIAL PRIMARY KEY,
                channel_id TEXT,
                next_number INT DEFAULT 1
            );
        `);

        // --- RESTART TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS restart_info (
                id SERIAL PRIMARY KEY,
                channel_id TEXT
            );
        `);

        // --- MYSTERY BOX TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS mystery_boxes (
                guild_id TEXT PRIMARY KEY,
                channel_id TEXT,
                next_drop_timestamp BIGINT
            );
        `);

        // FIX: Ensure interval_ms column exists (Fixes the "column does not exist" error)
        await db.query(`
            ALTER TABLE mystery_boxes 
            ADD COLUMN IF NOT EXISTS interval_ms BIGINT;
        `);

        // --- COUNTDOWNS TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS countdowns (
                message_id TEXT PRIMARY KEY,
                channel_id TEXT,
                title TEXT,
                target_timestamp BIGINT
            );
        `);

    } catch (error) {
        console.error("Failed to setup database:", error);
    }
}

async function loadState() {
    try {
        // Load Counting State
        const countingRes = await db.query("SELECT * FROM counting LIMIT 1;");
        if (countingRes.rows.length > 0) {
            globalState.nextNumberChannelId = countingRes.rows[0].channel_id;
            globalState.nextNumber = countingRes.rows[0].next_number;
        }

        // Load Restart Info
        const restartRes = await db.query("SELECT * FROM restart_info LIMIT 1;");
        if (restartRes.rows.length > 0) {
            globalState.restartChannelIdToAnnounce = restartRes.rows[0].channel_id;
        }

        // Load Mystery Box State
        const boxRes = await db.query("SELECT * FROM mystery_boxes LIMIT 1;");
        if (boxRes.rows.length > 0) {
            globalState.mysteryBoxGuildId = boxRes.rows[0].guild_id;
            globalState.mysteryBoxChannelId = boxRes.rows[0].channel_id;
            globalState.mysteryBoxInterval = boxRes.rows[0].interval_ms; // Now safe to load
            globalState.mysteryBoxNextDrop = boxRes.rows[0].next_drop_timestamp;
        }

        // Load Countdowns
        const countdownRes = await db.query("SELECT * FROM countdowns;");
        globalState.activeCountdowns = countdownRes.rows;

        console.log("✅ State loaded from Database.");
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to load state from DB!", error);
        throw error; // Re-throw so index.js knows initialization failed
    }
}

// Function used by the .restart command
async function saveRestartChannel(channelId) {
    try {
        globalState.restartChannelIdToAnnounce = channelId;
        await db.query("DELETE FROM restart_info;");
        await db.query("INSERT INTO restart_info (channel_id) VALUES ($1);", [channelId]);
    } catch (error) {
        console.error("Failed to save restart channel:", error);
    }
}

// Function used by index.js after a successful reboot
async function clearLastRestartChannel() {
    try {
        globalState.restartChannelIdToAnnounce = null;
        await db.query("DELETE FROM restart_info;");
    } catch (error) {
        console.error("Failed to clear restart channel:", error);
    }
}

async function saveMysteryBoxState(guildId, channelId, intervalMs, nextDropTimestamp) {
    try {
        globalState.mysteryBoxGuildId = guildId;
        globalState.mysteryBoxChannelId = channelId;
        globalState.mysteryBoxInterval = intervalMs;
        globalState.mysteryBoxNextDrop = nextDropTimestamp;

        await db.query(
            `INSERT INTO mystery_boxes (guild_id, channel_id, interval_ms, next_drop_timestamp) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (guild_id) 
             DO UPDATE SET channel_id = $2, interval_ms = $3, next_drop_timestamp = $4;`,
            [guildId, channelId, intervalMs, nextDropTimestamp],
        );
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save mystery box state!", error);
    }
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