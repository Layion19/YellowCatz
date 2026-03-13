import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';

export const config = { api: { bodyParser: false } };

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================================
// CONFIG
// ============================================================
const BETTING_WAIT = 12;        // seconds after first bet to start dealing
const TURN_TIMEOUT = 30;        // seconds per player turn
const DONE_DISPLAY = 6;         // seconds to show results
const HEARTBEAT_TIMEOUT = 45;   // seconds before removing inactive player
const NUM_TABLES = 6;
const MAX_SEATS = 7;
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// ============================================================
// DB INIT — runs once per cold start
// ============================================================
let dbReady = false;

async function ensureTables() {
    if (dbReady) return;

    await db.execute(`
        CREATE TABLE IF NOT EXISTS yellowjack_players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            points INTEGER DEFAULT 10000,
            games_played INTEGER DEFAULT 0,
            total_won INTEGER DEFAULT 0,
            total_lost INTEGER DEFAULT 0,
            is_blocked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_played DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS yj_tables (
            id INTEGER PRIMARY KEY,
            phase TEXT DEFAULT 'waiting',
            deck TEXT DEFAULT '[]',
            dealer_hand TEXT DEFAULT '[]',
            active_seat INTEGER DEFAULT -1,
            bet_start_time TEXT,
            turn_start_time TEXT,
            done_time TEXT
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS yj_seats (
            table_id INTEGER NOT NULL,
            seat_index INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            avatar TEXT DEFAULT '',
            bet INTEGER DEFAULT 0,
            chips TEXT DEFAULT '[]',
            hand TEXT DEFAULT '[]',
            status TEXT DEFAULT 'waiting',
            last_seen TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (table_id, seat_index)
        )
    `);

    // Init 6 tables
    for (let i = 1; i <= NUM_TABLES; i++) {
        await db.execute({
            sql: `INSERT OR IGNORE INTO yj_tables (id, phase) VALUES (?, 'waiting')`,
            args: [i]
        });
    }

    dbReady = true;
}

// ============================================================
// AUTH — same as your existing system
// ============================================================
function parseCookies(str) {
    const obj = {};
    if (!str) return obj;
    str.split(';').forEach(p => {
        const [k, ...v] = p.trim().split('=');
        if (k) obj[k] = decodeURIComponent(v.join('='));
    });
    return obj;
}

async function getUser(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies['yellow_session'];
    if (!token) return null;

    try {
        const JWT_SECRET = process.env.JWT_SECRET;
        if (!JWT_SECRET) return null;

        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded || !decoded.userId) return null;

        return {
            id: decoded.userId,
            username: decoded.xUsername || 'Player',
            avatar: decoded.avatarUrl || ''
        };
    } catch (e) {
        return null;
    }
}

