import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================================
// CONFIG
// ============================================================
const BETTING_WAIT = 10;        // seconds after first bet to start dealing
const TURN_TIMEOUT = 30;        // seconds per player turn
const DONE_DISPLAY = 4;         // seconds to show results
const HEARTBEAT_TIMEOUT = 45;   // seconds before removing inactive player
const NUM_TABLES = 6;
const MAX_SEATS = 7;
const MAX_BET_PER_ROUND = 10000; // Max total bet per player per round
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// ============================================================
// DB INIT — runs once per cold start
// ============================================================
let dbReady = false;

async function saveSeasonWinners(seasonNum) {
    try {
        // Circular system: keep only 3 seasons (1, 2, 3)
        // Season 4 overwrites season 1, season 5 overwrites season 2, etc.
        const slot = ((seasonNum - 1) % 3) + 1; // Maps to 1, 2, or 3
        
        // Delete old entries for this slot
        await db.execute({
            sql: `DELETE FROM yj_season_winners WHERE season_num = ?`,
            args: [slot]
        });
        
        const top3 = await db.execute(`
            SELECT yj.user_id, yj.points, yj.games_played, yj.total_won, yj.total_lost,
                   COALESCE(u.x_username, 'Player') as x_username, 
                   COALESCE(u.avatar_url, '') as avatar_url
            FROM yellowjack_players yj
            LEFT JOIN users u ON yj.user_id = u.id
            WHERE yj.user_id > 0 AND yj.user_id < 900000 AND yj.is_blocked = 0
              AND (yj.total_won > 0 OR yj.total_lost > 0 OR yj.games_played > 0)
            ORDER BY yj.points DESC
            LIMIT 3
        `);
        
        if (top3.rows.length === 0) {
            console.log('No players to save for season', seasonNum);
            return;
        }
        
        const now = new Date().toISOString();
        for (let i = 0; i < top3.rows.length; i++) {
            const p = top3.rows[i];
            await db.execute({
                sql: `INSERT INTO yj_season_winners (season_num, rank, user_id, username, avatar_url, points, volume, games_played, ended_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [slot, i + 1, p.user_id, p.x_username || 'Unknown', p.avatar_url || '', p.points || 0, (p.total_won || 0) + (p.total_lost || 0), p.games_played || 0, now]
            });
        }
        console.log('Saved season', seasonNum, 'winners to slot', slot);
    } catch (e) {
        console.error('saveSeasonWinners error:', e);
    }
}

async function getPastWinners() {
    try {
        const result = await db.execute(`
            SELECT season_num, rank, username, avatar_url, points, volume, games_played, ended_at
            FROM yj_season_winners
            ORDER BY season_num DESC, rank ASC
        `);
        
        // Group by season
        const seasons = {};
        for (const row of result.rows) {
            const sn = row.season_num;
            if (!seasons[sn]) {
                seasons[sn] = {
                    seasonNum: sn,
                    endedAt: row.ended_at,
                    winners: []
                };
            }
            seasons[sn].winners.push({
                rank: row.rank,
                username: row.username,
                avatarUrl: row.avatar_url || '',
                points: row.points || 0,
                volume: row.volume || 0,
                gamesPlayed: row.games_played || 0
            });
        }
        
        // Return as array sorted by season (most recent first based on ended_at)
        return Object.values(seasons).sort((a, b) => {
            const dateA = new Date(a.endedAt).getTime();
            const dateB = new Date(b.endedAt).getTime();
            return dateB - dateA;
        });
    } catch (e) {
        console.error('getPastWinners error:', e);
        return [];
    }
}

async function ensureTables() {
    if (dbReady) return;

    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS yellowjack_players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                points INTEGER DEFAULT 20000,
                games_played INTEGER DEFAULT 0,
                total_won INTEGER DEFAULT 0,
                total_lost INTEGER DEFAULT 0,
                is_blocked INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_played DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS yj_season (
                id INTEGER PRIMARY KEY DEFAULT 1,
                start_time TEXT NOT NULL,
                duration_days INTEGER DEFAULT 7,
                version INTEGER DEFAULT 0
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS yj_season_winners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                season_num INTEGER NOT NULL,
                rank INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                avatar_url TEXT DEFAULT '',
                points INTEGER DEFAULT 0,
                volume INTEGER DEFAULT 0,
                games_played INTEGER DEFAULT 0,
                ended_at TEXT NOT NULL
            )
        `);

        try { await db.execute("ALTER TABLE yj_season ADD COLUMN version INTEGER DEFAULT 0"); } catch(e) {}
        try { await db.execute("ALTER TABLE yj_season ADD COLUMN season_num INTEGER DEFAULT 1"); } catch(e) {}

        // Season version — increment this to force a reset on next deploy
        const SEASON_VERSION = 1;
        
        const seasonCheck = await db.execute("SELECT * FROM yj_season WHERE id = 1");
        if (seasonCheck.rows.length === 0) {
            await db.execute({ sql: "INSERT INTO yj_season (id, start_time, duration_days, version, season_num) VALUES (1, ?, 7, ?, 1)", args: [new Date().toISOString(), SEASON_VERSION] });
            await db.execute("UPDATE yellowjack_players SET points = 20000, games_played = 0, total_won = 0, total_lost = 0");
        } else if ((seasonCheck.rows[0].version || 0) < SEASON_VERSION) {
            await saveSeasonWinners(seasonCheck.rows[0].season_num || 1);
            const nextSeason = (seasonCheck.rows[0].season_num || 1) + 1;
            await db.execute({ sql: "UPDATE yj_season SET start_time = ?, version = ?, season_num = ? WHERE id = 1", args: [new Date().toISOString(), SEASON_VERSION, nextSeason] });
            await db.execute("UPDATE yellowjack_players SET points = 20000, games_played = 0, total_won = 0, total_lost = 0");
        }

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
                hand2 TEXT DEFAULT '[]',
                status TEXT DEFAULT 'waiting',
                status2 TEXT DEFAULT '',
                split_phase INTEGER DEFAULT 0,
                last_seen TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (table_id, seat_index)
            )
        `);

        // Migration: add split columns if missing
        try { await db.execute("ALTER TABLE yj_seats ADD COLUMN hand2 TEXT DEFAULT '[]'"); } catch(e) {}
        try { await db.execute("ALTER TABLE yj_seats ADD COLUMN status2 TEXT DEFAULT ''"); } catch(e) {}
        try { await db.execute("ALTER TABLE yj_seats ADD COLUMN split_phase INTEGER DEFAULT 0"); } catch(e) {}

        await db.execute(`
            CREATE TABLE IF NOT EXISTS yj_chat (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                table_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
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
    } catch (err) {
        console.error('ensureTables error:', err);
        throw err;
    }
}

// ============================================================
// AUTH — X login + Guest (no DB for guests)
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

const GUEST_PFPS = [
    'images/YellowCatz1.png', 'images/YellowCatz2.png', 'images/YellowCatz3.png',
    'images/YellowCatz4.png', 'images/YellowCatz5.png', 'images/YellowCatz6.png',
    'images/YellowCatz7.png', 'images/YellowCatz8.png', 'images/YellowCatz9.png',
    'images/YellowCatz10.png', 'images/YellowCatz11.png', 'images/YellowCatz12.png'
];

async function getUser(req, body) {
    // 1. Try JWT auth (X login)
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies['yellow_session'];
    if (token) {
        try {
            const JWT_SECRET = process.env.JWT_SECRET;
            if (JWT_SECRET) {
                const decoded = jwt.verify(token, JWT_SECRET);
                if (decoded && decoded.userId) {
                    return { id: decoded.userId, username: decoded.xUsername || 'Player', avatar: decoded.avatarUrl || '', isGuest: false };
                }
            }
        } catch (e) {
            console.log('JWT verify failed:', e.message);
        }
    }

    // 2. Guest — no DB, just use the info from the body
    if (body?.guestName && body?.guestToken) {
        // Use a stable numeric ID from the token hash
        let hash = 0;
        for (let i = 0; i < body.guestToken.length; i++) { hash = ((hash << 5) - hash) + body.guestToken.charCodeAt(i); hash |= 0; }
        const guestId = 900000 + Math.abs(hash % 100000);
        return { id: guestId, username: body.guestName, avatar: body.guestAvatar || '', isGuest: true };
    }

    return null;
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
    if (!id) return null;
    try {
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
    } catch (err) {
        console.error('getTable error:', err);
        return null;
    }
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
    if (!tableId) return [];
    try {
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
            hand2: JSON.parse(s.hand2 || '[]'),
            status: s.status || 'waiting',
            status2: s.status2 || '',
            splitPhase: s.split_phase || 0,
            lastSeen: s.last_seen
        }));
    } catch (err) {
        console.error('getSeats error:', err);
        return [];
    }
}

