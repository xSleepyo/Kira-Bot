// src/database.js

const { Client } = require('pg');
const globalState = {}; 

let dbClient;

/**
 * Initializes the database connection and creates necessary tables.
 */
async function initializeDatabase() { // Renamed from setupDatabase
    try {
        dbClient = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false,
            },
        });

        await dbClient.connect();
        console.log("Database connection successful.");

        await createTables();

    } catch (error) {
        console.error("CRITICAL ERROR: Failed to connect or initialize database:", error);
        throw error;
    }
}

/**
 * Creates all necessary tables if they don't exist.
 */
async function createTables() {
    // Consolidated all table creation logic here to ensure correct schema on startup
    const createTableQueries = [
        // 1. Bot State (for counting game, restart channel) - Replaces 'counting' table
        `CREATE TABLE IF NOT EXISTS bot_state (
            id SERIAL PRIMARY KEY,
            next_number_channel_id TEXT,
            next_number INT NOT NULL DEFAULT 1,
            restart_channel_id TEXT
        );`,

        // 2. Reaction Roles
        `CREATE TABLE IF NOT EXISTS reaction_roles (
            guild_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            emoji_name TEXT NOT NULL,
            role_id TEXT NOT NULL,
            PRIMARY KEY (message_id, emoji_name)
        );`,

        // 3. Permanent GIF Users
        `CREATE TABLE IF NOT EXISTS permanent_gif_users (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        );`,

        // 4. Mystery Box State - Replaces 'mystery_boxes' table
        `CREATE TABLE IF NOT EXISTS mystery_box_state (
            id SERIAL PRIMARY KEY,
            last_drop_time TIMESTAMP WITH TIME ZONE,
            next_drop_time TIMESTAMP WITH TIME ZONE,
            drop_interval_ms BIGINT,
            drop_channel_id TEXT,
            active_message_id TEXT,
            reward_role_id TEXT
        );`,
        
        // 5. Countdowns (CRITICAL: Includes interval_ms to fix missing column error)
        `CREATE TABLE IF NOT EXISTS countdowns (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            end_time TIMESTAMP WITH TIME ZONE NOT NULL,
            title TEXT NOT NULL,
            interval_ms INTEGER NOT NULL DEFAULT 60000 
        );` 
    ];

    for (const query of createTableQueries) {
        await dbClient.query(query);
    }
    console.log("All tables checked/created.");
}

// --- State Management Functions ---

// Loads general bot state (counting game/restart channel)
async function loadState() {
    try {
        const result = await dbClient.query('SELECT * FROM bot_state LIMIT 1');
        if (result.rows.length > 0) {
            return result.rows[0];
        }
        // Initialize if empty
        const insertResult = await dbClient.query(
            'INSERT INTO bot_state (next_number) VALUES (1) RETURNING *'
        );
        return insertResult.rows[0];
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to load database state:", error);
        throw error;
    }
}

// Saves general bot state
async function saveState(nextNumberChannelId, nextNumber, restartChannelId) {
    await dbClient.query(
        `UPDATE bot_state SET 
            next_number_channel_id = $1, 
            next_number = $2,
            restart_channel_id = $3`,
        [nextNumberChannelId, nextNumber, restartChannelId]
    );
}

// Loads Mystery Box state (new structure)
async function loadMysteryBoxState() {
    const result = await dbClient.query('SELECT * FROM mystery_box_state LIMIT 1');
    if (result.rows.length > 0) {
        return result.rows[0];
    }
    return null;
}

// Saves Mystery Box state (new structure)
async function saveMysteryBoxState(state) {
    if (!state || !dbClient) return; // Safety check

    if (!state.id) {
        // Insert new row if state is new
        const result = await dbClient.query(
            `INSERT INTO mystery_box_state (
                last_drop_time, next_drop_time, drop_interval_ms, drop_channel_id, active_message_id, reward_role_id
            ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
                state.last_drop_time || null, 
                state.next_drop_time || null, 
                state.drop_interval_ms || null, 
                state.drop_channel_id || null, 
                state.active_message_id || null, 
                state.reward_role_id || null
            ]
        );
        state.id = result.rows[0].id;
    } else {
        // Update existing row
        await dbClient.query(
            `UPDATE mystery_box_state SET 
                last_drop_time = $1, 
                next_drop_time = $2, 
                drop_interval_ms = $3, 
                drop_channel_id = $4, 
                active_message_id = $5, 
                reward_role_id = $6 
            WHERE id = $7`,
            [
                state.last_drop_time, 
                state.next_drop_time, 
                state.drop_interval_ms, 
                state.drop_channel_id, 
                state.active_message_id, 
                state.reward_role_id,
                state.id
            ]
        );
    }
}

// --- Getter and Exports ---

function getDbClient() {
    if (!dbClient) {
        throw new Error("Database client not initialized.");
    }
    return dbClient;
}

function getState() {
    return globalState.botState; 
}

module.exports = {
    initializeDatabase, // Renamed from setupDatabase
    loadState,
    saveState,
    loadMysteryBoxState, // New function for the new mystery box structure
    saveMysteryBoxState, // New function for the new mystery box structure
    getDbClient,
    getState,
    globalState,
};