// ============================================================
// CARD UTILITIES
// ============================================================
function createDeck(n = 6) {
    const d = [];
    for (let i = 0; i < n; i++)
        for (const s of SUITS)
            for (const r of RANKS)
                d.push({ rank: r, suit: s });
    // Fisher-Yates
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

function draw(deck) {
    if (deck.length < 20) deck.push(...createDeck());
    return deck.pop();
}

function handValue(cards) {
    let t = 0, a = 0;
    for (const c of cards) {
        if (c.rank === 'A') { t += 11; a++; }
        else if (['J', 'Q', 'K'].includes(c.rank)) t += 10;
        else t += parseInt(c.rank);
    }
    while (t > 21 && a > 0) { t -= 10; a--; }
    return t;
}

function isBJ(cards) { return cards.length === 2 && handValue(cards) === 21; }

// ============================================================
// DB HELPERS
// ============================================================
async function getTable(id) {
    const r = await db.execute({ sql: 'SELECT * FROM yj_tables WHERE id = ?', args: [id] });
    if (!r.rows.length) return null;
    const t = r.rows[0];
    return {
        id: t.id,
        phase: t.phase,
        deck: JSON.parse(t.deck || '[]'),
        dealerHand: JSON.parse(t.dealer_hand || '[]'),
        activeSeat: t.active_seat ?? -1,
        betStartTime: t.bet_start_time,
        turnStartTime: t.turn_start_time,
        doneTime: t.done_time
    };
}

async function saveTable(t) {
    await db.execute({
        sql: `UPDATE yj_tables SET phase=?, deck=?, dealer_hand=?, active_seat=?,
              bet_start_time=?, turn_start_time=?, done_time=? WHERE id=?`,
        args: [
            t.phase, JSON.stringify(t.deck), JSON.stringify(t.dealerHand),
            t.activeSeat, t.betStartTime || null, t.turnStartTime || null,
            t.doneTime || null, t.id
        ]
    });
}

async function getSeats(tableId) {
    const r = await db.execute({
        sql: 'SELECT * FROM yj_seats WHERE table_id = ? ORDER BY seat_index',
        args: [tableId]
    });
    return r.rows.map(s => ({
        tableId: s.table_id,
        seatIndex: s.seat_index,
        userId: s.user_id,
        username: s.username,
        avatar: s.avatar || '',
        bet: s.bet || 0,
        chips: JSON.parse(s.chips || '[]'),
        hand: JSON.parse(s.hand || '[]'),
        status: s.status || 'waiting',
        lastSeen: s.last_seen
    }));
}

async function saveSeat(s) {
    await db.execute({
        sql: `INSERT OR REPLACE INTO yj_seats 
              (table_id, seat_index, user_id, username, avatar, bet, chips, hand, status, last_seen)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [
            s.tableId, s.seatIndex, s.userId, s.username, s.avatar || '',
            s.bet || 0, JSON.stringify(s.chips || []),
            JSON.stringify(s.hand || []), s.status || 'waiting'
        ]
    });
}

async function removeSeat(tableId, seatIndex) {
    await db.execute({ sql: 'DELETE FROM yj_seats WHERE table_id=? AND seat_index=?', args: [tableId, seatIndex] });
}

async function removeUserFromAllTables(userId) {
    await db.execute({ sql: 'DELETE FROM yj_seats WHERE user_id=?', args: [userId] });
}

async function getPlayer(userId) {
    const r = await db.execute({ sql: 'SELECT * FROM yellowjack_players WHERE user_id=?', args: [userId] });
    return r.rows[0] || null;
}

async function ensurePlayer(userId) {
    let p = await getPlayer(userId);
    if (!p) {
        await db.execute({ sql: 'INSERT INTO yellowjack_players (user_id, points) VALUES (?, 10000)', args: [userId] });
        p = await getPlayer(userId);
    }
    return p;
}

// ============================================================
// GAME LOGIC — Lazy evaluation on each poll
// ============================================================
async function tickTable(table, seats) {
    const now = Date.now();
    let changed = false;

    // --- Remove stale players (no heartbeat) ---
    for (const s of seats) {
        if (s.lastSeen) {
            const seen = new Date(s.lastSeen + 'Z').getTime();
            if (now - seen > HEARTBEAT_TIMEOUT * 1000) {
                await removeSeat(s.tableId, s.seatIndex);
                changed = true;
                // If it was their turn, we'll need to advance after re-fetching
            }
        }
    }
    if (changed) {
        seats = await getSeats(table.id);
        // If we're in playing phase and active seat was removed, advance
        if (table.phase === 'playing') {
            const activeStillExists = seats.find(s => s.seatIndex === table.activeSeat && s.status === 'playing');
            if (!activeStillExists) {
                await advanceTurn(table, seats);
                return; // advanceTurn handles the rest
            }
        }
        // If no seats left, reset
        if (seats.length === 0) {
            table.phase = 'waiting';
            table.betStartTime = null;
            table.turnStartTime = null;
            table.doneTime = null;
            table.deck = [];
            table.dealerHand = [];
            table.activeSeat = -1;
            await saveTable(table);
            return;
        }
    }

    // --- Phase: waiting (with bet countdown running) ---
    if (table.phase === 'waiting' && table.betStartTime) {
        const elapsed = (now - new Date(table.betStartTime + 'Z').getTime()) / 1000;
        const seatedWithBet = seats.filter(s => s.bet > 0);
        const seatedTotal = seats.length;
        const allBet = seatedTotal > 0 && seatedWithBet.length === seatedTotal;

        if (allBet || elapsed >= BETTING_WAIT) {
            if (seatedWithBet.length > 0) {
                await dealCards(table, seats);
            } else {
                // No one bet → clear timer
                table.betStartTime = null;
                await saveTable(table);
            }
        }
        return;
    }

    // --- Phase: waiting (no countdown) ---
    if (table.phase === 'waiting') {
        return;
    }

    // --- Phase: playing ---
    if (table.phase === 'playing' && table.turnStartTime) {
        const elapsed = (now - new Date(table.turnStartTime + 'Z').getTime()) / 1000;
        if (elapsed >= TURN_TIMEOUT) {
            // Auto-stand
            const seat = seats.find(s => s.seatIndex === table.activeSeat);
            if (seat && seat.status === 'playing') {
                seat.status = 'stand';
                await saveSeat(seat);
            }
            await advanceTurn(table, seats);
        }
        return;
    }

    // --- Phase: dealer ---
    if (table.phase === 'dealer') {
        await playDealer(table, seats);
        return;
    }

    // --- Phase: done ---
    if (table.phase === 'done' && table.doneTime) {
        const elapsed = (now - new Date(table.doneTime + 'Z').getTime()) / 1000;
        if (elapsed >= DONE_DISPLAY) {
            await resetForNewRound(table);
        }
        return;
    }
}

async function dealCards(table, seats) {
    let deck = createDeck();

    // Deal 2 cards to each betting player
    const bettors = seats.filter(s => s.bet > 0);
    for (const s of bettors) {
        s.hand = [draw(deck), draw(deck)];
        s.status = isBJ(s.hand) ? 'blackjack' : 'playing';
        await saveSeat(s);
    }

    // Non-bettors just sit idle
    for (const s of seats) {
        if (s.bet === 0) {
            s.status = 'idle';
            await saveSeat(s);
        }
    }

    // Dealer gets 2 cards
    const dealerHand = [draw(deck), draw(deck)];

    // Find first active player
    const firstActive = bettors
        .filter(s => s.status === 'playing')
        .sort((a, b) => a.seatIndex - b.seatIndex)[0];

    table.deck = deck;
    table.dealerHand = dealerHand;
    table.phase = firstActive ? 'playing' : 'dealer';
    table.activeSeat = firstActive ? firstActive.seatIndex : -1;
    table.turnStartTime = new Date().toISOString();
    table.betStartTime = null;
    await saveTable(table);

    // If all players have blackjack, go straight to dealer
    if (!firstActive) {
        const updatedSeats = await getSeats(table.id);
        await playDealer(table, updatedSeats);
    }
}

async function advanceTurn(table, seats) {
    // Find next player who needs to act
    const active = seats
        .filter(s => s.bet > 0 && s.status === 'playing' && s.seatIndex > table.activeSeat)
        .sort((a, b) => a.seatIndex - b.seatIndex);

    if (active.length > 0) {
        table.activeSeat = active[0].seatIndex;
        table.turnStartTime = new Date().toISOString();
        await saveTable(table);
    } else {
        // All players done → dealer
        table.phase = 'dealer';
        table.activeSeat = -1;
        table.turnStartTime = null;
        await saveTable(table);
        const updatedSeats = await getSeats(table.id);
        await playDealer(table, updatedSeats);
    }
}

async function playDealer(table, seats) {
    const bettors = seats.filter(s => s.bet > 0);
    const nonBusted = bettors.filter(s => s.status !== 'bust');

    let deck = table.deck.length > 10 ? table.deck : createDeck();

    // Dealer draws to 17 if anyone didn't bust
    if (nonBusted.length > 0 && !nonBusted.every(s => s.status === 'blackjack' || s.status === 'bust')) {
        while (handValue(table.dealerHand) < 17) {
            table.dealerHand.push(draw(deck));
        }
    }

    table.deck = deck;
    const dealerVal = handValue(table.dealerHand);
    const dealerBust = dealerVal > 21;
    const dealerBJ = isBJ(table.dealerHand);

    // Resolve each player
    for (const s of bettors) {
        const pVal = handValue(s.hand);
        const pBJ = isBJ(s.hand);
        let payout = 0;
        let result = '';

        if (s.status === 'bust' || pVal > 21) {
            result = 'lose';
            payout = 0; // already deducted on bet
        } else if (pBJ && dealerBJ) {
            result = 'push';
            payout = s.bet; // return bet
        } else if (pBJ) {
            result = 'blackjack';
            payout = s.bet + Math.floor(s.bet * 1.5); // bet + 1.5x
        } else if (dealerBJ) {
            result = 'lose';
            payout = 0;
        } else if (dealerBust) {
            result = 'win';
            payout = s.bet * 2; // bet + winnings
        } else if (pVal > dealerVal) {
            result = 'win';
            payout = s.bet * 2;
        } else if (pVal < dealerVal) {
            result = 'lose';
            payout = 0;
        } else {
            result = 'push';
            payout = s.bet; // return bet
        }

        s.status = result;
        await saveSeat(s);

        // Update player points (points were deducted when bet was placed)
        // Now add back the payout
        if (payout > 0) {
            await db.execute({
                sql: 'UPDATE yellowjack_players SET points = points + ?, last_played = datetime("now") WHERE user_id = ?',
                args: [payout, s.userId]
            });
        }

        // Stats
        const won = payout > s.bet ? payout - s.bet : 0;
        const lost = payout === 0 ? s.bet : 0;
        await db.execute({
            sql: `UPDATE yellowjack_players SET 
                  games_played = games_played + 1,
                  total_won = total_won + ?,
                  total_lost = total_lost + ?,
                  last_played = datetime("now")
                  WHERE user_id = ?`,
            args: [won, lost, s.userId]
        });
    }

    table.phase = 'done';
    table.doneTime = new Date().toISOString();
    table.activeSeat = -1;
    await saveTable(table);
}

async function resetForNewRound(table) {
    const seats = await getSeats(table.id);

    // Reset all seats for new round
    for (const s of seats) {
        s.bet = 0;
        s.chips = [];
        s.hand = [];
        s.status = 'waiting';
        await saveSeat(s);
    }

    table.phase = seats.length > 0 ? 'waiting' : 'waiting';
    table.deck = [];
    table.dealerHand = [];
    table.activeSeat = -1;
    table.betStartTime = null;
    table.turnStartTime = null;
    table.doneTime = null;
    await saveTable(table);
}

// ============================================================
// RESPONSE BUILDERS
// ============================================================
function buildTableResponse(table, seats, myUserId) {
    // Build dealer hand for client (hide 2nd card during play)
    let clientDealerHand = [];
    if (table.dealerHand.length > 0) {
        if (table.phase === 'playing') {
            clientDealerHand = [table.dealerHand[0], { rank: '?', suit: '?' }];
        } else {
            clientDealerHand = table.dealerHand;
        }
    }

    return {
        tableId: table.id,
        myUserId,
        phase: table.phase,
        activeSeat: table.activeSeat,
        turnStartTime: table.turnStartTime,
        dealerHand: clientDealerHand,
        seats: seats.map(s => ({
            seatIndex: s.seatIndex,
            userId: s.userId,
            username: s.username,
            avatar: s.avatar,
            bet: s.bet,
            chips: s.chips,
            hand: s.hand,
            status: s.status
        }))
    };
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    await ensureTables();

    // Parse body — robust: handles both Vercel auto-parsed and raw stream
    let body = {};
    try {
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            // Vercel already parsed it (bodyParser was on or default)
            body = req.body;
        } else {
            // Manual parsing (bodyParser: false)
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw) body = JSON.parse(raw);
        }
    } catch (e) {
        console.error('Body parse error:', e);
    }

    const { action } = body;

    if (!action) {
        return res.status(400).json({ error: 'Missing action', debug: { hasBody: !!req.body, bodyKeys: Object.keys(body) } });
    }

    // Auth
    const user = await getUser(req);
    if (!user) {
        return res.status(200).json({ success: false, error: 'Not authenticated' });
    }

    try {
        // ==================================================
        // getPlayer
        // ==================================================
        if (action === 'getPlayer') {
            const p = await ensurePlayer(user.id);
            if (p.is_blocked) return res.json({ blocked: true });
            return res.json({
                success: true,
                player: {
                    points: p.points,
                    games_played: p.games_played,
                    total_won: p.total_won,
                    total_lost: p.total_lost
                }
            });
        }

        // ==================================================
        // getTables — lobby overview
        // ==================================================
        if (action === 'getTables') {
            const tables = [];
            for (let i = 1; i <= NUM_TABLES; i++) {
                const seats = await getSeats(i);
                const t = await getTable(i);
                tables.push({
                    id: i,
                    phase: t?.phase || 'waiting',
                    players: seats.map(s => ({
                        seat: s.seatIndex,
                        name: s.username,
                        avatar: s.avatar
                    }))
                });
            }
            return res.json({ success: true, tables });
        }

        // ==================================================
        // getTable — full state for rendering (called every 1s)
        // ==================================================
        if (action === 'getTable') {
            const { tableId } = body;
            let table = await getTable(tableId);
            if (!table) return res.json({ error: 'Table not found' });

            let seats = await getSeats(tableId);

            // Tick game logic (lazy evaluation)
            await tickTable(table, seats);

            // Re-fetch after potential changes
            table = await getTable(tableId);
            seats = await getSeats(tableId);

            return res.json(buildTableResponse(table, seats, user.id));
        }

        // ==================================================
        // joinTable — sit at a seat
        // ==================================================
        if (action === 'joinTable') {
            const { tableId, seatIndex } = body;
            if (seatIndex < 0 || seatIndex >= MAX_SEATS) return res.json({ error: 'Invalid seat' });

            const table = await getTable(tableId);
            if (!table) return res.json({ error: 'Table not found' });

            // Can't join during active play
            if (table.phase === 'playing' || table.phase === 'dealer') {
                return res.json({ error: 'Round in progress, wait a moment' });
            }

            // Check seat not taken
            const seats = await getSeats(tableId);
            if (seats.find(s => s.seatIndex === seatIndex)) {
                return res.json({ error: 'Seat taken' });
            }

            // Check not blocked
            const p = await ensurePlayer(user.id);
            if (p.is_blocked) return res.json({ error: 'You are blocked' });

            // Check has points
            if (p.points <= 0) return res.json({ error: 'No points. Ask admin for refill!' });

            // Remove from other tables
            await removeUserFromAllTables(user.id);

            // Sit down
            await saveSeat({
                tableId, seatIndex,
                userId: user.id,
                username: user.username,
                avatar: user.avatar,
                bet: 0, chips: [], hand: [],
                status: 'waiting'
            });

            return res.json({ success: true, points: p.points });
        }

        // ==================================================
        // leaveTable
        // ==================================================
        if (action === 'leaveTable') {
            const { tableId } = body;

            // Find my seat (search given table, or all tables)
            let mySeat = null;
            let searchTables = tableId ? [tableId] : [1, 2, 3, 4, 5, 6];
            
            for (const tid of searchTables) {
                const seats = await getSeats(tid);
                const found = seats.find(s => s.userId === user.id);
                if (found) { mySeat = found; break; }
            }

            if (mySeat) {
                const table = await getTable(mySeat.tableId);

                // If in active round with bet and still playing, forfeit
                if (table && table.phase === 'playing' && mySeat.status === 'playing' && mySeat.bet > 0) {
                    // Points already deducted at bet time, no extra penalty
                }

                await removeSeat(mySeat.tableId, mySeat.seatIndex);

                // If it was my turn, advance
                if (table && table.phase === 'playing' && table.activeSeat === mySeat.seatIndex) {
                    const remaining = await getSeats(table.id);
                    await advanceTurn(table, remaining);
                }

                // If table empty, reset
                const remaining = await getSeats(mySeat.tableId);
                if (remaining.length === 0 && table) {
                    table.phase = 'waiting';
                    table.deck = [];
                    table.dealerHand = [];
                    table.activeSeat = -1;
                    table.betStartTime = null;
                    table.turnStartTime = null;
                    table.doneTime = null;
                    await saveTable(table);
                }
            } else {
                await removeUserFromAllTables(user.id);
            }

            return res.json({ success: true });
        }

        // ==================================================
        // placeBet
        // ==================================================
        if (action === 'placeBet') {
            const { tableId, bet, chips } = body;

            const table = await getTable(tableId);
            if (!table) return res.json({ error: 'Table not found' });

            if (table.phase !== 'waiting') {
                return res.json({ error: 'Cannot bet now' });
            }

            const seats = await getSeats(tableId);
            const mySeat = seats.find(s => s.userId === user.id);
            if (!mySeat) return res.json({ error: 'Not seated' });
            if (mySeat.bet > 0) return res.json({ error: 'Already bet' });

            const p = await getPlayer(user.id);
            if (!p || p.points < bet) return res.json({ error: 'Not enough points' });
            if (bet <= 0) return res.json({ error: 'Invalid bet' });

            // Deduct points immediately
            await db.execute({
                sql: 'UPDATE yellowjack_players SET points = points - ?, last_played = datetime("now") WHERE user_id = ?',
                args: [bet, user.id]
            });

            // Save bet
            mySeat.bet = bet;
            mySeat.chips = chips || [];
            mySeat.status = 'ready';
            await saveSeat(mySeat);

            // If no countdown running yet, start it
            if (!table.betStartTime) {
                table.betStartTime = new Date().toISOString();
                await saveTable(table);
            }

            // Check if all seated players have bet → quick start
            const updatedSeats = await getSeats(tableId);
            const allBet = updatedSeats.every(s => s.bet > 0);
            if (allBet && updatedSeats.length > 0) {
                await dealCards(table, updatedSeats);
            }

            return res.json({ success: true });
        }

        // ==================================================
        // playerAction — hit / stand / double / split
        // ==================================================
        if (action === 'playerAction') {
            const { tableId, actionType } = body;

            const table = await getTable(tableId);
            if (!table || table.phase !== 'playing') return res.json({ error: 'Not in play' });

            const seats = await getSeats(tableId);
            const mySeat = seats.find(s => s.userId === user.id);
            if (!mySeat || mySeat.seatIndex !== table.activeSeat) {
                return res.json({ error: 'Not your turn' });
            }
            if (mySeat.status !== 'playing') return res.json({ error: 'Already done' });

            let deck = table.deck.length > 10 ? table.deck : createDeck();

            // --- HIT ---
            if (actionType === 'hit') {
                mySeat.hand.push(draw(deck));
                const val = handValue(mySeat.hand);

                if (val > 21) {
                    mySeat.status = 'bust';
                } else if (val === 21) {
                    mySeat.status = 'stand';
                }

                table.deck = deck;
                await saveSeat(mySeat);
                await saveTable(table);

                if (mySeat.status !== 'playing') {
                    await advanceTurn(table, seats);
                } else {
                    // Reset turn timer
                    table.turnStartTime = new Date().toISOString();
                    await saveTable(table);
                }

                return res.json({ success: true });
            }

            // --- STAND ---
            if (actionType === 'stand') {
                mySeat.status = 'stand';
                await saveSeat(mySeat);
                await advanceTurn(table, seats);
                return res.json({ success: true });
            }

            // --- DOUBLE ---
            if (actionType === 'double') {
                if (mySeat.hand.length !== 2) return res.json({ error: 'Can only double on 2 cards' });

                const p = await getPlayer(user.id);
                if (!p || p.points < mySeat.bet) return res.json({ error: 'Not enough points' });

                // Deduct extra bet
                await db.execute({
                    sql: 'UPDATE yellowjack_players SET points = points - ? WHERE user_id = ?',
                    args: [mySeat.bet, user.id]
                });

                mySeat.bet *= 2;
                mySeat.hand.push(draw(deck));
                const val = handValue(mySeat.hand);
                mySeat.status = val > 21 ? 'bust' : 'stand';

                table.deck = deck;
                await saveSeat(mySeat);
                await saveTable(table);
                await advanceTurn(table, seats);

                return res.json({ success: true });
            }

            // --- SPLIT ---
            if (actionType === 'split') {
                // Simplified: for now, don't support split to keep it clean
                // Can be added later
                return res.json({ error: 'Split not yet available' });
            }

            return res.json({ error: 'Unknown action type' });
        }

        // ==================================================
        // heartbeat — keep seat alive
        // ==================================================
        if (action === 'heartbeat') {
            const { tableId } = body;
            await db.execute({
                sql: `UPDATE yj_seats SET last_seen = datetime('now') WHERE table_id = ? AND user_id = ?`,
                args: [tableId, user.id]
            });
            return res.json({ ok: true });
        }

        return res.status(400).json({ error: 'Unknown action' });

    } catch (err) {
        console.error('YellowJack API error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
}