const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const crypto = require('crypto');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');

const createAdmin = async () => {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB...');

        const adminEmail = 'admin@cityloto.com';
        const adminPass = 'admin123';

        // Check if admin exists
        let user = await User.findOne({ email: adminEmail });
        if (user) {
            console.log('Admin user already exists. Updating to admin status...');
            user.isAdmin = true;
            await user.save();
            console.log('User updated to admin successfully.');
            process.exit(0);
        }

        // Generate referral code
        const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(adminPass, salt);

        // Create Admin
        user = new User({
            fullName: 'Platform Admin',
            email: adminEmail,
            phoneNumber: '9999999999',
            password: hashedPassword,
            isAdmin: true,
            referralCode: referralCode,
            walletBalance: 0
        });

        await user.save();
        console.log('====================================');
        console.log('Admin Credentials Created Successfully!');
        console.log(`Email: ${adminEmail}`);
        console.log(`Password: ${adminPass}`);
        console.log('====================================');

        process.exit(0);
    } catch (err) {
        console.error('Error creating admin:', err.message);
        process.exit(1);
    }
};

createAdmin();