async function saveSeat(s) {
    await db.execute({
        sql: `INSERT OR REPLACE INTO yj_seats 
              (table_id, seat_index, user_id, username, avatar, bet, chips, hand, hand2, status, status2, split_phase, last_seen)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [
            s.tableId, s.seatIndex, s.userId, s.username, s.avatar || '',
            s.bet || 0, JSON.stringify(s.chips || []),
            JSON.stringify(s.hand || []), JSON.stringify(s.hand2 || []),
            s.status || 'waiting', s.status2 || '', s.splitPhase || 0
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
    if (userId >= 900000) {
        // Guest — always 20k, no DB
        return { user_id: userId, points: 20000, games_played: 0, total_won: 0, total_lost: 0, is_blocked: 0 };
    }
    try {
        const r = await db.execute({ sql: 'SELECT * FROM yellowjack_players WHERE user_id=?', args: [userId] });
        return r.rows[0] || null;
    } catch (err) {
        console.error('getPlayer error:', err);
        return null;
    }
}

async function ensurePlayer(userId) {
    if (userId >= 900000) return getPlayer(userId);
    let p = await getPlayer(userId);
    if (!p) {
        await db.execute({ sql: 'INSERT INTO yellowjack_players (user_id, points) VALUES (?, 20000)', args: [userId] });
        p = await getPlayer(userId);
    }
    return p;
}

// Update points — skip for guests
async function updatePlayerPoints(userId, delta) {
    if (userId >= 900000) return; // guest — no tracking
    await db.execute({ sql: 'UPDATE yellowjack_players SET points = points + ?, last_played = datetime("now") WHERE user_id = ?', args: [delta, userId] });
}

// Update stats — skip for guests
async function updatePlayerStats(userId, won, lost) {
    if (userId >= 900000) return; // guest — no tracking
    await db.execute({
        sql: 'UPDATE yellowjack_players SET games_played = games_played + 1, total_won = total_won + ?, total_lost = total_lost + ?, last_played = datetime("now") WHERE user_id = ?',
        args: [won, lost, userId]
    });
}

// ============================================================
// GAME LOGIC — Lazy evaluation on each poll
// ============================================================

// Parse time string — handles both ISO (has Z) and SQLite datetime (no Z)
function parseTime(str) {
    if (!str) return 0;
    // If it already ends with Z, don't add another
    if (str.endsWith('Z')) return new Date(str).getTime();
    // SQLite datetime format: "2026-03-13 19:00:00"
    return new Date(str + 'Z').getTime();
}

async function tickTable(table, seats) {
    const now = Date.now();
    let changed = false;

    // --- Remove stale players (no heartbeat) ---
    for (const s of seats) {
        if (s.lastSeen) {
            const seen = parseTime(s.lastSeen);
            if (seen > 0 && now - seen > HEARTBEAT_TIMEOUT * 1000) {
                await removeSeat(s.tableId, s.seatIndex);
                changed = true;
            }
        }
    }
    if (changed) {
        seats = await getSeats(table.id);
        if (table.phase === 'playing') {
            const activeStillExists = seats.find(s => s.seatIndex === table.activeSeat && s.status === 'playing');
            if (!activeStillExists) {
                await advanceTurn(table, seats);
                return;
            }
        }
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
        const elapsed = (now - parseTime(table.betStartTime)) / 1000;
        const seatedWithBet = seats.filter(s => s.bet > 0);
        const seatedTotal = seats.length;
        const allBet = seatedTotal > 0 && seatedWithBet.length === seatedTotal;

        if (allBet || elapsed >= BETTING_WAIT) {
            if (seatedWithBet.length > 0) {
                await dealCards(table, seats);
            } else {
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
        const elapsed = (now - parseTime(table.turnStartTime)) / 1000;
        if (elapsed >= TURN_TIMEOUT) {
            const seat = seats.find(s => s.seatIndex === table.activeSeat);
            if (seat) {
                const sp = seat.splitPhase || 0;
                if (sp === 1) {
                    // Auto-stand right hand → move to left
                    seat.status2 = 'stand';
                    seat.splitPhase = 2;
                    seat.status = 'playing';
                    table.turnStartTime = new Date().toISOString();
                    await saveSeat(seat); await saveTable(table);
                } else if (sp === 2) {
                    // Auto-stand left hand → advance
                    seat.status = 'stand';
                    await saveSeat(seat);
                    await advanceTurn(table, seats);
                } else if (seat.status === 'playing') {
                    seat.status = 'stand';
                    await saveSeat(seat);
                    await advanceTurn(table, seats);
                }
            } else {
                await advanceTurn(table, seats);
            }
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
        const elapsed = (now - parseTime(table.doneTime)) / 1000;
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
        s.hand2 = [];
        s.status2 = '';
        s.splitPhase = 0;
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

    // Find first active player — rightmost seat starts first
    const firstActive = bettors
        .filter(s => s.status === 'playing')
        .sort((a, b) => b.seatIndex - a.seatIndex)[0];

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
    // A seat still needs to play if:
    // - status === 'playing' (normal or hand1 of split)
    // - OR splitPhase === 2 and status2 === 'playing' (hand2 of split)
    function needsPlay(s) {
        const sp = s.splitPhase || 0;
        if (sp === 1) return s.status2 === 'playing'; // right hand active
        if (sp === 2) return s.status === 'playing';  // left hand active
        return s.status === 'playing';
    }

    // Find next player — right to left (descending seat index)
    const active = seats
        .filter(s => s.bet > 0 && needsPlay(s) && s.seatIndex < table.activeSeat)
        .sort((a, b) => b.seatIndex - a.seatIndex);

    if (active.length > 0) {
        table.activeSeat = active[0].seatIndex;
        table.turnStartTime = new Date().toISOString();
        await saveTable(table);
    } else {
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

    // Resolve each player (skip only final result statuses)
    for (const s of bettors) {
        if (['win','lose','push'].includes(s.status)) continue; // already resolved
        let totalPayout = 0;
        let totalWon = 0, totalLost = 0;

        // Helper: resolve one hand against dealer
        function resolveHand(hand, status) {
            const pVal = handValue(hand);
            const pBJ = isBJ(hand);
            let payout = 0, result = '';

            if (status === 'bust' || pVal > 21) {
                result = 'lose'; payout = 0;
            } else if (pBJ && dealerBJ) {
                result = 'push'; payout = s.bet;
            } else if (pBJ) {
                result = 'blackjack'; payout = s.bet + Math.floor(s.bet * 1.5);
            } else if (dealerBJ) {
                result = 'lose'; payout = 0;
            } else if (dealerBust) {
                result = 'win'; payout = s.bet * 2;
            } else if (pVal > dealerVal) {
                result = 'win'; payout = s.bet * 2;
            } else if (pVal < dealerVal) {
                result = 'lose'; payout = 0;
            } else {
                result = 'push'; payout = s.bet;
            }
            return { result, payout };
        }

        // Hand 1
        const r1 = resolveHand(s.hand, s.status);
        s.status = r1.result;
        totalPayout += r1.payout;

        // Hand 2 (if split)
        if (s.splitPhase > 0 && s.hand2 && s.hand2.length > 0) {
            const r2 = resolveHand(s.hand2, s.status2);
            s.status2 = r2.result;
            totalPayout += r2.payout;
        }

        await saveSeat(s);

        if (totalPayout > 0) {
            await updatePlayerPoints(s.userId, totalPayout);
        }

        const invested = s.splitPhase > 0 ? s.bet * 2 : s.bet;
        totalWon = totalPayout > invested ? totalPayout - invested : 0;
        totalLost = totalPayout < invested ? invested - totalPayout : 0;
        await updatePlayerStats(s.userId, totalWon, totalLost);
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
        s.hand2 = [];
        s.status = 'waiting';
        s.status2 = '';
        s.splitPhase = 0;
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
        betStartTime: table.betStartTime,
        dealerHand: clientDealerHand,
        seats: seats.map(s => ({
            seatIndex: s.seatIndex,
            userId: s.userId,
            username: s.username,
            avatar: s.avatar,
            bet: s.bet,
            chips: s.chips,
            hand: s.hand,
            hand2: s.hand2 || [],
            status: s.status,
            status2: s.status2 || '',
            splitPhase: s.splitPhase || 0
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

    // Parse body — robust handling for both Vercel parsed and raw stream
    let body = {};
    try {
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            body = req.body;
        } else if (typeof req.body === 'string' && req.body.length > 0) {
            body = JSON.parse(req.body);
        } else {
            // Manual parsing for streaming body
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw) body = JSON.parse(raw);
        }
    } catch (e) {
        console.error('Body parse error:', e.message);
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { action } = body;

    if (!action) {
        return res.status(400).json({ error: 'Missing action' });
    }

    // Init DB tables
    try {
        await ensureTables();
    } catch (err) {
        console.error('DB init failed:', err);
        return res.status(500).json({ error: 'Database initialization failed' });
    }

    // --- Season info (no auth needed) ---
    if (action === 'getSeason') {
        try {
            const s = await db.execute("SELECT * FROM yj_season WHERE id = 1");
            if (s.rows.length > 0) {
                const row = s.rows[0];
                const startTime = row.start_time;
                const durationDays = row.duration_days || 7;
                const endMs = new Date(startTime.endsWith('Z') ? startTime : startTime + 'Z').getTime() + durationDays * 86400000;
                const now = Date.now();
                
                if (now >= endMs) {
                    const currentSeason = row.season_num || 1;
                    await saveSeasonWinners(currentSeason);
                    const nextSeason = currentSeason + 1;
                    await db.execute("UPDATE yellowjack_players SET points = 20000, games_played = 0, total_won = 0, total_lost = 0");
                    await db.execute({ sql: "UPDATE yj_season SET start_time = ?, season_num = ? WHERE id = 1", args: [new Date().toISOString(), nextSeason] });
                    return res.json({ seasonEnd: new Date(Date.now() + durationDays * 86400000).toISOString(), justReset: true });
                }
                
                return res.json({ seasonEnd: new Date(endMs).toISOString() });
            }
            return res.json({ seasonEnd: null });
        } catch (err) {
            console.error('getSeason error:', err);
            return res.json({ seasonEnd: null });
        }
    }

    // Auth (X login or guest)
    const user = await getUser(req, body);
    if (!user) {
        return res.status(200).json({ success: false, error: 'Not authenticated' });
    }

    try {
        // ==================================================
        // getPlayer
        // ==================================================
        if (action === 'getPlayer') {
            const p = await ensurePlayer(user.id);
            if (p && p.is_blocked) return res.json({ blocked: true });
            return res.json({
                success: true,
                player: {
                    points: p?.points || 20000,
                    games_played: p?.games_played || 0,
                    total_won: p?.total_won || 0,
                    total_lost: p?.total_lost || 0
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
            
            if (!tableId) {
                return res.json({ error: 'Missing tableId' });
            }
            
            let table = await getTable(tableId);
            if (!table) {
                // Try to create the table if it doesn't exist
                await db.execute({
                    sql: `INSERT OR IGNORE INTO yj_tables (id, phase) VALUES (?, 'waiting')`,
                    args: [tableId]
                });
                table = await getTable(tableId);
                if (!table) {
                    return res.json({ error: 'Table not found' });
                }
            }

            let seats = await getSeats(tableId);

            // Tick game logic (lazy evaluation)
            await tickTable(table, seats);

            // Re-fetch after potential changes
            table = await getTable(tableId);
            seats = await getSeats(tableId);

            // Get recent chat for this table (last 20 messages)
            let chat = [];
            try {
                const chatResult = await db.execute({
                    sql: `SELECT user_id, username, message, created_at FROM yj_chat 
                          WHERE table_id = ? ORDER BY id DESC LIMIT 20`,
                    args: [tableId]
                });
                chat = chatResult.rows.reverse().map(r => ({
                    userId: r.user_id,
                    username: r.username,
                    message: r.message,
                    createdAt: r.created_at
                }));
            } catch (err) {
                console.error('Chat fetch error:', err);
            }

            const resp = buildTableResponse(table, seats, user.id);
            resp.chat = chat;
            return res.json(resp);
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
            if (p && p.is_blocked) return res.json({ error: 'You are blocked' });

            // Check has points
            if (!p || p.points <= 0) return res.json({ error: 'No points. Ask admin for refill!' });

            // Max 2 seats per player on the same table
            const mySeatsHere = seats.filter(s => s.userId === user.id);
            if (mySeatsHere.length >= 2) {
                return res.json({ error: 'Max 2 seats per table' });
            }

            // Remove from OTHER tables (can only play at 1 table)
            await db.execute({
                sql: 'DELETE FROM yj_seats WHERE user_id = ? AND table_id != ?',
                args: [user.id, tableId]
            });

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

            if (tableId) {
                const seats = await getSeats(tableId);
                const mySeatsHere = seats.filter(s => s.userId === user.id);
                const table = await getTable(tableId);

                for (const mySeat of mySeatsHere) {
                    await removeSeat(tableId, mySeat.seatIndex);

                    // If it was this seat's turn, advance
                    if (table && table.phase === 'playing' && table.activeSeat === mySeat.seatIndex) {
                        const remaining = await getSeats(tableId);
                        await advanceTurn(table, remaining);
                    }
                }

                // If table empty, reset
                const remaining = await getSeats(tableId);
                if (remaining.length === 0 && table) {
                    table.phase = 'waiting';
                    table.deck = []; table.dealerHand = [];
                    table.activeSeat = -1;
                    table.betStartTime = null; table.turnStartTime = null; table.doneTime = null;
                    await saveTable(table);
                }
            } else {
                await removeUserFromAllTables(user.id);
            }

            return res.json({ success: true });
        }

        // ==================================================
        // leaveSeat — leave one specific seat
        // ==================================================
        if (action === 'leaveSeat') {
            const { tableId, seatIndex } = body;
            if (!tableId || seatIndex === undefined) return res.json({ error: 'Missing data' });

            const seats = await getSeats(tableId);
            const seat = seats.find(s => s.userId === user.id && s.seatIndex === seatIndex);
            if (!seat) return res.json({ error: 'Not your seat' });

            const table = await getTable(tableId);

            // Can't leave during active play on this seat
            if (table && table.phase === 'playing' && seat.status === 'playing' && table.activeSeat === seatIndex) {
                return res.json({ error: 'Finish your turn first' });
            }

            await removeSeat(tableId, seatIndex);

            // If it was this seat's turn, advance
            if (table && table.phase === 'playing' && table.activeSeat === seatIndex) {
                const remaining = await getSeats(tableId);
                await advanceTurn(table, remaining);
            }

            // If table empty, reset
            const remaining = await getSeats(tableId);
            if (remaining.length === 0 && table) {
                table.phase = 'waiting'; table.deck = []; table.dealerHand = [];
                table.activeSeat = -1; table.betStartTime = null;
                table.turnStartTime = null; table.doneTime = null;
                await saveTable(table);
            }

            return res.json({ success: true });
        }

        // ==================================================
        // placeBet — with server-side 10k limit validation
        // ==================================================
        if (action === 'placeBet') {
            const { tableId, bet, chips, seatIndex } = body;

            const table = await getTable(tableId);
            if (!table) return res.json({ error: 'Table not found' });

            if (table.phase !== 'waiting') {
                return res.json({ error: 'Cannot bet now' });
            }

            const seats = await getSeats(tableId);
            // Find the specific seat (by seatIndex if given, otherwise first unbetted seat)
            let mySeat;
            if (seatIndex !== undefined && seatIndex !== null) {
                mySeat = seats.find(s => s.userId === user.id && s.seatIndex === seatIndex);
            } else {
                mySeat = seats.find(s => s.userId === user.id && s.bet === 0);
            }
            if (!mySeat) return res.json({ error: 'Seat not found' });
            if (mySeat.bet > 0) return res.json({ error: 'Already bet on this seat' });

            const p = await getPlayer(user.id);
            if (!p || p.points < bet) return res.json({ error: 'Not enough points' });
            if (bet <= 0) return res.json({ error: 'Invalid bet' });

            // Server-side validation: check total bet on table doesn't exceed 10k
            const mySeatsOnTable = seats.filter(s => s.userId === user.id);
            const currentTotalBet = mySeatsOnTable.reduce((sum, s) => sum + (s.bet || 0), 0);
            if (currentTotalBet + bet > MAX_BET_PER_ROUND) {
                return res.json({ error: 'Max 10,000 per round' });
            }

            // Deduct points immediately
            await updatePlayerPoints(user.id, -bet);

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
            // Find MY seat that is the active seat (important for 2-seat players)
            const mySeat = seats.find(s => s.userId === user.id && s.seatIndex === table.activeSeat);
            if (!mySeat) {
                return res.json({ error: 'Not your turn' });
            }
            // Check if still playing
            let sp = mySeat.splitPhase || 0;
            if (sp === 1) {
                // Playing right hand (hand2)
                if (mySeat.status2 !== 'playing') return res.json({ error: 'Already done' });
            } else if (sp === 2) {
                // Playing left hand (hand1)
                if (mySeat.status !== 'playing') return res.json({ error: 'Already done' });
            } else {
                if (mySeat.status !== 'playing') return res.json({ error: 'Already done' });
            }

            let deck = table.deck.length > 10 ? table.deck : createDeck();

            // Split phases: 0=normal, 1=playing right hand (hand2), 2=playing left hand (hand1)
            // Right-to-left: hand2 first, then hand1
            sp = mySeat.splitPhase || 0;
            const activeHand = (sp === 1) ? mySeat.hand2 : mySeat.hand;

            // --- HIT ---
            if (actionType === 'hit') {
                activeHand.push(draw(deck));
                const val = handValue(activeHand);
                let handDone = val > 21 || val === 21;

                if (sp === 1) { mySeat.hand2 = activeHand; } else { mySeat.hand = activeHand; }
                table.deck = deck;

                if (handDone) {
                    const handStatus = val > 21 ? 'bust' : 'stand';
                    if (sp === 0) {
                        mySeat.status = handStatus;
                        await saveSeat(mySeat); await saveTable(table);
                        await advanceTurn(table, seats);
                    } else if (sp === 1) {
                        // Right hand done → move to left hand
                        mySeat.status2 = handStatus;
                        mySeat.splitPhase = 2;
                        mySeat.status = 'playing';
                        table.turnStartTime = new Date().toISOString();
                        await saveSeat(mySeat); await saveTable(table);
                    } else {
                        // Left hand done → both done
                        mySeat.status = handStatus;
                        await saveSeat(mySeat); await saveTable(table);
                        await advanceTurn(table, seats);
                    }
                } else {
                    await saveSeat(mySeat);
                    table.turnStartTime = new Date().toISOString();
                    await saveTable(table);
                }

                return res.json({ success: true });
            }

            // --- STAND ---
            if (actionType === 'stand') {
                if (sp === 0) {
                    mySeat.status = 'stand';
                    await saveSeat(mySeat);
                    await advanceTurn(table, seats);
                } else if (sp === 1) {
                    // Right hand stand → move to left hand
                    mySeat.status2 = 'stand';
                    mySeat.splitPhase = 2;
                    mySeat.status = 'playing';
                    table.turnStartTime = new Date().toISOString();
                    await saveSeat(mySeat); await saveTable(table);
                } else {
                    // Left hand stand → both done
                    mySeat.status = 'stand';
                    await saveSeat(mySeat);
                    await advanceTurn(table, seats);
                }
                return res.json({ success: true });
            }

            // --- DOUBLE ---
            if (actionType === 'double') {
                if (activeHand.length !== 2) return res.json({ error: 'Can only double on 2 cards' });
                if (sp > 0) return res.json({ error: 'Cannot double on split hands' });

                const p = await getPlayer(user.id);
                if (!p || p.points < mySeat.bet) return res.json({ error: 'Not enough points' });

                await updatePlayerPoints(user.id, -mySeat.bet);

                mySeat.bet *= 2;
                activeHand.push(draw(deck));
                const val = handValue(activeHand);
                mySeat.status = val > 21 ? 'bust' : 'stand';
                mySeat.hand = activeHand;
                table.deck = deck;

                await saveSeat(mySeat); await saveTable(table);
                await advanceTurn(table, seats);

                return res.json({ success: true });
            }

            // --- SPLIT ---
            if (actionType === 'split') {
                if (mySeat.hand.length !== 2) return res.json({ error: 'Need exactly 2 cards' });
                if (mySeat.splitPhase > 0) return res.json({ error: 'Already split' });

                // Check same value (not just same rank — K and 10 both = 10)
                const v1 = ['J','Q','K'].includes(mySeat.hand[0].rank) ? 10 : (mySeat.hand[0].rank === 'A' ? 11 : parseInt(mySeat.hand[0].rank));
                const v2 = ['J','Q','K'].includes(mySeat.hand[1].rank) ? 10 : (mySeat.hand[1].rank === 'A' ? 11 : parseInt(mySeat.hand[1].rank));
                if (v1 !== v2) return res.json({ error: 'Cards must have same value' });

                const p = await getPlayer(user.id);
                if (!p || p.points < mySeat.bet) return res.json({ error: 'Not enough points' });

                // Deduct second bet
                await updatePlayerPoints(user.id, -mySeat.bet);

                // Split: hand = left card + new, hand2 = right card + new
                const cardLeft = mySeat.hand[0];
                const cardRight = mySeat.hand[1];
                mySeat.hand = [cardLeft, draw(deck)];
                mySeat.hand2 = [cardRight, draw(deck)];
                // Start with right hand (hand2) = splitPhase 1
                mySeat.splitPhase = 1;
                mySeat.status = 'waiting'; // left hand waits
                mySeat.status2 = 'playing'; // right hand plays first

                table.deck = deck;
                table.turnStartTime = new Date().toISOString();
                await saveSeat(mySeat);
                await saveTable(table);

                return res.json({ success: true });
            }

            return res.json({ error: 'Unknown action type' });
        }

        // ==================================================
        // getLeaderboard — sorted by POINTS (not volume)
        // ==================================================
        if (action === 'getLeaderboard') {
            try {
                const result = await db.execute(`
                    SELECT yj.user_id, yj.points, yj.games_played, yj.total_won, yj.total_lost,
                           COALESCE(u.x_username, 'Player') as x_username, 
                           COALESCE(u.avatar_url, '') as avatar_url
                    FROM yellowjack_players yj
                    LEFT JOIN users u ON yj.user_id = u.id
                    WHERE yj.is_blocked = 0 AND yj.user_id > 0 AND yj.user_id < 900000
                      AND (yj.total_won > 0 OR yj.total_lost > 0 OR yj.games_played > 0)
                    ORDER BY yj.points DESC
                    LIMIT 30
                `);
                return res.json({ players: result.rows });
            } catch (err) {
                console.error('getLeaderboard error:', err);
                return res.json({ players: [] });
            }
        }

        // ==================================================
        // getPastWinners — get winners from past seasons
        // ==================================================
        if (action === 'getPastWinners') {
            try {
                const seasons = await getPastWinners();
                return res.json({ success: true, seasons });
            } catch (err) {
                console.error('getPastWinners error:', err);
                return res.json({ success: false, seasons: [] });
            }
        }

        // ==================================================
        // sendChat — store a chat message
        // ==================================================
        if (action === 'sendChat') {
            const { tableId, message } = body;
            if (!message || !tableId) return res.json({ error: 'Missing data' });

            const clean = message.trim().substring(0, 120);
            if (clean.length === 0) return res.json({ error: 'Empty message' });

            await db.execute({
                sql: `INSERT INTO yj_chat (table_id, user_id, username, message) VALUES (?, ?, ?, ?)`,
                args: [tableId, user.id, user.username, clean]
            });

            // Cleanup old messages (keep last 50 per table)
            await db.execute({
                sql: `DELETE FROM yj_chat WHERE table_id = ? AND id NOT IN (
                    SELECT id FROM yj_chat WHERE table_id = ? ORDER BY id DESC LIMIT 50
                )`,
                args: [tableId, tableId]
            });

            return res.json({ success: true });
        }

        // ==================================================
        // heartbeat — keep seat alive
        // ==================================================
        if (action === 'heartbeat') {
            const { tableId } = body;
            if (tableId) {
                await db.execute({
                    sql: `UPDATE yj_seats SET last_seen = datetime('now') WHERE table_id = ? AND user_id = ?`,
                    args: [tableId, user.id]
                });
            }
            return res.json({ ok: true });
        }

        return res.status(400).json({ error: 'Unknown action' });

    } catch (err) {
        console.error('YellowJack API error:', err);
        return res.status(500).json({ error: 'Server error', details: err.message });
    }
}