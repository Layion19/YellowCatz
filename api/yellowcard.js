import { initDatabase } from './lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const config = { api: { bodyParser: false } };

const MAX_SLOTS = 500;
const TOTAL_COMMON_CARDS = 38;

// Fisher-Yates shuffle
function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    await initDatabase();

    // Parse body
    let body = {};
    try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (rawBody) body = JSON.parse(rawBody);
    } catch (e) {}

    const { action } = body;

    // Ensure tables exist
    await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            wallet TEXT NOT NULL UNIQUE,
            card_type TEXT NOT NULL,
            card_number TEXT NOT NULL,
            entry_number INTEGER NOT NULL,
            qrt_link TEXT,
            comment_link TEXT,
            discord_username TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Add discord_username column if it doesn't exist (for existing tables)
    try {
        await db.execute(`ALTER TABLE yellowcard_entries ADD COLUMN discord_username TEXT`);
    } catch (e) {
        // Column already exists, ignore
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_config (
            id INTEGER PRIMARY KEY,
            gold_entry INTEGER NOT NULL,
            emperor_entry INTEGER NOT NULL,
            initial_shuffle TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Pending assignments - prevents refresh exploit
    await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_pending (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            card_type TEXT NOT NULL,
            card_number TEXT NOT NULL,
            entry_number INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ============================================================
    // Helper: Get or create config (gold/emperor entry numbers + initial shuffle)
    // ============================================================
    async function getOrCreateConfig() {
        const existing = await db.execute('SELECT * FROM yellowcard_config WHERE id = 1');
        
        if (existing.rows.length > 0) {
            return {
                goldEntry: existing.rows[0].gold_entry,
                emperorEntry: existing.rows[0].emperor_entry,
                initialShuffle: JSON.parse(existing.rows[0].initial_shuffle)
            };
        }

        // Gold: minimum entry 51 (after 50 completed), max 500
        // This ensures at least 50 people complete before Gold can appear
        const MIN_GOLD_ENTRY = 51;
        let goldEntry = Math.floor(Math.random() * (MAX_SLOTS - MIN_GOLD_ENTRY + 1)) + MIN_GOLD_ENTRY;
        
        // Emperor: can be anywhere 1-500, but different from Gold
        let emperorEntry;
        do {
            emperorEntry = Math.floor(Math.random() * MAX_SLOTS) + 1;
        } while (emperorEntry === goldEntry);

        // Generate initial shuffle for first 38 entries (each common card 1-38 appears once)
        const initialShuffle = shuffle(Array.from({ length: TOTAL_COMMON_CARDS }, (_, i) => i + 1));

        await db.execute({
            sql: 'INSERT INTO yellowcard_config (id, gold_entry, emperor_entry, initial_shuffle) VALUES (1, ?, ?, ?)',
            args: [goldEntry, emperorEntry, JSON.stringify(initialShuffle)]
        });

        return { goldEntry, emperorEntry, initialShuffle };
    }

    // ============================================================
    // Helper: Get card distribution stats
    // ============================================================
    async function getCardDistribution() {
        const result = await db.execute(`
            SELECT card_number, COUNT(*) as count 
            FROM yellowcard_entries 
            WHERE card_type = 'common'
            GROUP BY card_number
        `);
        
        const distribution = {};
        for (let i = 1; i <= TOTAL_COMMON_CARDS; i++) {
            distribution[i] = 0;
        }
        result.rows.forEach(row => {
            distribution[row.card_number] = row.count;
        });
        return distribution;
    }

    // ============================================================
    // Helper: Assign card based on entry number
    // ============================================================
    async function assignCard(entryNumber) {
        const config = await getOrCreateConfig();

        // Check for Gold
        if (entryNumber === config.goldEntry) {
            // Verify Gold hasn't been assigned yet
            const goldCheck = await db.execute("SELECT id FROM yellowcard_entries WHERE card_type = 'gold'");
            if (goldCheck.rows.length === 0) {
                return { cardType: 'gold', cardNumber: 'Gold' };
            }
        }

        // Check for Emperor
        if (entryNumber === config.emperorEntry) {
            // Verify Emperor hasn't been assigned yet
            const emperorCheck = await db.execute("SELECT id FROM yellowcard_entries WHERE card_type = 'emperor'");
            if (emperorCheck.rows.length === 0) {
                return { cardType: 'emperor', cardNumber: 'Emperor' };
            }
        }

        // Common card assignment
        if (entryNumber <= TOTAL_COMMON_CARDS) {
            // First 38 entries: use shuffled order (each common card exactly once)
            const cardNum = config.initialShuffle[entryNumber - 1];
            return { cardType: 'common', cardNumber: cardNum };
        } else {
            // After 38: balanced distribution (assign the least distributed card)
            const distribution = await getCardDistribution();
            
            // Find the minimum count
            const minCount = Math.min(...Object.values(distribution));
            
            // Get all cards with minimum count
            const leastUsed = Object.entries(distribution)
                .filter(([_, count]) => count === minCount)
                .map(([num, _]) => parseInt(num));
            
            // Random pick among least used
            const cardNum = leastUsed[Math.floor(Math.random() * leastUsed.length)];
            return { cardType: 'common', cardNumber: cardNum };
        }
    }

    // ============================================================
    // ACTION: getStatus
    // ============================================================
    if (action === 'getStatus') {
        const completed = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
        const pending = await db.execute('SELECT COUNT(*) as count FROM yellowcard_pending');
        
        const completedCount = completed.rows[0]?.count || 0;
        const pendingCount = pending.rows[0]?.count || 0;
        const totalReserved = completedCount + pendingCount;
        
        return res.status(200).json({
            success: true,
            count: completedCount,
            pending: pendingCount,
            maxSlots: MAX_SLOTS,
            remaining: MAX_SLOTS - totalReserved
        });
    }

    // ============================================================
    // ACTION: assignCard - Assigns a card to a username (before wallet submission)
    // - First 500: stored in pending, eligible for registration
    // - After 500: badge generated but NOT stored (marketing only)
    // ============================================================
    if (action === 'assignCard') {
        const { username } = body;
        
        if (!username || username.length < 2) {
            return res.status(200).json({ error: 'Invalid username' });
        }

        const cleanUsername = username.toLowerCase().replace(/^@/, '');

        // Check if username already has a COMPLETED entry
        const completedCheck = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE LOWER(username) = LOWER(?)',
            args: [cleanUsername]
        });

        if (completedCheck.rows.length > 0) {
            return res.status(200).json({ error: 'This username has already entered' });
        }

        // Check if username already has a PENDING assignment (refresh protection)
        const pendingCheck = await db.execute({
            sql: 'SELECT card_type, card_number, entry_number FROM yellowcard_pending WHERE LOWER(username) = LOWER(?)',
            args: [cleanUsername]
        });

        if (pendingCheck.rows.length > 0) {
            // Return the SAME card they were assigned before
            const pending = pendingCheck.rows[0];
            return res.status(200).json({
                success: true,
                cardType: pending.card_type,
                cardNumber: pending.card_number,
                entryNumber: pending.entry_number,
                eligible: true
            });
        }

        // Check current slot count
        const countResult = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
        const pendingCountResult = await db.execute('SELECT COUNT(*) as count FROM yellowcard_pending');
        const completedCount = countResult.rows[0]?.count || 0;
        const pendingCount = pendingCountResult.rows[0]?.count || 0;
        const totalReserved = completedCount + pendingCount;

        // AFTER 500: Generate badge but don't store (marketing mode)
        if (totalReserved >= MAX_SLOTS) {
            // Random common card only (no Gold/Emperor after 500)
            const randomCardNumber = Math.floor(Math.random() * TOTAL_COMMON_CARDS) + 1;
            
            return res.status(200).json({
                success: true,
                cardType: 'common',
                cardNumber: randomCardNumber,
                entryNumber: 0, // Indicates not eligible
                eligible: false
            });
        }

        // FIRST 500: Normal flow with pending storage
        const maxCompleted = await db.execute('SELECT MAX(entry_number) as max FROM yellowcard_entries');
        const maxPending = await db.execute('SELECT MAX(entry_number) as max FROM yellowcard_pending');
        const nextEntryNumber = Math.max(
            maxCompleted.rows[0]?.max || 0,
            maxPending.rows[0]?.max || 0
        ) + 1;

        // Assign card based on entry number
        const { cardType, cardNumber } = await assignCard(nextEntryNumber);

        // Store in pending table
        await db.execute({
            sql: 'INSERT INTO yellowcard_pending (username, card_type, card_number, entry_number) VALUES (?, ?, ?, ?)',
            args: [cleanUsername, cardType, String(cardNumber), nextEntryNumber]
        });

        return res.status(200).json({
            success: true,
            cardType,
            cardNumber,
            entryNumber: nextEntryNumber,
            eligible: true
        });
    }

    // ============================================================
    // ACTION: submit - Submit wallet and finalize entry
    // - If pending exists: register normally (first 500)
    // - If no pending: marketing mode - return success but don't store
    // ============================================================
    if (action === 'submit') {
        const { username, wallet, cardType: clientCardType, cardNumber: clientCardNumber, quoteLink, quoteTweet, comment, qrtLink, commentLink, discordUsername } = body;
        const qrt = quoteLink || quoteTweet || qrtLink || '';
        const cmt = commentLink || comment || '';
        const discord = discordUsername || '';

        if (!username || username.length < 2) {
            return res.status(200).json({ error: 'Invalid username' });
        }

        const cleanUsername = username.toLowerCase().replace(/^@/, '');

        if (!wallet || wallet.length < 32 || wallet.length > 44) {
            return res.status(200).json({ error: 'Invalid wallet address' });
        }

        // Check if username already completed
        const completedCheck = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE LOWER(username) = LOWER(?)',
            args: [cleanUsername]
        });

        if (completedCheck.rows.length > 0) {
            return res.status(200).json({ error: 'This username has already entered' });
        }

        // Get pending assignment
        const pendingCheck = await db.execute({
            sql: 'SELECT card_type, card_number, entry_number FROM yellowcard_pending WHERE LOWER(username) = LOWER(?)',
            args: [cleanUsername]
        });

        // NO PENDING = Post-500 marketing mode
        // Return success but don't actually store anything
        if (pendingCheck.rows.length === 0) {
            // Fake success for marketing participants
            return res.status(200).json({
                success: true,
                entryNumber: 0, // 0 indicates not actually registered
                eligible: false,
                message: 'Thanks for participating!'
            });
        }

        // HAS PENDING = First 500, register normally
        const pending = pendingCheck.rows[0];
        const cardType = pending.card_type;
        const cardNumber = pending.card_number;
        const entryNumber = pending.entry_number;

        // Check if wallet already used
        const walletCheck = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE wallet = ?',
            args: [wallet]
        });

        if (walletCheck.rows.length > 0) {
            return res.status(200).json({ error: 'This wallet has already been submitted' });
        }

        // Insert entry with card from pending
        await db.execute({
            sql: `INSERT INTO yellowcard_entries (username, wallet, card_type, card_number, entry_number, qrt_link, comment_link, discord_username)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [cleanUsername, wallet, cardType, cardNumber, entryNumber, qrt, cmt, discord]
        });

        // Delete from pending
        await db.execute({
            sql: 'DELETE FROM yellowcard_pending WHERE LOWER(username) = LOWER(?)',
            args: [cleanUsername]
        });

        // Try to award badge_9 if username matches a YellowCatz user
        try {
            const userResult = await db.execute({
                sql: 'SELECT id FROM users WHERE LOWER(x_username) = LOWER(?)',
                args: [cleanUsername]
            });
            
            if (userResult.rows.length > 0) {
                const userId = userResult.rows[0].id;
                // Award badge_9 (ignore if already has it)
                await db.execute({
                    sql: 'INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)',
                    args: [userId, 'badge_9']
                });
            }
        } catch (e) {
            // Badge award is optional — don't fail the submission
            console.log('Badge_9 award skipped:', e.message);
        }

        // Get current count for response
        const countResult = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
        const currentCount = countResult.rows[0]?.count || 0;

        return res.status(200).json({
            success: true,
            entryNumber,
            count: currentCount,
            eligible: true
        });
    }

    // ============================================================
    // ACTION: checkUsername
    // ============================================================
    if (action === 'checkUsername') {
        const { username } = body;
        
        if (!username) {
            return res.status(200).json({ error: 'Username required' });
        }

        const result = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE LOWER(username) = LOWER(?)',
            args: [username]
        });

        return res.status(200).json({
            exists: result.rows.length > 0
        });
    }

    // ============================================================
    // ACTION: checkWallet
    // ============================================================
    if (action === 'checkWallet') {
        const { wallet } = body;
        
        if (!wallet) {
            return res.status(200).json({ error: 'Wallet required' });
        }

        const result = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE wallet = ?',
            args: [wallet]
        });

        return res.status(200).json({
            exists: result.rows.length > 0
        });
    }

    return res.status(400).json({ error: 'Unknown action' });
}