const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Setup Transporter for SMTP (Using Gmail Example)
const transporter = nodemailer.createTransport({
    service: 'gmail', // or your SMTP provider
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Register Route
router.post('/register', async (req, res) => {
    try {
        const { fullName, email, phoneNumber, password } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ message: 'User already exists' });

        const hashedPassword = await bcrypt.hash(password, 12);

        const newUser = new User({
            fullName,
            email,
            phoneNumber,
            password: hashedPassword
        });

        await newUser.save();
        res.status(201).json({ message: 'User registered successfully' });

    } catch (error) {
        res.status(500).json({ message: 'Something went wrong during registration' });
    }
});

// Login Route
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });

        res.status(200).json({ token, user: { id: user._id, fullName: user.fullName, email: user.email, walletBalance: user.walletBalance } });

    } catch (error) {
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

        transporter.sendMail(mailOptions, (err) => {
            if (err) {
                console.error('Mail Error:', err);
                return res.status(500).json({ message: 'Error sending OTP email' });
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
