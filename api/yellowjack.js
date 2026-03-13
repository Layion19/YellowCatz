import { initDatabase } from './lib/db.js';
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================================
// YELLOWJACK MULTIPLAYER API — VERCEL SERVERLESS
// POST /api/yellowjack
// ============================================================

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SEAT_TIMEOUT = 60000; // 60 seconds without heartbeat = kicked
const BETTING_TIME = 30000; // 30 seconds to bet
const ACTION_TIME = 30000; // 30 seconds per action

function createDeck() {
  const deck = [];
  for (let d = 0; d < 6; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ rank: r, suit: s });
      }
    }
  }
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.rank === 'A') { total += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(c.rank)) total += 10;
    else total += parseInt(c.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Manual body parsing
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', resolve);
  });

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { action } = body;
  if (!action) {
    return res.status(400).json({ error: 'Missing action' });
  }

  try {
    await initDatabase();

    // Create tables if not exist
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
      CREATE TABLE IF NOT EXISTS yellowjack_tables (
        id INTEGER PRIMARY KEY,
        deck TEXT DEFAULT '[]',
        dealer_hand TEXT DEFAULT '[]',
        phase TEXT DEFAULT 'waiting',
        active_seat INTEGER DEFAULT -1,
        round_start DATETIME,
        last_action DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS yellowjack_seats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL,
        seat_index INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT,
        avatar_url TEXT,
        bet INTEGER DEFAULT 0,
        hand TEXT DEFAULT '[]',
        chips TEXT DEFAULT '[]',
        status TEXT DEFAULT 'waiting',
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(table_id, seat_index),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Initialize 6 tables if not exist
    for (let i = 1; i <= 6; i++) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO yellowjack_tables (id, deck, dealer_hand, phase) VALUES (?, "[]", "[]", "waiting")',
        args: [i]
      });
    }

    // Clean up inactive seats (timeout)
    await db.execute({
      sql: `DELETE FROM yellowjack_seats WHERE datetime(last_seen) < datetime('now', '-60 seconds')`
    });

    // Get user from session (for most actions)
    const sessionToken = req.cookies?.session_token;
    let userId = null, userName = null, userAvatar = null;

    if (sessionToken) {
      const sessionResult = await db.execute({
        sql: `SELECT s.user_id, u.x_username, u.avatar_url 
              FROM sessions s 
              JOIN users u ON s.user_id = u.id 
              WHERE s.token = ? AND s.expires_at > datetime('now')`,
        args: [sessionToken]
      });
      if (sessionResult.rows.length > 0) {
        userId = sessionResult.rows[0].user_id;
        userName = sessionResult.rows[0].x_username;
        userAvatar = sessionResult.rows[0].avatar_url;
      }
    }

    // ============================================================
    // GET PLAYER (for points)
    // ============================================================
    if (action === 'getPlayer') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      // Check if blocked
      const blockCheck = await db.execute({
        sql: 'SELECT is_blocked FROM yellowjack_players WHERE user_id = ?',
        args: [userId]
      });
      if (blockCheck.rows.length > 0 && blockCheck.rows[0].is_blocked === 1) {
        return res.status(200).json({ blocked: true });
      }

      const result = await db.execute({
        sql: 'SELECT * FROM yellowjack_players WHERE user_id = ?',
        args: [userId]
      });

      if (result.rows.length === 0) {
        await db.execute({
          sql: 'INSERT INTO yellowjack_players (user_id, points) VALUES (?, 10000)',
          args: [userId]
        });
        return res.status(200).json({ player: { points: 10000, games_played: 0, total_won: 0, total_lost: 0 } });
      }

      return res.status(200).json({ player: result.rows[0] });
    }

    // ============================================================
    // GET ALL TABLES (lobby view)
    // ============================================================
    if (action === 'getTables') {
      const tables = [];
      for (let i = 1; i <= 6; i++) {
        const seats = await db.execute({
          sql: 'SELECT seat_index, username, avatar_url FROM yellowjack_seats WHERE table_id = ?',
          args: [i]
        });
        tables.push({
          id: i,
          players: seats.rows.map(s => ({ seat: s.seat_index, name: s.username, avatar: s.avatar_url }))
        });
      }
      return res.status(200).json({ tables });
    }

    // ============================================================
    // GET TABLE STATE (for polling during game)
    // ============================================================
    if (action === 'getTable') {
      const { tableId } = body;
      if (!tableId) return res.status(400).json({ error: 'Missing tableId' });

      const tableResult = await db.execute({
        sql: 'SELECT * FROM yellowjack_tables WHERE id = ?',
        args: [tableId]
      });

      if (tableResult.rows.length === 0) {
        return res.status(404).json({ error: 'Table not found' });
      }

      const table = tableResult.rows[0];
      const seats = await db.execute({
        sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? ORDER BY seat_index',
        args: [tableId]
      });

      // Parse JSON fields
      const dealerHand = JSON.parse(table.dealer_hand || '[]');
      const seatsData = seats.rows.map(s => ({
        seatIndex: s.seat_index,
        userId: s.user_id,
        username: s.username,
        avatar: s.avatar_url,
        bet: s.bet,
        hand: JSON.parse(s.hand || '[]'),
        chips: JSON.parse(s.chips || '[]'),
        status: s.status
      }));

      return res.status(200).json({
        tableId,
        phase: table.phase,
        activeSeat: table.active_seat,
        dealerHand: table.phase === 'dealer' || table.phase === 'done' ? dealerHand : 
                    (dealerHand.length > 0 ? [dealerHand[0], { rank: '?', suit: '?' }] : []),
        dealerHandFull: dealerHand, // For server-side logic
        seats: seatsData,
        myUserId: userId
      });
    }

    // ============================================================
    // JOIN TABLE
    // ============================================================
    if (action === 'joinTable') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { tableId, seatIndex } = body;
      if (!tableId || seatIndex === undefined) {
        return res.status(400).json({ error: 'Missing tableId or seatIndex' });
      }

      // Check if seat is taken
      const existing = await db.execute({
        sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? AND seat_index = ?',
        args: [tableId, seatIndex]
      });

      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Seat already taken' });
      }

      // Check if user is already at this table
      const userSeat = await db.execute({
        sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? AND user_id = ?',
        args: [tableId, userId]
      });

      if (userSeat.rows.length > 0) {
        return res.status(400).json({ error: 'Already at this table' });
      }

      // Get user points
      let playerPoints = 10000;
      const playerResult = await db.execute({
        sql: 'SELECT points FROM yellowjack_players WHERE user_id = ?',
        args: [userId]
      });
      if (playerResult.rows.length > 0) {
        playerPoints = playerResult.rows[0].points;
      } else {
        await db.execute({
          sql: 'INSERT INTO yellowjack_players (user_id, points) VALUES (?, 10000)',
          args: [userId]
        });
      }

      // Join the seat
      await db.execute({
        sql: `INSERT INTO yellowjack_seats (table_id, seat_index, user_id, username, avatar_url, status, last_seen)
              VALUES (?, ?, ?, ?, ?, 'waiting', datetime('now'))`,
        args: [tableId, seatIndex, userId, userName, userAvatar]
      });

      return res.status(200).json({ success: true, points: playerPoints });
    }

    // ============================================================
    // LEAVE TABLE
    // ============================================================
    if (action === 'leaveTable') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { tableId } = body;

      await db.execute({
        sql: 'DELETE FROM yellowjack_seats WHERE table_id = ? AND user_id = ?',
        args: [tableId, userId]
      });

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // HEARTBEAT (keep seat alive)
    // ============================================================
    if (action === 'heartbeat') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { tableId } = body;

      await db.execute({
        sql: `UPDATE yellowjack_seats SET last_seen = datetime('now') WHERE table_id = ? AND user_id = ?`,
        args: [tableId, userId]
      });

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // PLACE BET
    // ============================================================
    if (action === 'placeBet') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { tableId, bet, chips } = body;

      // Get player points
      const playerResult = await db.execute({
        sql: 'SELECT points FROM yellowjack_players WHERE user_id = ?',
        args: [userId]
      });

      if (playerResult.rows.length === 0 || playerResult.rows[0].points < bet) {
        return res.status(400).json({ error: 'Not enough points' });
      }

      // Update seat with bet
      await db.execute({
        sql: `UPDATE yellowjack_seats SET bet = ?, chips = ?, status = 'ready' WHERE table_id = ? AND user_id = ?`,
        args: [bet, JSON.stringify(chips), tableId, userId]
      });

      // Deduct points
      await db.execute({
        sql: 'UPDATE yellowjack_players SET points = points - ? WHERE user_id = ?',
        args: [bet, userId]
      });

      // Check if all players are ready to start
      const allSeats = await db.execute({
        sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ?',
        args: [tableId]
      });

      const allReady = allSeats.rows.every(s => s.status === 'ready');

      if (allReady && allSeats.rows.length > 0) {
        // Start dealing!
        await startDealing(tableId);
      }

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // START ROUND (when host clicks deal or auto-start)
    // ============================================================
    if (action === 'startRound') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { tableId } = body;

      // Check if there are players with bets
      const seats = await db.execute({
        sql: `SELECT * FROM yellowjack_seats WHERE table_id = ? AND bet > 0`,
        args: [tableId]
      });

      if (seats.rows.length === 0) {
        return res.status(400).json({ error: 'No players with bets' });
      }

      await startDealing(tableId);

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // PLAYER ACTION (hit, stand, double, split)
    // ============================================================
    if (action === 'playerAction') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { tableId, actionType } = body;

      // Get table state
      const tableResult = await db.execute({
        sql: 'SELECT * FROM yellowjack_tables WHERE id = ?',
        args: [tableId]
      });

      if (tableResult.rows.length === 0) {
        return res.status(404).json({ error: 'Table not found' });
      }

      const table = tableResult.rows[0];

      if (table.phase !== 'playing') {
        return res.status(400).json({ error: 'Not in playing phase' });
      }

      // Get current seat
      const seatResult = await db.execute({
        sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? AND user_id = ?',
        args: [tableId, userId]
      });

      if (seatResult.rows.length === 0) {
        return res.status(400).json({ error: 'Not at this table' });
      }

      const seat = seatResult.rows[0];

      if (seat.seat_index !== table.active_seat) {
        return res.status(400).json({ error: 'Not your turn' });
      }

      let deck = JSON.parse(table.deck || '[]');
      let hand = JSON.parse(seat.hand || '[]');
      let newStatus = seat.status;

      if (actionType === 'hit') {
        if (deck.length === 0) deck = createDeck();
        hand.push(deck.pop());
        
        const value = handValue(hand);
        if (value > 21) {
          newStatus = 'bust';
        } else if (value === 21) {
          newStatus = 'standing';
        }

        await db.execute({
          sql: 'UPDATE yellowjack_seats SET hand = ?, status = ? WHERE id = ?',
          args: [JSON.stringify(hand), newStatus, seat.id]
        });
        await db.execute({
          sql: 'UPDATE yellowjack_tables SET deck = ? WHERE id = ?',
          args: [JSON.stringify(deck), tableId]
        });

        if (newStatus === 'bust' || newStatus === 'standing') {
          await moveToNextPlayer(tableId);
        }

      } else if (actionType === 'stand') {
        await db.execute({
          sql: `UPDATE yellowjack_seats SET status = 'standing' WHERE id = ?`,
          args: [seat.id]
        });
        await moveToNextPlayer(tableId);

      } else if (actionType === 'double') {
        // Check if can afford double
        const playerResult = await db.execute({
          sql: 'SELECT points FROM yellowjack_players WHERE user_id = ?',
          args: [userId]
        });

        if (playerResult.rows.length === 0 || playerResult.rows[0].points < seat.bet) {
          return res.status(400).json({ error: 'Not enough points to double' });
        }

        // Deduct additional bet
        await db.execute({
          sql: 'UPDATE yellowjack_players SET points = points - ? WHERE user_id = ?',
          args: [seat.bet, userId]
        });

        // Double the bet and draw one card
        if (deck.length === 0) deck = createDeck();
        hand.push(deck.pop());

        const value = handValue(hand);
        newStatus = value > 21 ? 'bust' : 'standing';

        const newBet = seat.bet * 2;
        const chips = JSON.parse(seat.chips || '[]');
        chips.push(...chips); // Double chips visually

        await db.execute({
          sql: 'UPDATE yellowjack_seats SET hand = ?, bet = ?, chips = ?, status = ? WHERE id = ?',
          args: [JSON.stringify(hand), newBet, JSON.stringify(chips), newStatus, seat.id]
        });
        await db.execute({
          sql: 'UPDATE yellowjack_tables SET deck = ? WHERE id = ?',
          args: [JSON.stringify(deck), tableId]
        });

        await moveToNextPlayer(tableId);
      }

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // UPDATE POINTS (fallback for solo mode)
    // ============================================================
    if (action === 'updatePoints') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { points } = body;

      await db.execute({
        sql: `INSERT INTO yellowjack_players (user_id, points, last_played) 
              VALUES (?, ?, datetime('now'))
              ON CONFLICT(user_id) DO UPDATE SET 
              points = ?, last_played = datetime('now')`,
        args: [userId, points, points]
      });

      return res.status(200).json({ success: true });
    }

    // ============================================================
    // RECORD GAME
    // ============================================================
    if (action === 'recordGame') {
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { won, lost } = body;

      await db.execute({
        sql: `UPDATE yellowjack_players 
              SET games_played = games_played + 1,
                  total_won = total_won + ?,
                  total_lost = total_lost + ?,
                  last_played = datetime('now')
              WHERE user_id = ?`,
        args: [won || 0, lost || 0, userId]
      });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('YELLOWJACK API ERROR:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ============================================================
// HELPER: Start dealing cards
// ============================================================
async function startDealing(tableId) {
  let deck = createDeck();
  const dealerHand = [];

  // Get all seats with bets
  const seats = await db.execute({
    sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? AND bet > 0 ORDER BY seat_index',
    args: [tableId]
  });

  // Deal cards to each player (2 cards each)
  for (const seat of seats.rows) {
    const hand = [deck.pop(), deck.pop()];
    await db.execute({
      sql: `UPDATE yellowjack_seats SET hand = ?, status = 'playing' WHERE id = ?`,
      args: [JSON.stringify(hand), seat.id]
    });
  }

  // Deal to dealer
  dealerHand.push(deck.pop());
  dealerHand.push(deck.pop());

  // Find first active player
  const firstSeat = seats.rows.length > 0 ? seats.rows[0].seat_index : -1;

  // Check for dealer blackjack
  if (isBlackjack(dealerHand)) {
    // Resolve immediately
    await db.execute({
      sql: `UPDATE yellowjack_tables SET deck = ?, dealer_hand = ?, phase = 'done', active_seat = -1 WHERE id = ?`,
      args: [JSON.stringify(deck), JSON.stringify(dealerHand), tableId]
    });
    await resolveRound(tableId);
  } else {
    await db.execute({
      sql: `UPDATE yellowjack_tables SET deck = ?, dealer_hand = ?, phase = 'playing', active_seat = ?, round_start = datetime('now') WHERE id = ?`,
      args: [JSON.stringify(deck), JSON.stringify(dealerHand), firstSeat, tableId]
    });

    // Check if first player has blackjack - auto stand
    if (seats.rows.length > 0) {
      const firstHand = JSON.parse(seats.rows[0].hand || '[]');
      if (firstHand.length === 0) {
        // Cards not dealt yet, we just dealt them above
        const newFirstSeat = await db.execute({
          sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? AND seat_index = ?',
          args: [tableId, firstSeat]
        });
        if (newFirstSeat.rows.length > 0) {
          const hand = JSON.parse(newFirstSeat.rows[0].hand || '[]');
          if (isBlackjack(hand)) {
            await db.execute({
              sql: `UPDATE yellowjack_seats SET status = 'blackjack' WHERE id = ?`,
              args: [newFirstSeat.rows[0].id]
            });
            await moveToNextPlayer(tableId);
          }
        }
      }
    }
  }
}

// ============================================================
// HELPER: Move to next player or dealer
// ============================================================
async function moveToNextPlayer(tableId) {
  const tableResult = await db.execute({
    sql: 'SELECT * FROM yellowjack_tables WHERE id = ?',
    args: [tableId]
  });

  if (tableResult.rows.length === 0) return;

  const table = tableResult.rows[0];
  const currentSeat = table.active_seat;

  // Get all playing seats
  const seats = await db.execute({
    sql: `SELECT * FROM yellowjack_seats WHERE table_id = ? AND bet > 0 ORDER BY seat_index`,
    args: [tableId]
  });

  // Find next seat that is still 'playing'
  let nextSeat = -1;
  let foundCurrent = false;

  for (const seat of seats.rows) {
    if (seat.seat_index === currentSeat) {
      foundCurrent = true;
      continue;
    }
    if (foundCurrent && seat.status === 'playing') {
      // Check for blackjack
      const hand = JSON.parse(seat.hand || '[]');
      if (isBlackjack(hand)) {
        await db.execute({
          sql: `UPDATE yellowjack_seats SET status = 'blackjack' WHERE id = ?`,
          args: [seat.id]
        });
        continue;
      }
      nextSeat = seat.seat_index;
      break;
    }
  }

  if (nextSeat >= 0) {
    // Move to next player
    await db.execute({
      sql: 'UPDATE yellowjack_tables SET active_seat = ? WHERE id = ?',
      args: [nextSeat, tableId]
    });
  } else {
    // All players done - dealer's turn
    await dealerPlay(tableId);
  }
}

// ============================================================
// HELPER: Dealer plays
// ============================================================
async function dealerPlay(tableId) {
  const tableResult = await db.execute({
    sql: 'SELECT * FROM yellowjack_tables WHERE id = ?',
    args: [tableId]
  });

  if (tableResult.rows.length === 0) return;

  const table = tableResult.rows[0];
  let deck = JSON.parse(table.deck || '[]');
  let dealerHand = JSON.parse(table.dealer_hand || '[]');

  // Dealer draws until 17+
  while (handValue(dealerHand) < 17) {
    if (deck.length === 0) deck = createDeck();
    dealerHand.push(deck.pop());
  }

  // Update table
  await db.execute({
    sql: `UPDATE yellowjack_tables SET deck = ?, dealer_hand = ?, phase = 'done', active_seat = -1 WHERE id = ?`,
    args: [JSON.stringify(deck), JSON.stringify(dealerHand), tableId]
  });

  // Resolve round
  await resolveRound(tableId);
}

// ============================================================
// HELPER: Resolve round - pay winners
// ============================================================
async function resolveRound(tableId) {
  const tableResult = await db.execute({
    sql: 'SELECT * FROM yellowjack_tables WHERE id = ?',
    args: [tableId]
  });

  if (tableResult.rows.length === 0) return;

  const table = tableResult.rows[0];
  const dealerHand = JSON.parse(table.dealer_hand || '[]');
  const dealerValue = handValue(dealerHand);
  const dealerBJ = isBlackjack(dealerHand);

  const seats = await db.execute({
    sql: 'SELECT * FROM yellowjack_seats WHERE table_id = ? AND bet > 0',
    args: [tableId]
  });

  for (const seat of seats.rows) {
    const hand = JSON.parse(seat.hand || '[]');
    const playerValue = handValue(hand);
    const playerBJ = isBlackjack(hand);
    let payout = 0;

    if (seat.status === 'bust') {
      // Player busted - loses bet (already deducted)
      payout = 0;
    } else if (playerBJ && dealerBJ) {
      // Both blackjack - push
      payout = seat.bet;
    } else if (playerBJ) {
      // Player blackjack - pays 2.5x
      payout = Math.floor(seat.bet * 2.5);
    } else if (dealerBJ) {
      // Dealer blackjack - player loses
      payout = 0;
    } else if (dealerValue > 21) {
      // Dealer busted - player wins
      payout = seat.bet * 2;
    } else if (playerValue > dealerValue) {
      // Player wins
      payout = seat.bet * 2;
    } else if (playerValue === dealerValue) {
      // Push
      payout = seat.bet;
    } else {
      // Dealer wins
      payout = 0;
    }

    // Pay the player
    if (payout > 0) {
      await db.execute({
        sql: 'UPDATE yellowjack_players SET points = points + ? WHERE user_id = ?',
        args: [payout, seat.user_id]
      });
    }

    // Record game stats
    const won = payout > seat.bet ? payout - seat.bet : 0;
    const lost = payout < seat.bet ? seat.bet - payout : 0;

    await db.execute({
      sql: `UPDATE yellowjack_players 
            SET games_played = games_played + 1,
                total_won = total_won + ?,
                total_lost = total_lost + ?
            WHERE user_id = ?`,
      args: [won, lost, seat.user_id]
    });
  }

  // Reset table after 5 seconds (done by client polling)
}