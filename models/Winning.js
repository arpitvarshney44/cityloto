const mongoose = require('mongoose');

const WinningSchema = new mongoose.Schema({
    slotId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Slot',
        required: true
    },
    roundNumber: {
        type: Number,
        required: true
    },
    winners: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        prizeAmount: {
            type: Number,
            required: true
        },
        position: {
            type: Number, // 1st, 2nd, 3rd winner
            required: true
        }
    }],
    totalCollection: {
        type: Number, // entryFee * totalCapacity
        required: true
    },
    totalPrize: {
        type: Number, // 90% of totalCollection (split among winners)
        required: true
    },
    adminCommission: {
        type: Number, // 10% of totalCollection
        required: true
    },
    totalParticipants: {
        type: Number,
        required: true
    },
    drawTime: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Winning', WinningSchema);
