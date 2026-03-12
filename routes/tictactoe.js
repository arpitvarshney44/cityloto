const express = require('express');
const router = express.Router();
const TicTacToeRoom = require('../models/TicTacToeRoom');
const GameSettings = require('../models/GameSettings');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

// ── Helper: Generate 6-char room code ──
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,1,O,0 for readability
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// ── Helper: Check for winner ──
const WINNING_COMBOS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
    [0, 4, 8], [2, 4, 6]              // diagonals
];

function checkWinner(board) {
    for (const combo of WINNING_COMBOS) {
        const [a, b, c] = combo;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { winner: board[a], line: combo };
        }
    }
    // Check draw
    if (board.every(cell => cell !== '')) {
        return { winner: 'draw', line: [] };
    }
    return null;
}

// ── Helper: Get game settings ──
async function getSettings() {
    let settings = await GameSettings.findOne({ game: 'tictactoe' });
    if (!settings) {
        settings = await new GameSettings({
            game: 'tictactoe',
            winPercentage: 90,
            minBet: 10,
            maxBet: 5000
        }).save();
    }
    return settings;
}

// ============================================
//  PLAYER ROUTES
// ============================================

// @route   GET api/tictactoe/settings
// @desc    Get game settings (bet limits, active status)
// @access  Private
router.get('/settings', auth, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({
            minBet: settings.minBet,
            maxBet: settings.maxBet,
            winPercentage: settings.winPercentage,
            isActive: settings.isActive
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/tictactoe/create-room
// @desc    Create a new game room with bet amount
// @access  Private
router.post('/create-room', auth, async (req, res) => {
    try {
        const { betAmount } = req.body;
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({ message: 'Valid bet amount required' });
        }

        const settings = await getSettings();
        if (!settings.isActive) {
            return res.status(400).json({ message: 'Tic Tac Toe is currently disabled' });
        }

        if (betAmount < settings.minBet || betAmount > settings.maxBet) {
            return res.status(400).json({
                message: `Bet must be between ₹${settings.minBet} and ₹${settings.maxBet}`
            });
        }

        // Check if user already has an active waiting room
        const existingRoom = await TicTacToeRoom.findOne({
            player1: req.user.id,
            status: 'waiting'
        });
        if (existingRoom) {
            return res.status(400).json({
                message: 'You already have an active room. Cancel it first or share the room code.',
                roomCode: existingRoom.roomCode
            });
        }

        // Atomically deduct bet from wallet
        const user = await User.findOneAndUpdate(
            { _id: req.user.id, walletBalance: { $gte: betAmount } },
            { $inc: { walletBalance: -betAmount } },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({ message: `Insufficient balance. You need ₹${betAmount} to create a room.` });
        }

        // Generate unique room code
        let roomCode;
        let attempts = 0;
        do {
            roomCode = generateRoomCode();
            attempts++;
        } while (await TicTacToeRoom.findOne({ roomCode, status: { $in: ['waiting', 'playing'] } }) && attempts < 10);

        // Create room
        const room = new TicTacToeRoom({
            roomCode,
            player1: req.user.id,
            betAmount
        });
        await room.save();

        // Log transaction
        await new Transaction({
            userId: req.user.id,
            title: `Tic Tac Toe — Room ${roomCode} (₹${betAmount} bet)`,
            amount: betAmount,
            type: 'deduction',
            status: 'Success'
        }).save();

        res.status(201).json({
            message: 'Room created! Share the code with your friend 🎮',
            roomCode,
            betAmount,
            walletBalance: user.walletBalance
        });

    } catch (err) {
        console.error('Create Room Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/tictactoe/join-room
// @desc    Join an existing room by code
// @access  Private
router.post('/join-room', auth, async (req, res) => {
    try {
        const { roomCode } = req.body;
        if (!roomCode) {
            return res.status(400).json({ message: 'Room code required' });
        }

        const room = await TicTacToeRoom.findOne({
            roomCode: roomCode.toUpperCase(),
            status: 'waiting'
        });

        if (!room) {
            return res.status(404).json({ message: 'Room not found or already started' });
        }

        // Check room expiry
        if (new Date() > room.expiresAt) {
            room.status = 'expired';
            await room.save();
            // Refund player 1
            await User.findByIdAndUpdate(room.player1, { $inc: { walletBalance: room.betAmount } });
            await new Transaction({
                userId: room.player1,
                title: `Refund: Room ${room.roomCode} expired`,
                amount: room.betAmount,
                type: 'bonus',
                status: 'Success'
            }).save();
            return res.status(400).json({ message: 'Room has expired' });
        }

        // Can't join your own room
        if (room.player1.toString() === req.user.id) {
            return res.status(400).json({ message: 'You cannot join your own room' });
        }

        // Atomically deduct bet from wallet
        const user = await User.findOneAndUpdate(
            { _id: req.user.id, walletBalance: { $gte: room.betAmount } },
            { $inc: { walletBalance: -room.betAmount } },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({
                message: `Insufficient balance. You need ₹${room.betAmount} to join.`
            });
        }

        // Atomically update room (prevent double join)
        const updatedRoom = await TicTacToeRoom.findOneAndUpdate(
            { _id: room._id, status: 'waiting', player2: null },
            {
                $set: {
                    player2: req.user.id,
                    status: 'playing',
                    lastMoveAt: new Date()
                }
            },
            { new: true }
        );

        if (!updatedRoom) {
            // Refund — someone else joined first
            await User.findByIdAndUpdate(req.user.id, { $inc: { walletBalance: room.betAmount } });
            return res.status(400).json({ message: 'Room is no longer available' });
        }

        // Log transaction
        await new Transaction({
            userId: req.user.id,
            title: `Tic Tac Toe — Joined Room ${room.roomCode} (₹${room.betAmount} bet)`,
            amount: room.betAmount,
            type: 'deduction',
            status: 'Success'
        }).save();

        res.json({
            message: 'Joined! Game is starting 🎯',
            roomCode: updatedRoom.roomCode,
            betAmount: updatedRoom.betAmount,
            walletBalance: user.walletBalance
        });

    } catch (err) {
        console.error('Join Room Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/tictactoe/room/:roomCode
// @desc    Get room state (for polling)
// @access  Private
router.get('/room/:roomCode', auth, async (req, res) => {
    try {
        const room = await TicTacToeRoom.findOne({
            roomCode: req.params.roomCode.toUpperCase()
        })
            .populate('player1', 'fullName avatar')
            .populate('player2', 'fullName avatar')
            .populate('winner', 'fullName');

        if (!room) {
            return res.status(404).json({ message: 'Room not found' });
        }

        // Check if requesting user is part of this room
        const isPlayer1 = room.player1?._id.toString() === req.user.id;
        const isPlayer2 = room.player2?._id?.toString() === req.user.id;

        if (!isPlayer1 && !isPlayer2) {
            return res.status(403).json({ message: 'You are not part of this room' });
        }

        // Check for move timeout (60 seconds inactivity during play)
        if (room.status === 'playing' && room.lastMoveAt) {
            const timeSinceLastMove = Date.now() - new Date(room.lastMoveAt).getTime();
            if (timeSinceLastMove > 60000) { // 60 seconds timeout
                // Whoever's turn it is forfeits
                const forfeitPlayerId = room.currentTurn === 'X'
                    ? room.player1._id
                    : room.player2._id;
                const winnerId = room.currentTurn === 'X'
                    ? room.player2._id
                    : room.player1._id;

                await endGame(room._id, winnerId, room.currentTurn === 'X' ? 'player2' : 'player1', [], 'timeout');
                // Re-fetch updated room
                const updatedRoom = await TicTacToeRoom.findById(room._id)
                    .populate('player1', 'fullName avatar')
                    .populate('player2', 'fullName avatar')
                    .populate('winner', 'fullName');

                return res.json({
                    room: updatedRoom,
                    yourSymbol: isPlayer1 ? 'X' : 'O',
                    isYourTurn: false,
                    timeout: true
                });
            }
        }

        res.json({
            room,
            yourSymbol: isPlayer1 ? 'X' : 'O',
            isYourTurn: room.status === 'playing' &&
                ((isPlayer1 && room.currentTurn === 'X') ||
                    (isPlayer2 && room.currentTurn === 'O'))
        });

    } catch (err) {
        console.error('Get Room Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/tictactoe/move
// @desc    Make a move on the board
// @access  Private
router.post('/move', auth, async (req, res) => {
    try {
        const { roomCode, position } = req.body;

        if (roomCode === undefined || position === undefined) {
            return res.status(400).json({ message: 'Room code and position required' });
        }

        if (position < 0 || position > 8) {
            return res.status(400).json({ message: 'Invalid position (0-8)' });
        }

        const room = await TicTacToeRoom.findOne({
            roomCode: roomCode.toUpperCase(),
            status: 'playing'
        });

        if (!room) {
            return res.status(404).json({ message: 'Game not found or not in progress' });
        }

        // Determine player's symbol
        const isPlayer1 = room.player1.toString() === req.user.id;
        const isPlayer2 = room.player2.toString() === req.user.id;

        if (!isPlayer1 && !isPlayer2) {
            return res.status(403).json({ message: 'You are not part of this game' });
        }

        const playerSymbol = isPlayer1 ? 'X' : 'O';

        // Verify it's this player's turn
        if (room.currentTurn !== playerSymbol) {
            return res.status(400).json({ message: 'Not your turn' });
        }

        // Verify cell is empty
        if (room.board[position] !== '') {
            return res.status(400).json({ message: 'Cell already occupied' });
        }

        // Make the move atomically
        const boardUpdate = {};
        boardUpdate[`board.${position}`] = playerSymbol;

        const updatedRoom = await TicTacToeRoom.findOneAndUpdate(
            {
                _id: room._id,
                status: 'playing',
                currentTurn: playerSymbol,
                [`board.${position}`]: ''
            },
            {
                $set: {
                    ...boardUpdate,
                    currentTurn: playerSymbol === 'X' ? 'O' : 'X',
                    lastMoveAt: new Date()
                },
                $inc: { moveCount: 1 }
            },
            { new: true }
        );

        if (!updatedRoom) {
            return res.status(400).json({ message: 'Move failed — try again' });
        }

        // Check for winner or draw
        const result = checkWinner(updatedRoom.board);

        if (result) {
            if (result.winner === 'draw') {
                await endGame(updatedRoom._id, null, 'draw', []);
            } else {
                const winnerId = result.winner === 'X' ? updatedRoom.player1 : updatedRoom.player2;
                const resultStr = result.winner === 'X' ? 'player1' : 'player2';
                await endGame(updatedRoom._id, winnerId, resultStr, result.line);
            }
        }

        // Fetch final state
        const finalRoom = await TicTacToeRoom.findById(updatedRoom._id)
            .populate('player1', 'fullName avatar')
            .populate('player2', 'fullName avatar')
            .populate('winner', 'fullName');

        res.json({
            room: finalRoom,
            yourSymbol: playerSymbol,
            isYourTurn: finalRoom.status === 'playing' && finalRoom.currentTurn !== playerSymbol
                ? false
                : finalRoom.status === 'playing' && finalRoom.currentTurn === playerSymbol
        });

    } catch (err) {
        console.error('Move Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/tictactoe/cancel-room
// @desc    Cancel a waiting room (refund)
// @access  Private
router.post('/cancel-room', auth, async (req, res) => {
    try {
        const { roomCode } = req.body;

        const room = await TicTacToeRoom.findOneAndUpdate(
            {
                roomCode: roomCode.toUpperCase(),
                player1: req.user.id,
                status: 'waiting'
            },
            { $set: { status: 'cancelled' } },
            { new: true }
        );

        if (!room) {
            return res.status(404).json({ message: 'Room not found or cannot be cancelled' });
        }

        // Refund player 1
        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $inc: { walletBalance: room.betAmount } },
            { new: true }
        );

        await new Transaction({
            userId: req.user.id,
            title: `Refund: Cancelled Room ${room.roomCode}`,
            amount: room.betAmount,
            type: 'bonus',
            status: 'Success'
        }).save();

        res.json({
            message: 'Room cancelled. Bet refunded! 💰',
            walletBalance: user.walletBalance
        });

    } catch (err) {
        console.error('Cancel Room Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/tictactoe/forfeit
// @desc    Forfeit an active game (opponent wins)
// @access  Private
router.post('/forfeit', auth, async (req, res) => {
    try {
        const { roomCode } = req.body;

        const room = await TicTacToeRoom.findOne({
            roomCode: roomCode.toUpperCase(),
            status: 'playing'
        });

        if (!room) {
            return res.status(404).json({ message: 'Game not found or not in progress' });
        }

        const isPlayer1 = room.player1.toString() === req.user.id;
        const isPlayer2 = room.player2.toString() === req.user.id;

        if (!isPlayer1 && !isPlayer2) {
            return res.status(403).json({ message: 'You are not part of this game' });
        }

        const winnerId = isPlayer1 ? room.player2 : room.player1;
        const resultStr = isPlayer1 ? 'player2' : 'player1';

        await endGame(room._id, winnerId, resultStr, [], 'forfeit');

        res.json({ message: 'You forfeited. Opponent wins.' });

    } catch (err) {
        console.error('Forfeit Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/tictactoe/my-history
// @desc    Get user's game history
// @access  Private
router.get('/my-history', auth, async (req, res) => {
    try {
        const rooms = await TicTacToeRoom.find({
            $or: [{ player1: req.user.id }, { player2: req.user.id }],
            status: { $in: ['finished', 'cancelled', 'expired'] }
        })
            .populate('player1', 'fullName avatar')
            .populate('player2', 'fullName avatar')
            .populate('winner', 'fullName')
            .sort({ createdAt: -1 })
            .limit(20);

        res.json(rooms);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ============================================
//  END GAME LOGIC
// ============================================
async function endGame(roomId, winnerId, result, winningLine, reason = 'game') {
    try {
        const room = await TicTacToeRoom.findById(roomId);
        if (!room || room.status === 'finished') return;

        const settings = await getSettings();
        const totalPool = room.betAmount * 2;
        const commissionRate = (100 - settings.winPercentage) / 100;
        const adminCommission = Math.floor(totalPool * commissionRate);
        const prizeAmount = totalPool - adminCommission;

        if (result === 'draw') {
            // Draw: refund both players (minus small commission)
            const refundEach = Math.floor(totalPool / 2);

            await User.findByIdAndUpdate(room.player1, { $inc: { walletBalance: refundEach } });
            await User.findByIdAndUpdate(room.player2, { $inc: { walletBalance: refundEach } });

            await new Transaction({
                userId: room.player1,
                title: `Draw — Tic Tac Toe Room ${room.roomCode}`,
                amount: refundEach,
                type: 'bonus',
                status: 'Success'
            }).save();

            await new Transaction({
                userId: room.player2,
                title: `Draw — Tic Tac Toe Room ${room.roomCode}`,
                amount: refundEach,
                type: 'bonus',
                status: 'Success'
            }).save();

            room.result = 'draw';
            room.prizeAmount = 0;
            room.adminCommission = 0;

        } else {
            // Winner gets the prize
            await User.findByIdAndUpdate(winnerId, { $inc: { walletBalance: prizeAmount } });

            const reasonText = reason === 'forfeit' ? ' (Forfeit)' : reason === 'timeout' ? ' (Timeout)' : '';
            await new Transaction({
                userId: winnerId,
                title: `🏆 Won Tic Tac Toe${reasonText} — Room ${room.roomCode}`,
                amount: prizeAmount,
                type: 'win',
                status: 'Success'
            }).save();

            room.winner = winnerId;
            room.result = result;
            room.prizeAmount = prizeAmount;
            room.adminCommission = adminCommission;
        }

        room.status = 'finished';
        room.winningLine = winningLine;
        await room.save();

        console.log(`✅ TicTacToe Room ${room.roomCode} finished — Result: ${result}, Prize: ₹${prizeAmount}`);

    } catch (err) {
        console.error('End Game Error:', err);
    }
}

// ============================================
//  ADMIN ROUTES
// ============================================

// @route   GET api/tictactoe/admin/settings
// @desc    Get full game settings (admin view)
// @access  Admin
router.get('/admin/settings', auth, admin, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json(settings);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   PUT api/tictactoe/admin/settings
// @desc    Update game settings
// @access  Admin
router.put('/admin/settings', auth, admin, async (req, res) => {
    try {
        const { winPercentage, minBet, maxBet, isActive } = req.body;

        const updates = { updatedBy: req.user.id, updatedAt: new Date() };
        if (winPercentage !== undefined) updates.winPercentage = Math.max(50, Math.min(100, winPercentage));
        if (minBet !== undefined) updates.minBet = minBet;
        if (maxBet !== undefined) updates.maxBet = maxBet;
        if (isActive !== undefined) updates.isActive = isActive;

        const settings = await GameSettings.findOneAndUpdate(
            { game: 'tictactoe' },
            { $set: updates },
            { new: true, upsert: true }
        );

        res.json({ message: 'Settings updated', settings });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/tictactoe/admin/stats
// @desc    Get game statistics
// @access  Admin
router.get('/admin/stats', auth, admin, async (req, res) => {
    try {
        const totalGames = await TicTacToeRoom.countDocuments({ status: 'finished' });
        const activeGames = await TicTacToeRoom.countDocuments({ status: { $in: ['waiting', 'playing'] } });
        const allFinished = await TicTacToeRoom.find({ status: 'finished' });

        const stats = {
            totalGames,
            activeGames,
            totalCommission: allFinished.reduce((sum, g) => sum + (g.adminCommission || 0), 0),
            totalPrizeDistributed: allFinished.reduce((sum, g) => sum + (g.prizeAmount || 0), 0),
            totalBetVolume: allFinished.reduce((sum, g) => sum + (g.betAmount * 2), 0),
            draws: allFinished.filter(g => g.result === 'draw').length
        };

        res.json(stats);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
