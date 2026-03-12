const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    fullName: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    phoneNumber: {
        type: String,
        required: true
    },
    password: {
        type: String,
        required: true
    },
    walletBalance: {
        type: Number,
        default: 0
    },
    avatar: {
        type: String,
        default: ""
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    refreshToken: {
        type: String,
        default: null
    },
    resetPasswordOTP: String,
    resetPasswordExpires: Date,
    withdrawalMethods: {
        bank: {
            accountHolder: { type: String, default: "" },
            accountNumber: { type: String, default: "" },
            ifsc: { type: String, default: "" },
            bankName: { type: String, default: "" }
        },
        upi: {
            upiId: { type: String, default: "" }
        },
        mobile: {
            paytm: { type: String, default: "" },
            phonepe: { type: String, default: "" },
            gpay: { type: String, default: "" }
        }
    },
    referralCode: {
        type: String,
        unique: true
    },
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    referralCount: {
        type: Number,
        default: 0
    },
    referralEarnings: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('User', UserSchema);
