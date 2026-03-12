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

// ============================================
//  ADMIN ROUTES
// ============================================
const admin = require('../middleware/admin');
const Slot = require('../models/Slot');
const Winning = require('../models/Winning');
const TicTacToeRoom = require('../models/TicTacToeRoom');

// @route   GET api/user/admin/all-users
// @desc    Get all users
// @access  Admin
router.get('/admin/all-users', auth, admin, async (req, res) => {
    try {
        const users = await User.find({ isAdmin: { $ne: true } })
            .select('-password -resetPasswordOTP -resetPasswordExpires -refreshToken')
            .sort({ createdAt: -1 });
        res.json(users);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   PUT api/user/admin/update-user/:id
// @desc    Update user (balance, admin status, etc.)
// @access  Admin
router.put('/admin/update-user/:id', auth, admin, async (req, res) => {
    try {
        const { walletBalance, isAdmin, fullName, phoneNumber } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (walletBalance !== undefined) user.walletBalance = walletBalance;
        if (isAdmin !== undefined) user.isAdmin = isAdmin;
        if (fullName) user.fullName = fullName;
        if (phoneNumber) user.phoneNumber = phoneNumber;

        await user.save();

        // Log if balance was changed
        if (walletBalance !== undefined) {
            await new Transaction({
                userId: user._id,
                title: `Admin Adjustment`,
                amount: walletBalance,
                type: 'bonus',
                status: 'Success'
            }).save();
        }

        res.json({ message: 'User updated', user });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/user/admin/dashboard
// @desc    Get platform-wide dashboard stats
// @access  Admin
router.get('/admin/dashboard', auth, admin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments({ isAdmin: { $ne: true } });
        const totalBalanceData = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$walletBalance' } } }
        ]);
        const totalBalance = totalBalanceData.length > 0 ? totalBalanceData[0].total : 0;

        // Lottery stats
        const lotteryWinnings = await Winning.find();
        const lotteryCommission = lotteryWinnings.reduce((s, w) => s + (w.adminCommission || 0), 0);
        const lotteryPrizes = lotteryWinnings.reduce((s, w) => s + (w.totalPrize || 0), 0);
        const activeSlots = await Slot.countDocuments({ status: 'Active' });

        // TicTacToe stats
        const tttFinished = await TicTacToeRoom.find({ status: 'finished' });
        const tttCommission = tttFinished.reduce((s, g) => s + (g.adminCommission || 0), 0);
        const tttActiveRooms = await TicTacToeRoom.countDocuments({ status: { $in: ['waiting', 'playing'] } });

        // Transactions
        const totalTransactions = await Transaction.countDocuments();
        const recentTransactions = await Transaction.find()
            .populate('userId', 'fullName email')
            .sort({ createdAt: -1 })
            .limit(10);

        res.json({
            totalUsers,
            totalWalletBalance: totalBalance,
            lottery: {
                totalDraws: lotteryWinnings.length,
                totalCommission: lotteryCommission,
                totalPrizes: lotteryPrizes,
                activeSlots,
            },
            tictactoe: {
                totalGames: tttFinished.length,
                totalCommission: tttCommission,
                activeRooms: tttActiveRooms,
            },
            totalCommission: lotteryCommission + tttCommission,
            transactionCount: totalTransactions,
            recentTransactions,
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET api/user/admin/all-transactions
// @desc    Get all platform transactions
// @access  Admin
router.get('/admin/all-transactions', auth, admin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const total = await Transaction.countDocuments();
        const transactions = await Transaction.find()
            .populate('userId', 'fullName email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
