const mongoose = require('mongoose');

const GameSettingsSchema = new mongoose.Schema({
    game: {
        type: String,
        required: true,
        unique: true,
        enum: ['tictactoe', 'ludo', 'snake_ladder']
    },
    winPercentage: {
        type: Number,
        default: 90,
        min: 50,
        max: 100
    },
    minBet: {
        type: Number,
        default: 10
    },
    maxBet: {
        type: Number,
        default: 5000
    },
    isActive: {
        type: Boolean,
        default: true
    },
    updatedBy: {
        type: String,
        default: 'system'
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('GameSettings', GameSettingsSchema);
