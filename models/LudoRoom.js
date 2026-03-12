const mongoose = require('mongoose');

const LudoRoomSchema = new mongoose.Schema({
    roomCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true
    },
    player1: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    player2: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    betAmount: {
        type: Number,
        required: true
    },
    gameState: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    status: {
        type: String,
        enum: ['waiting', 'playing', 'finished', 'cancelled', 'expired'],
        default: 'waiting'
    },
    winner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    result: {
        type: String,
        enum: ['player1', 'player2', null],
        default: null
    },
    prizeAmount: {
        type: Number,
        default: 0
    },
    adminCommission: {
        type: Number,
        default: 0
    },
    moveCount: {
        type: Number,
        default: 0
    },
    lastMoveAt: {
        type: Date,
        default: null
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 10 * 60 * 1000)
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

LudoRoomSchema.index({ roomCode: 1 });
LudoRoomSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('LudoRoom', LudoRoomSchema);
