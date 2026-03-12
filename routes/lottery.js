const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Slot = require('../models/Slot');
const Participant = require('../models/Participant');
const Winning = require('../models/Winning');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

// ============================================
//  PLAYER ROUTES (Authenticated)
// ============================================

// @route   GET api/lottery/slots
// @desc    Get all active lottery slots
// @access  Private
router.get('/slots', auth, async (req, res) => {
    try {
        const slots = await Slot.find({ status: { $in: ['Active', 'Full'] } })
            .sort({ entryFee: 1 });
        res.json(slots);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/lottery/slot/:slotId
// @desc    Get single slot details with participants
// @access  Private
router.get('/slot/:slotId', auth, async (req, res) => {
    try {
        const slot = await Slot.findById(req.params.slotId);
        if (!slot) return res.status(404).json({ message: 'Slot not found' });

        // Check if current user has already joined this round
        const hasJoined = await Participant.findOne({
            slotId: slot._id,
            userId: req.user.id,
            roundNumber: slot.roundNumber
        });

        // Get recent participants for this round
        const participants = await Participant.find({
            slotId: slot._id,
            roundNumber: slot.roundNumber
        })
            .populate('userId', 'fullName avatar')
            .sort({ joinedAt: -1 })
            .limit(20);

        res.json({
            slot,
            hasJoined: !!hasJoined,
            participants: participants.map(p => ({
                name: p.userId?.fullName || 'Anonymous',
                avatar: p.userId?.avatar || '',
                joinedAt: p.joinedAt
            }))
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/lottery/join
// @desc    Join a lottery slot (pay entry fee from wallet)
// @access  Private
// FIX: Uses atomic MongoDB operations to prevent race conditions
router.post('/join', auth, async (req, res) => {
    try {
        const { slotId } = req.body;
        if (!slotId) return res.status(400).json({ message: 'Slot ID required' });

        const slot = await Slot.findById(slotId);
        if (!slot) return res.status(404).json({ message: 'Slot not found' });

        if (slot.status !== 'Active') {
            return res.status(400).json({ message: 'This slot is not accepting entries right now' });
        }

        // Check if user already joined this round
        const alreadyJoined = await Participant.findOne({
            slotId: slot._id,
            userId: req.user.id,
            roundNumber: slot.roundNumber
        });
        if (alreadyJoined) {
            return res.status(400).json({ message: 'You have already joined this round' });
        }

        // STEP 1: Atomically reserve a spot in the slot FIRST
        // This prevents race conditions — only one request can grab each spot
        const updatedSlot = await Slot.findOneAndUpdate(
            {
                _id: slotId,
                status: 'Active',
                currentJoined: { $lt: slot.totalCapacity }
            },
            { $inc: { currentJoined: 1 } },
            { new: true }
        );

        if (!updatedSlot) {
            return res.status(400).json({ message: 'Slot is full or no longer active' });
        }

        // STEP 2: Atomically deduct entry fee from wallet
        // Only deducts if user has sufficient balance
        const updatedUser = await User.findOneAndUpdate(
            {
                _id: req.user.id,
                walletBalance: { $gte: slot.entryFee }
            },
            { $inc: { walletBalance: -slot.entryFee } },
            { new: true }
        );

        if (!updatedUser) {
            // ROLLBACK: Undo the slot increment since wallet deduction failed
            await Slot.findByIdAndUpdate(slotId, { $inc: { currentJoined: -1 } });
            return res.status(400).json({ message: `Insufficient balance. You need ₹${slot.entryFee} to join.` });
        }

        // STEP 3: Create entry fee transaction
        await new Transaction({
            userId: updatedUser._id,
            title: `Entry Fee: ${slot.name} (Round #${slot.roundNumber})`,
            amount: slot.entryFee,
            type: 'deduction',
            status: 'Success'
        }).save();

        // STEP 4: Add participant record
        try {
            await new Participant({
                slotId: slot._id,
                userId: updatedUser._id,
                roundNumber: slot.roundNumber
            }).save();
        } catch (participantErr) {
            // ROLLBACK: Undo slot increment and refund wallet
            await Slot.findByIdAndUpdate(slotId, { $inc: { currentJoined: -1 } });
            await User.findByIdAndUpdate(req.user.id, { $inc: { walletBalance: slot.entryFee } });
            if (participantErr.code === 11000) {
                return res.status(400).json({ message: 'You have already joined this round' });
            }
            throw participantErr;
        }

        // STEP 5: Check if slot is now full → trigger draw
        if (updatedSlot.currentJoined >= updatedSlot.totalCapacity) {
            await Slot.findByIdAndUpdate(slotId, { status: 'Full' });

            // Trigger draw in background (don't block response)
            setImmediate(() => performDraw(slot._id));

            return res.json({
                message: `Joined successfully! Slot is full — Draw starting now! 🎉`,
                joined: updatedSlot.currentJoined,
                total: updatedSlot.totalCapacity,
                walletBalance: updatedUser.walletBalance,
                drawTriggered: true
            });
        }

        res.json({
            message: `Joined ${slot.name} successfully! 🎰`,
            joined: updatedSlot.currentJoined,
            total: updatedSlot.totalCapacity,
            walletBalance: updatedUser.walletBalance,
            drawTriggered: false
        });

    } catch (err) {
        console.error('Join Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/lottery/my-entries
// @desc    Get user's active lottery entries
// @access  Private
router.get('/my-entries', auth, async (req, res) => {
    try {
        const entries = await Participant.find({ userId: req.user.id })
            .populate('slotId', 'name entryFee totalCapacity currentJoined status roundNumber tier')
            .sort({ joinedAt: -1 })
            .limit(50);

        res.json(entries);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/lottery/results
// @desc    Get public draw results (transparency log)
// @access  Public
router.get('/results', async (req, res) => {
    try {
        const results = await Winning.find()
            .populate('slotId', 'name entryFee totalCapacity tier')
            .populate('winners.userId', 'fullName avatar')
            .sort({ drawTime: -1 })
            .limit(30);

        res.json(results);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ============================================
//  DRAW LOGIC (CSPRNG - Cryptographically Secure)
// ============================================
async function performDraw(slotId) {
    try {
        const slot = await Slot.findById(slotId);
        if (!slot) return console.error('Draw Error: Slot not found');

        slot.status = 'Drawing';
        await slot.save();

        // Get all participants for this round
        const participants = await Participant.find({
            slotId: slot._id,
            roundNumber: slot.roundNumber
        });

        if (participants.length === 0) {
            console.error('Draw Error: No participants found');
            slot.status = 'Active';
            await slot.save();
            return;
        }

        // Calculate prize pool
        const totalCollection = slot.entryFee * participants.length;
        const commissionRate = (100 - slot.prizePercentage) / 100; // 10%
        const adminCommission = Math.floor(totalCollection * commissionRate);
        const totalPrize = totalCollection - adminCommission;

        // Determine number of winners (min of winnerCount and participants)
        const winnerCount = Math.min(slot.winnerCount, participants.length);

        // CSPRNG: Select winners randomly
        const shuffled = [...participants];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const randomBytes = crypto.randomBytes(4);
            const j = randomBytes.readUInt32BE(0) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const selectedWinners = shuffled.slice(0, winnerCount);

        // Split prize among winners (equal split)
        const perWinnerPrize = Math.floor(totalPrize / winnerCount);

        // Create winning record
        const winnersData = [];
        for (let i = 0; i < selectedWinners.length; i++) {
            const winner = selectedWinners[i];

            // Credit prize to winner's wallet (atomic)
            await User.findByIdAndUpdate(winner.userId, {
                $inc: { walletBalance: perWinnerPrize }
            });

            // Create winning transaction
            await new Transaction({
                userId: winner.userId,
                title: `🏆 Won ${slot.name} (Round #${slot.roundNumber}) — Position #${i + 1}`,
                amount: perWinnerPrize,
                type: 'win',
                status: 'Success'
            }).save();

            winnersData.push({
                userId: winner.userId,
                prizeAmount: perWinnerPrize,
                position: i + 1
            });
        }

        // Save winning record (transparency log)
        await new Winning({
            slotId: slot._id,
            roundNumber: slot.roundNumber,
            winners: winnersData,
            totalCollection,
            totalPrize,
            adminCommission,
            totalParticipants: participants.length
        }).save();

        // Mark slot completed
        slot.status = 'Completed';
        await slot.save();

        // Auto-reset if enabled (the startup recovery in server.js handles crash cases)
        if (slot.autoReset) {
            setTimeout(async () => {
                try {
                    await Slot.findByIdAndUpdate(slot._id, {
                        $set: { status: 'Active', currentJoined: 0 },
                        $inc: { roundNumber: 1 }
                    });
                    console.log(`Slot "${slot.name}" reset for Round #${slot.roundNumber + 1}`);
                } catch (e) {
                    console.error('Auto-reset error:', e);
                }
            }, 5000); // 5 second delay before reset
        }

        console.log(`✅ Draw completed for "${slot.name}" Round #${slot.roundNumber} — ${winnerCount} winners, ₹${perWinnerPrize} each`);

    } catch (err) {
        console.error('Draw Error:', err);
        // Recovery: set slot back to Full so admin can investigate
        try {
            await Slot.findByIdAndUpdate(slotId, { status: 'Full' });
        } catch (e) { }
    }
}

// ============================================
//  ADMIN ROUTES (Protected with admin middleware)
// ============================================

// @route   POST api/lottery/admin/create-slot
// @desc    Create a new lottery slot (Admin)
// @access  Admin
router.post('/admin/create-slot', auth, admin, async (req, res) => {
    try {
        const { name, entryFee, totalCapacity, winnerCount, tier, prizePercentage, autoReset } = req.body;

        if (!name || !entryFee || !totalCapacity) {
            return res.status(400).json({ message: 'Name, Entry Fee, and Total Capacity are required' });
        }

        const slot = new Slot({
            name,
            entryFee,
            totalCapacity,
            winnerCount: winnerCount || 3,
            tier: tier || 'Micro',
            prizePercentage: prizePercentage || 90,
            autoReset: autoReset !== undefined ? autoReset : true,
            createdBy: req.user.id,
            status: 'Active'
        });

        await slot.save();
        res.status(201).json({ message: 'Slot created successfully', slot });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   PUT api/lottery/admin/update-slot/:slotId
// @desc    Update a lottery slot (Admin)
// @access  Admin
router.put('/admin/update-slot/:slotId', auth, admin, async (req, res) => {
    try {
        const { name, entryFee, totalCapacity, winnerCount, tier, prizePercentage, autoReset, status } = req.body;

        const slot = await Slot.findById(req.params.slotId);
        if (!slot) return res.status(404).json({ message: 'Slot not found' });

        // Only allow editing if slot is Active and no one has joined yet OR if it's Disabled
        if (slot.currentJoined > 0 && slot.status === 'Active') {
            // Only allow limited edits when people have joined
            if (name) slot.name = name;
            if (status === 'Disabled') slot.status = 'Disabled';
        } else {
            if (name) slot.name = name;
            if (entryFee) slot.entryFee = entryFee;
            if (totalCapacity) slot.totalCapacity = totalCapacity;
            if (winnerCount) slot.winnerCount = winnerCount;
            if (tier) slot.tier = tier;
            if (prizePercentage) slot.prizePercentage = prizePercentage;
            if (autoReset !== undefined) slot.autoReset = autoReset;
            if (status) slot.status = status;
        }

        await slot.save();
        res.json({ message: 'Slot updated', slot });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   DELETE api/lottery/admin/delete-slot/:slotId
// @desc    Delete/disable a lottery slot (Admin)
// @access  Admin
router.delete('/admin/delete-slot/:slotId', auth, admin, async (req, res) => {
    try {
        const slot = await Slot.findById(req.params.slotId);
        if (!slot) return res.status(404).json({ message: 'Slot not found' });

        if (slot.currentJoined > 0 && slot.status === 'Active') {
            // Can't delete if people have joined — just disable it
            slot.status = 'Disabled';
            await slot.save();
            return res.json({ message: 'Slot disabled (has active participants)' });
        }

        await Slot.findByIdAndDelete(req.params.slotId);
        res.json({ message: 'Slot deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/lottery/admin/all-slots
// @desc    Get ALL slots for admin (including disabled/completed)
// @access  Admin
router.get('/admin/all-slots', auth, admin, async (req, res) => {
    try {
        const slots = await Slot.find().sort({ createdAt: -1 });
        res.json(slots);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/lottery/admin/stats
// @desc    Get admin dashboard stats (total commission, slots, etc.)
// @access  Admin
router.get('/admin/stats', auth, admin, async (req, res) => {
    try {
        const totalWinnings = await Winning.find();

        const stats = {
            totalCommission: totalWinnings.reduce((sum, w) => sum + w.adminCommission, 0),
            totalDraws: totalWinnings.length,
            totalPrizeDistributed: totalWinnings.reduce((sum, w) => sum + w.totalPrize, 0),
            totalCollection: totalWinnings.reduce((sum, w) => sum + w.totalCollection, 0),
            activeSlots: await Slot.countDocuments({ status: 'Active' }),
            totalSlots: await Slot.countDocuments(),
        };

        res.json(stats);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   POST api/lottery/admin/force-draw/:slotId
// @desc    Manually trigger draw (Admin - for testing or emergencies)
// @access  Admin
router.post('/admin/force-draw/:slotId', auth, admin, async (req, res) => {
    try {
        const slot = await Slot.findById(req.params.slotId);
        if (!slot) return res.status(404).json({ message: 'Slot not found' });

        const participants = await Participant.countDocuments({
            slotId: slot._id,
            roundNumber: slot.roundNumber
        });

        if (participants < slot.winnerCount) {
            return res.status(400).json({
                message: `Need at least ${slot.winnerCount} participants to draw. Currently: ${participants}`
            });
        }

        slot.status = 'Full';
        await slot.save();

        // Trigger draw
        performDraw(slot._id);

        res.json({ message: 'Draw triggered manually', participants });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/lottery/admin/participants/:slotId
// @desc    Get all participants for a slot's current round
// @access  Admin
router.get('/admin/participants/:slotId', auth, admin, async (req, res) => {
    try {
        const slot = await Slot.findById(req.params.slotId);
        if (!slot) return res.status(404).json({ message: 'Slot not found' });

        const participants = await Participant.find({
            slotId: slot._id,
            roundNumber: slot.roundNumber
        })
            .populate('userId', 'fullName email phoneNumber avatar')
            .sort({ joinedAt: -1 });

        res.json({
            slotName: slot.name,
            roundNumber: slot.roundNumber,
            totalJoined: participants.length,
            capacity: slot.totalCapacity,
            participants
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
