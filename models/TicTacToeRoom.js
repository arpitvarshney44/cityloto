const mongoose = require('mongoose');

const TicTacToeRoomSchema = new mongoose.Schema({
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
    board: {
        type: [String], // Array of 9: '', 'X', 'O'
        default: ['', '', '', '', '', '', '', '', '']
    },
    currentTurn: {
        type: String,
        enum: ['X', 'O'],
        default: 'X' // Player 1 is always X, goes first
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
        enum: ['player1', 'player2', 'draw', null],
        default: null
    },
    winningLine: {
        type: [Number], // The 3 indices of the winning combination
        default: []
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
        default: () => new Date(Date.now() + 10 * 60 * 1000) // 10 min room expiry
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Index for fast room lookups
TicTacToeRoomSchema.index({ roomCode: 1 });
TicTacToeRoomSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('TicTacToeRoom', TicTacToeRoomSchema);
