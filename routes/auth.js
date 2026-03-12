const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const auth = require('../middleware/auth');

// Setup Helper for SMTP
const createTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });
};

const Transaction = require('../models/Transaction');

// Helper: Generate tokens
const generateTokens = (userId) => {
    const accessToken = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '1d' });
    const refreshToken = jwt.sign({ id: userId, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return { accessToken, refreshToken };
};

// Register Route
router.post('/register', async (req, res) => {
    try {
        const { fullName, email, phoneNumber, password, referralCode } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ message: 'User already exists' });

        const hashedPassword = await bcrypt.hash(password, 12);

        // Generate unique referral code for new user
        const newReferralCode = 'CITY' + Math.random().toString(36).substring(2, 8).toUpperCase();

        const newUser = new User({
            fullName,
            email,
            phoneNumber,
            password: hashedPassword,
            referralCode: newReferralCode
        });

        // Handle referral logic if code provided
        if (referralCode) {
            const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
            if (referrer) {
                newUser.referredBy = referrer._id;
                // Reward logic: Give bonus to BOTH (e.g. 10 rupees each)
                newUser.walletBalance += 10;
                referrer.referralCount += 1;
                referrer.walletBalance += 10;
                referrer.referralEarnings += 10;

                // Create Transaction record for Referrer
                await new Transaction({
                    userId: referrer._id,
                    title: `Referral Bonus: ${fullName}`,
                    amount: 10,
                    type: 'bonus',
                    status: 'Success'
                }).save();

                // Create Transaction record for New User
                await new Transaction({
                    userId: newUser._id,
                    title: `Welcome Bonus (Referral)`,
                    amount: 10,
                    type: 'bonus',
                    status: 'Success'
                }).save();

                await referrer.save();
            }
        }

        await newUser.save();
        res.status(201).json({ message: 'User registered successfully', referralCode: newReferralCode });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Something went wrong during registration' });
    }
});

// Login Route — now returns both accessToken and refreshToken
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        const { accessToken, refreshToken } = generateTokens(user._id);

        // Store refresh token in DB
        user.refreshToken = refreshToken;
        await user.save();

        res.status(200).json({
            token: accessToken,
            refreshToken,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                phoneNumber: user.phoneNumber,
                walletBalance: user.walletBalance,
                avatar: user.avatar,
                isAdmin: user.isAdmin,
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                referralEarnings: user.referralEarnings
            }
        });

    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST api/auth/refresh-token
// @desc    Get a new access token using refresh token
// @access  Public (requires valid refresh token)
router.post('/refresh-token', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({ message: 'Refresh token required' });
        }

        // Verify refresh token
        let decoded;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
        } catch (jwtErr) {
            return res.status(401).json({ message: 'Invalid or expired refresh token. Please login again.' });
        }

        if (decoded.type !== 'refresh') {
            return res.status(401).json({ message: 'Invalid token type' });
        }

        // Check if refresh token matches what's stored in DB
        const user = await User.findById(decoded.id);
        if (!user || user.refreshToken !== refreshToken) {
            return res.status(401).json({ message: 'Refresh token revoked. Please login again.' });
        }

        // Generate new token pair
        const tokens = generateTokens(user._id);

        // Update stored refresh token (token rotation)
        user.refreshToken = tokens.refreshToken;
        await user.save();

        res.json({
            token: tokens.accessToken,
            refreshToken: tokens.refreshToken
        });

    } catch (error) {
        console.error('Refresh token error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Forgot Password Route - Step 1: Send OTP
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) return res.status(404).json({ message: 'User not found' });

        // Generate 6-digit numeric OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.resetPasswordOTP = otp;
        user.resetPasswordExpires = Date.now() + 600000; // 10 minutes expiry

        await user.save();

        const mailOptions = {
            to: user.email,
            from: process.env.EMAIL_USER,
            subject: 'City Loto - Your OTP for Password Reset',
            text: `Your OTP for resetting your password is: ${otp}. This OTP is valid for 10 minutes. 
                   If you did not request this, please ignore this email.`,
        };

        // Check if SMTP credentials exist before attempting to send
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.error('CRITICAL: Missing EMAIL_USER or EMAIL_PASS in .env file!');
            return res.status(500).json({ message: 'Mail server configuration missing' });
        }

        const transporter = createTransporter();

        transporter.sendMail(mailOptions, (err) => {
            if (err) {
                console.error('Mail Error detailed:', err);
                return res.status(500).json({ message: 'Error sending OTP email', error: err.message });
            }
            res.status(200).json({ message: 'OTP sent successfully!' });
        });

    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// Verify OTP - Step 2
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const user = await User.findOne({
            email,
            resetPasswordOTP: otp,
            resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ message: 'Invalid or expired OTP' });

        res.status(200).json({ message: 'OTP verified successfully' });

    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// Reset Password - Step 3
router.post('/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        const user = await User.findOne({
            email,
            resetPasswordOTP: otp,
            resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ message: 'Invalid or expired OTP' });

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        user.password = hashedPassword;

        // Clear OTP fields
        user.resetPasswordOTP = undefined;
        user.resetPasswordExpires = undefined;

        await user.save();

        res.status(200).json({ message: 'Password reset successfully' });

    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
