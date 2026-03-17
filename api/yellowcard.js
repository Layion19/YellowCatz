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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowcard_config (
            id INTEGER PRIMARY KEY,
            gold_entry INTEGER NOT NULL,
            emperor_entry INTEGER NOT NULL,
            initial_shuffle TEXT NOT NULL,
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

        // Generate random entry numbers for Gold and Emperor (1-500, different from each other)
        let goldEntry = Math.floor(Math.random() * MAX_SLOTS) + 1;
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
        const result = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
        const count = result.rows[0]?.count || 0;
        
        return res.status(200).json({
            success: true,
            count,
            maxSlots: MAX_SLOTS,
            remaining: MAX_SLOTS - count
        });
    }

    // ============================================================
    // ACTION: assignCard - Assigns a card to a username (before wallet submission)
    // ============================================================
    if (action === 'assignCard') {
        const { username } = body;
        
        if (!username || username.length < 2) {
            return res.status(200).json({ error: 'Invalid username' });
        }

        // Check if username already has an entry
        const usernameCheck = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE LOWER(username) = LOWER(?)',
            args: [username]
        });

        if (usernameCheck.rows.length > 0) {
            return res.status(200).json({ error: 'This username has already entered' });
        }

        // Check max slots
        const countResult = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
        const currentCount = countResult.rows[0]?.count || 0;

        if (currentCount >= MAX_SLOTS) {
            return res.status(200).json({ error: 'All slots have been taken' });
        }

        // Get next entry number
        const maxEntry = await db.execute('SELECT MAX(entry_number) as max FROM yellowcard_entries');
        const nextEntryNumber = (maxEntry.rows[0]?.max || 0) + 1;

        // Assign card based on entry number
        const { cardType, cardNumber } = await assignCard(nextEntryNumber);

        return res.status(200).json({
            success: true,
            cardType,
            cardNumber,
            entryNumber: nextEntryNumber
        });
    }

    // ============================================================
    // ACTION: submit - Submit wallet and finalize entry
    // ============================================================
    if (action === 'submit') {
        const { username, wallet, cardType, cardNumber, quoteLink, quoteTweet, comment, qrtLink, commentLink } = body;
        const qrt = quoteLink || quoteTweet || qrtLink || '';
        const cmt = commentLink || comment || '';

        if (!username || username.length < 2) {
            return res.status(200).json({ error: 'Invalid username' });
        }

        if (!wallet || wallet.length < 32 || wallet.length > 44) {
            return res.status(200).json({ error: 'Invalid wallet address' });
        }

        // Check max slots
        const countResult = await db.execute('SELECT COUNT(*) as count FROM yellowcard_entries');
        const currentCount = countResult.rows[0]?.count || 0;

        if (currentCount >= MAX_SLOTS) {
            return res.status(200).json({ error: 'All slots have been taken' });
        }

        // Check if username already entered
        const usernameCheck = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE LOWER(username) = LOWER(?)',
            args: [username]
        });

        if (usernameCheck.rows.length > 0) {
            return res.status(200).json({ error: 'This username has already entered' });
        }

        // Check if wallet already used
        const walletCheck = await db.execute({
            sql: 'SELECT id FROM yellowcard_entries WHERE wallet = ?',
            args: [wallet]
        });

        if (walletCheck.rows.length > 0) {
            return res.status(200).json({ error: 'This wallet has already been submitted' });
        }

        // Get next entry number
        const maxEntry = await db.execute('SELECT MAX(entry_number) as max FROM yellowcard_entries');
        const entryNumber = (maxEntry.rows[0]?.max || 0) + 1;

        // Insert entry with qrt_link and comment_link
        await db.execute({
            sql: `INSERT INTO yellowcard_entries (username, wallet, card_type, card_number, entry_number, qrt_link, comment_link)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [username.toLowerCase(), wallet, cardType || 'common', String(cardNumber) || '1', entryNumber, qrt, cmt]
        });

        return res.status(200).json({
            success: true,
            entryNumber,
            count: currentCount + 1
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