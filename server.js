require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const lotteryRoutes = require('./routes/lottery');
const tictactoeRoutes = require('./routes/tictactoe');
const ludoRoutes = require('./routes/ludo');
const setupLudoSocket = require('./sockets/ludoSocket');

const app = express();
const server = http.createServer(app);

// Socket.IO setup with CORS
const io = socketIO(server, {
    cors: {
        origin: "*", // In production, specify your React Native app's origin
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/lottery', lotteryRoutes);
app.use('/api/tictactoe', tictactoeRoutes);
app.use('/api/ludo', ludoRoutes);

// Setup Socket.IO for Ludo
setupLudoSocket(io);

// Database Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('MongoDB Connected Successfully');

        // STARTUP RECOVERY: Reset any stuck slots that were left in
        // 'Completed' or 'Drawing' state due to server restart
        try {
            const Slot = require('./models/Slot');

            // Reset completed slots that have autoReset enabled
            const completedReset = await Slot.updateMany(
                { status: 'Completed', autoReset: true },
                { $set: { status: 'Active', currentJoined: 0 }, $inc: { roundNumber: 1 } }
            );
            if (completedReset.modifiedCount > 0) {
                console.log(`🔄 Recovered ${completedReset.modifiedCount} stuck 'Completed' slot(s) → Active`);
            }

            // Reset stuck 'Drawing' slots back to 'Full' for admin investigation
            const drawingReset = await Slot.updateMany(
                { status: 'Drawing' },
                { $set: { status: 'Full' } }
            );
            if (drawingReset.modifiedCount > 0) {
                console.log(`⚠️ Recovered ${drawingReset.modifiedCount} stuck 'Drawing' slot(s) → Full (needs admin review)`);
            }
        } catch (recoveryErr) {
            console.error('Startup recovery error:', recoveryErr);
        }
    })
    .catch((err) => console.log('MongoDB Connection Failed: ', err));

// Basic Route for testing
app.get('/', (req, res) => {
    res.send('City Loto Server is Running with Socket.IO...');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Socket.IO is ready for real-time connections`);
});
