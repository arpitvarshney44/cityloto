const mongoose = require('mongoose');

const SlotSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    entryFee: {
        type: Number,
        required: true
    },
    totalCapacity: {
        type: Number,
        required: true
    },
    currentJoined: {
        type: Number,
        default: 0
    },
    winnerCount: {
        type: Number,
        default: 3,
        min: 1
    },
    prizePercentage: {
        type: Number,
        default: 90 // 90% to winners, 10% admin commission
    },
    status: {
        type: String,
        enum: ['Active', 'Full', 'Drawing', 'Completed', 'Disabled'],
        default: 'Active'
    },
    tier: {
        type: String,
        enum: ['Micro', 'Standard', 'Premium'],
        default: 'Micro'
    },
    autoReset: {
        type: Boolean,
        default: true // Automatically reset after draw
    },
    roundNumber: {
        type: Number,
        default: 1
    },
    createdBy: {
        type: String, // admin identifier
        default: 'system'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Slot', SlotSchema);
