const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');

// @route   GET api/user/transactions
// @desc    Get user transactions
// @access  Private
router.get('/transactions', auth, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json(transactions);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/user/leaderboard
// @desc    Get top users for leaderboard
// @access  Public
router.get('/leaderboard', async (req, res) => {
    try {
        const { timeframe } = req.query;
        let startDate = new Date();

        if (timeframe === 'Daily') {
            startDate.setHours(0, 0, 0, 0);
        } else if (timeframe === 'Weekly') {
            startDate.setDate(startDate.getDate() - 7);
        } else if (timeframe === 'Monthly') {
            startDate.setDate(startDate.getDate() - 30);
        } else {
            startDate = new Date(0);
        }

        const topUsers = await Transaction.aggregate([
            {
                $match: {
                    createdAt: { $gte: startDate },
                    type: { $in: ['win', 'bonus'] }
                }
            },
            {
                $group: {
                    _id: '$userId',
                    totalWon: { $sum: '$amount' }
                }
            },
            {
                $sort: { totalWon: -1 }
            },
            {
                $limit: 10
            },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            {
                $unwind: '$userInfo'
            },
            {
                $project: {
                    _id: 1,
                    fullName: '$userInfo.fullName',
                    avatar: '$userInfo.avatar',
                    walletBalance: '$totalWon'
                }
            }
        ]);

        if (topUsers.length === 0) {
            const fallbackUsers = await User.find()
                .select('fullName walletBalance avatar')
                .sort({ walletBalance: -1 })
                .limit(10);
            return res.json(fallbackUsers);
        }

        res.json(topUsers);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET api/user/me
// @desc    Get current user profile
// @access  Private
router.get('/me', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/user/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, async (req, res) => {
    const { fullName, phoneNumber, avatar } = req.body;

    try {
        let user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (fullName) user.fullName = fullName;
        if (phoneNumber) user.phoneNumber = phoneNumber;
        if (avatar !== undefined) user.avatar = avatar;

        await user.save();

        res.json({
            message: 'Profile updated successfully',
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phoneNumber: user.phoneNumber,
                walletBalance: user.walletBalance,
                avatar: user.avatar,
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                referralEarnings: user.referralEarnings
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT api/user/withdrawal-methods
// @desc    Update user withdrawal/payout methods
// @access  Private
router.put('/withdrawal-methods', auth, async (req, res) => {
    const { bank, upi, mobile } = req.body;

    try {
        let user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (bank) user.withdrawalMethods.bank = { ...user.withdrawalMethods.bank, ...bank };
        if (upi) user.withdrawalMethods.upi = { ...user.withdrawalMethods.upi, ...upi };
        if (mobile) user.withdrawalMethods.mobile = { ...user.withdrawalMethods.mobile, ...mobile };

        await user.save();

        res.json({
            message: 'Withdrawal methods updated successfully',
            withdrawalMethods: user.withdrawalMethods
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
