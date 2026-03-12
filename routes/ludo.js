const express = require('express');
const router = express.Router();
const LudoRoom = require('../models/LudoRoom');
const GameSettings = require('../models/GameSettings');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

// ── Helper: Generate 6-char room code ──
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// ── Helper: Get game settings ──
async function getSettings() {
    let settings = await GameSettings.findOne({ game: 'ludo' });
    if (!settings) {
        settings = await new GameSettings({
            game: 'ludo',
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

// @route   GET api/ludo/settings
// @desc    Get game settings
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

// @route   POST api/ludo/create-room
// @desc    Create a new game room with bet amount
// @access  Private
router.post('/create-room', auth, async (req, res) => {
    try {
        const { betAmount } = req.body;
        if (!betAmount || betAmount <= 0) return res.status(400).json({ message: 'Valid bet amount required' });

        const settings = await getSettings();
        if (!settings.isActive) return res.status(400).json({ message: 'Ludo is currently disabled' });
        if (betAmount < settings.minBet || betAmount > settings.maxBet) {
            return res.status(400).json({ message: `Bet must be between ₹${settings.minBet} and ₹${settings.maxBet}` });
        }

        const existingRoom = await LudoRoom.findOne({ player1: req.user.id, status: 'waiting' });
        if (existingRoom) {
            return res.status(400).json({
                message: 'You already have an active room. Cancel it first or share the room code.',
                roomCode: existingRoom.roomCode
            });
        }

        const user = await User.findOneAndUpdate(
            { _id: req.user.id, walletBalance: { $gte: betAmount } },
            { $inc: { walletBalance: -betAmount } },
            { new: true }
        );

        if (!user) return res.status(400).json({ message: `Insufficient balance. You need ₹${betAmount} to create a room.` });

        let roomCode;
        let attempts = 0;
        do {
            roomCode = generateRoomCode();
            attempts++;
        } while (await LudoRoom.findOne({ roomCode, status: { $in: ['waiting', 'playing'] } }) && attempts < 10);

        const room = new LudoRoom({ roomCode, player1: req.user.id, betAmount, gameState: { chancePlayer: 1, diceNo: 1, isDiceRolled: false } });
        await room.save();

        await new Transaction({
            userId: req.user.id,
            title: `Ludo — Room ${roomCode} (₹${betAmount} bet)`,
            amount: betAmount,
            type: 'deduction',
            status: 'Success'
        }).save();

        res.status(201).json({
            message: 'Room created! Share the code with your friend 🎲',
            roomCode,
            betAmount,
            walletBalance: user.walletBalance
        });
    } catch (err) {
        console.error('Create Room Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/ludo/join-room
// @desc    Join an existing room
// @access  Private
router.post('/join-room', auth, async (req, res) => {
    try {
        const { roomCode } = req.body;
        if (!roomCode) return res.status(400).json({ message: 'Room code required' });

        const room = await LudoRoom.findOne({ roomCode: roomCode.toUpperCase(), status: 'waiting' });
        if (!room) return res.status(404).json({ message: 'Room not found or already started' });

        if (new Date() > room.expiresAt) {
            room.status = 'expired';
            await room.save();
            await User.findByIdAndUpdate(room.player1, { $inc: { walletBalance: room.betAmount } });
            await new Transaction({ userId: room.player1, title: `Refund: Room ${room.roomCode} expired`, amount: room.betAmount, type: 'bonus', status: 'Success' }).save();
            return res.status(400).json({ message: 'Room has expired' });
        }

        if (room.player1.toString() === req.user.id) return res.status(400).json({ message: 'You cannot join your own room' });

        const user = await User.findOneAndUpdate(
            { _id: req.user.id, walletBalance: { $gte: room.betAmount } },
            { $inc: { walletBalance: -room.betAmount } },
            { new: true }
        );

        if (!user) return res.status(400).json({ message: `Insufficient balance. You need ₹${room.betAmount} to join.` });

        const updatedRoom = await LudoRoom.findOneAndUpdate(
            { _id: room._id, status: 'waiting', player2: null },
            { $set: { player2: req.user.id, status: 'playing', lastMoveAt: new Date() } },
            { new: true }
        );

        if (!updatedRoom) {
            await User.findByIdAndUpdate(req.user.id, { $inc: { walletBalance: room.betAmount } });
            return res.status(400).json({ message: 'Room is no longer available' });
        }

        await new Transaction({
            userId: req.user.id,
            title: `Ludo — Joined Room ${room.roomCode} (₹${room.betAmount} bet)`,
            amount: room.betAmount,
            type: 'deduction',
            status: 'Success'
        }).save();

        res.json({
            message: 'Joined! Game is starting 🎲',
            roomCode: updatedRoom.roomCode,
            betAmount: updatedRoom.betAmount,
            walletBalance: user.walletBalance
        });
    } catch (err) {
        console.error('Join Room Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/ludo/room/:roomCode
router.get('/room/:roomCode', auth, async (req, res) => {
    try {
        const room = await LudoRoom.findOne({ roomCode: req.params.roomCode.toUpperCase() })
            .populate('player1', 'fullName avatar')
            .populate('player2', 'fullName avatar')
            .populate('winner', 'fullName');

        if (!room) return res.status(404).json({ message: 'Room not found' });

        const isPlayer1 = room.player1?._id.toString() === req.user.id;
        const isPlayer2 = room.player2?._id?.toString() === req.user.id;

        if (!isPlayer1 && !isPlayer2) return res.status(403).json({ message: 'You are not part of this room' });

        // Handle timeouts (e.g. 1 minute)
        if (room.status === 'playing' && room.lastMoveAt) {
            const timeSinceLastMove = Date.now() - new Date(room.lastMoveAt).getTime();
            if (timeSinceLastMove > 180000) { // 3 min timeout 
                const isP1Turn = room.gameState?.chancePlayer === 1;
                const winnerId = isP1Turn ? room.player2._id : room.player1._id;
                await endGame(room._id, winnerId, isP1Turn ? 'player2' : 'player1', 'timeout');
                const updatedRoom = await LudoRoom.findById(room._id).populate('player1', 'fullName avatar').populate('player2', 'fullName avatar').populate('winner', 'fullName');
                return res.json({ room: updatedRoom, playerNo: isPlayer1 ? 1 : 2, timeout: true });
            }
        }

        res.json({
            room,
            playerNo: isPlayer1 ? 1 : 2
        });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/ludo/sync-state
router.post('/sync-state', auth, async (req, res) => {
    try {
        const { roomCode, gameState, winnerId } = req.body;
        if (!roomCode || !gameState) return res.status(400).json({ message: 'Invalid data' });

        const room = await LudoRoom.findOne({ roomCode: roomCode.toUpperCase(), status: 'playing' });
        if (!room) return res.status(404).json({ message: 'Game not active' });

        const isPlayer1 = room.player1.toString() === req.user.id;
        const isPlayer2 = room.player2.toString() === req.user.id;

        if (!isPlayer1 && !isPlayer2) return res.status(403).json({ message: 'Not authorized' });

        const updatedRoom = await LudoRoom.findOneAndUpdate(
            { _id: room._id, status: 'playing' },
            { $set: { gameState, lastMoveAt: new Date() }, $inc: { moveCount: 1 } },
            { new: true }
        );

        if (winnerId) {
            const winnerRef = winnerId === 1 ? room.player1 : room.player2;
            await endGame(room._id, winnerRef, winnerId === 1 ? 'player1' : 'player2', 'game');
        }

        res.json({ success: true, room: updatedRoom });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/ludo/cancel-room
router.post('/cancel-room', auth, async (req, res) => {
    try {
        const { roomCode } = req.body;
        const room = await LudoRoom.findOneAndUpdate(
            { roomCode: roomCode.toUpperCase(), player1: req.user.id, status: 'waiting' },
            { $set: { status: 'cancelled' } },
            { new: true }
        );

        if (!room) return res.status(404).json({ message: 'Room not found or cannot be cancelled' });

        const user = await User.findByIdAndUpdate(req.user.id, { $inc: { walletBalance: room.betAmount } }, { new: true });

        await new Transaction({
            userId: req.user.id,
            title: `Refund: Cancelled Room ${room.roomCode}`,
            amount: room.betAmount,
            type: 'bonus',
            status: 'Success'
        }).save();

        res.json({ message: 'Room cancelled. Bet refunded! 💰', walletBalance: user.walletBalance });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/ludo/forfeit
router.post('/forfeit', auth, async (req, res) => {
    try {
        const { roomCode } = req.body;
        const room = await LudoRoom.findOne({ roomCode: roomCode.toUpperCase(), status: 'playing' });
        if (!room) return res.status(404).json({ message: 'Game not active' });

        const isPlayer1 = room.player1.toString() === req.user.id;
        const isPlayer2 = room.player2.toString() === req.user.id;
        if (!isPlayer1 && !isPlayer2) return res.status(403).json({ message: 'Not authorized' });

        const winnerId = isPlayer1 ? room.player2 : room.player1;
        await endGame(room._id, winnerId, isPlayer1 ? 'player2' : 'player1', 'forfeit');

        res.json({ message: 'You forfeited.' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/ludo/my-history
router.get('/my-history', auth, async (req, res) => {
    try {
        const rooms = await LudoRoom.find({
            $or: [{ player1: req.user.id }, { player2: req.user.id }],
            status: { $in: ['finished', 'cancelled', 'expired'] }
        }).populate('player1', 'fullName avatar').populate('player2', 'fullName avatar').populate('winner', 'fullName').sort({ createdAt: -1 }).limit(20);
        res.json(rooms);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

async function endGame(roomId, winnerId, resultStr, reason) {
    try {
        const room = await LudoRoom.findById(roomId);
        if (!room || room.status === 'finished') return;

        const settings = await getSettings();
        const totalPool = room.betAmount * 2;
        const commissionRate = (100 - settings.winPercentage) / 100;
        const adminCommission = Math.floor(totalPool * commissionRate);
        const prizeAmount = totalPool - adminCommission;

        await User.findByIdAndUpdate(winnerId, { $inc: { walletBalance: prizeAmount } });

        let reasonTxt = reason === 'forfeit' ? ' (Forfeit)' : reason === 'timeout' ? ' (Timeout)' : '';
        await new Transaction({
            userId: winnerId,
            title: `🏆 Won Ludo${reasonTxt} — Room ${room.roomCode}`,
            amount: prizeAmount,
            type: 'win',
            status: 'Success'
        }).save();

        room.winner = winnerId;
        room.result = resultStr;
        room.prizeAmount = prizeAmount;
        room.adminCommission = adminCommission;
        room.status = 'finished';
        await room.save();
    } catch (err) {
        console.error('End Game Error:', err);
    }
}

// ============================================
//  ADMIN ROUTES
// ============================================

router.get('/admin/settings', auth, admin, async (req, res) => {
    try {
        const settings = await getSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

router.put('/admin/settings', auth, admin, async (req, res) => {
    try {
        const { winPercentage, minBet, maxBet, isActive } = req.body;
        const updates = { updatedBy: req.user.id, updatedAt: new Date() };
        if (winPercentage !== undefined) updates.winPercentage = Math.max(50, Math.min(100, winPercentage));
        if (minBet !== undefined) updates.minBet = minBet;
        if (maxBet !== undefined) updates.maxBet = maxBet;
        if (isActive !== undefined) updates.isActive = isActive;

        const settings = await GameSettings.findOneAndUpdate({ game: 'ludo' }, { $set: updates }, { new: true, upsert: true });
        res.json({ message: 'Settings updated', settings });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/admin/stats', auth, admin, async (req, res) => {
    try {
        const totalGames = await LudoRoom.countDocuments({ status: 'finished' });
        const activeGames = await LudoRoom.countDocuments({ status: { $in: ['waiting', 'playing'] } });
        const allFinished = await LudoRoom.find({ status: 'finished' });

        const stats = {
            totalGames,
            activeGames,
            totalCommission: allFinished.reduce((sum, g) => sum + (g.adminCommission || 0), 0),
            totalPrizeDistributed: allFinished.reduce((sum, g) => sum + (g.prizeAmount || 0), 0),
            totalBetVolume: allFinished.reduce((sum, g) => sum + (g.betAmount * 2), 0)
        };
        res.json(stats);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
