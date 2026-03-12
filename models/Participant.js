const mongoose = require('mongoose');

const ParticipantSchema = new mongoose.Schema({
    slotId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Slot',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    roundNumber: {
        type: Number,
        required: true
    },
    joinedAt: {
        type: Date,
        default: Date.now
    }
});

// Prevent same user joining same slot in same round
ParticipantSchema.index({ slotId: 1, userId: 1, roundNumber: 1 }, { unique: true });

module.exports = mongoose.model('Participant', ParticipantSchema);
