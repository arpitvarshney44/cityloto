/**
 * Socket.IO Handler for Ludo Game
 * Real-time game communication
 */

const GameManager = require('../game/GameManager');
const LudoRoom = require('../models/LudoRoom');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const GameSettings = require('../models/GameSettings');

async function getSettings() {
    let settings = await GameSettings.findOne({ game: 'ludo' });
    if (!settings) {
        settings = await new GameSettings({
            game: 'ludo',
            winPercentage: 90,
            minBet: 10,
            maxBet: 5000
        }).save();
    }
    return settings;
}

async function endGame(roomId, winnerId, resultStr, reason) {
    try {
        const room = await LudoRoom.findById(roomId);
        if (!room || room.status === 'finished') return;

        const settings = await getSettings();
        const totalPool = room.betAmount * 2;
        const commissionRate = (100 - settings.winPercentage) / 100;
        const adminCommission = Math.floor(totalPool * commissionRate);
        const prizeAmount = totalPool - adminCommission;

        await User.findByIdAndUpdate(winnerId, { $inc: { walletBalance: prizeAmount } });

        let reasonTxt = reason === 'forfeit' ? ' (Forfeit)' : reason === 'timeout' ? ' (Timeout)' : '';
        await new Transaction({
            userId: winnerId,
            title: `🏆 Won Ludo${reasonTxt} — Room ${room.roomCode}`,
            amount: prizeAmount,
            type: 'win',
            status: 'Success'
        }).save();

        room.winner = winnerId;
        room.result = resultStr;
        room.prizeAmount = prizeAmount;
        room.adminCommission = adminCommission;
        room.status = 'finished';
        await room.save();

        return { prizeAmount, adminCommission };
    } catch (err) {
        console.error('End Game Error:', err);
        throw err;
    }
}

function setupLudoSocket(io) {
    const ludoNamespace = io.of('/ludo');
    const roomTimers = new Map(); // roomCode -> Interval

    // Periodically check for turn timeouts
    setInterval(async () => {
        const activeRooms = GameManager.getAllRoomCodes();
        for (const roomCode of activeRooms) {
            try {
                const game = GameManager.getGame(roomCode);
                const room = await LudoRoom.findOne({ roomCode, status: 'playing' });
                
                if (game && room && room.lastMoveAt) {
                    const now = new Date();
                    const secondsPassed = (now - new Date(room.lastMoveAt)) / 1000;
                    
                    if (secondsPassed >= 15.5) { // 0.5s buffer
                        console.log(`[Ludo] Turn timeout for room ${roomCode}, Player ${game.state.chancePlayer}`);
                        
                        // Pass turn automatically
                        game.passTurn();
                        
                        // Update DB
                        room.gameState = game.getState();
                        room.lastMoveAt = new Date();
                        await room.save();
                        
                        // Broadcast timeout event
                        ludoNamespace.to(roomCode).emit('turn-timeout', {
                            state: game.getState(),
                            previousPlayer: game.state.chancePlayer === 1 ? 3 : 1
                        });
                        
                        // Also sync state
                        ludoNamespace.to(roomCode).emit('game-state', {
                            state: game.getState(),
                            room: {
                                roomCode: room.roomCode,
                                player1: room.player1,
                                player2: room.player2,
                                status: room.status
                            }
                        });
                    }
                }
            } catch (err) {
                console.error(`Timeout check error for room ${roomCode}:`, err);
            }
        }
    }, 2000); // Check every 2 seconds

    ludoNamespace.on('connection', (socket) => {
        console.log(`[Ludo] Client connected: ${socket.id}`);

        // Join a game room
        socket.on('join-room', async ({ roomCode, userId }) => {
            try {
                console.log(`[Ludo] User ${userId} joining room ${roomCode}`);

                // Validate room exists
                const room = await LudoRoom.findOne({ roomCode: roomCode.toUpperCase() })
                    .populate('player1', 'fullName avatar')
                    .populate('player2', 'fullName avatar');

                if (!room) {
                    socket.emit('error', { message: 'Room not found' });
                    return;
                }

                // Check if user is part of this room
                const isPlayer1 = room.player1._id.toString() === userId;
                const isPlayer2 = room.player2?._id?.toString() === userId;

                if (!isPlayer1 && !isPlayer2) {
                    socket.emit('error', { message: 'You are not part of this room' });
                    return;
                }

                // Join socket room
                socket.join(roomCode);
                socket.roomCode = roomCode;
                socket.userId = userId;
                socket.playerNo = isPlayer1 ? 1 : 2;

                console.log(`[Ludo] User ${userId} joined room ${roomCode} as Player ${socket.playerNo}`);

                // If game is playing, create/get game instance
                if (room.status === 'playing') {
                    let game = GameManager.getGame(roomCode);
                    
                    if (!game) {
                        // Create game instance from saved state or fresh
                        game = GameManager.createGame(
                            roomCode,
                            room.player1._id,
                            room.player2._id,
                            room.betAmount
                        );

                        // Restore state if exists
                        if (room.gameState) {
                            game.setState(room.gameState);
                            console.log(`[Ludo] Restored game state for room ${roomCode}`);
                        }
                    }

                    // Send current game state
                    socket.emit('game-state', {
                        state: game.getState(),
                        room: {
                            roomCode: room.roomCode,
                            player1: room.player1,
                            player2: room.player2,
                            betAmount: room.betAmount,
                            status: room.status
                        },
                        playerNo: socket.playerNo
                    });
                } else {
                    // Send room info for waiting/finished states
                    socket.emit('room-info', {
                        room: {
                            roomCode: room.roomCode,
                            player1: room.player1,
                            player2: room.player2,
                            betAmount: room.betAmount,
                            status: room.status,
                            winner: room.winner
                        },
                        playerNo: socket.playerNo
                    });
                }

                // Notify other player that someone joined
                socket.to(roomCode).emit('player-joined', {
                    playerNo: socket.playerNo,
                    userId,
                    roomStatus: room.status
                });

                // If game just started (status is playing and player2 just joined)
                if (room.status === 'playing' && isPlayer2) {
                    console.log(`[Ludo] Game starting, creating game instance for room ${roomCode}`);
                    
                    // Create game instance
                    const game = GameManager.createGame(
                        roomCode,
                        room.player1._id,
                        room.player2._id,
                        room.betAmount
                    );

                    // Broadcast game-state to both players
                    ludoNamespace.to(roomCode).emit('game-state', {
                        state: game.getState(),
                        room: {
                            roomCode: room.roomCode,
                            player1: room.player1,
                            player2: room.player2,
                            betAmount: room.betAmount,
                            status: room.status
                        }
                    });
                }

            } catch (error) {
                console.error('[Ludo] Join room error:', error);
                socket.emit('error', { message: 'Failed to join room' });
            }
        });

        // Roll dice
        socket.on('roll-dice', async () => {
            try {
                const { roomCode, userId } = socket;
                if (!roomCode || !userId) {
                    socket.emit('error', { message: 'Not in a room' });
                    return;
                }

                const game = GameManager.getGame(roomCode);
                if (!game) {
                    socket.emit('error', { message: 'Game not found' });
                    return;
                }

                console.log(`[Ludo] Player ${socket.playerNo} rolling dice in room ${roomCode}`);

                // Server rolls dice and validates
                const result = game.rollDice(userId);

                // Save state to database
                await LudoRoom.findOneAndUpdate(
                    { roomCode: roomCode.toUpperCase() },
                    { 
                        $set: { gameState: game.getState(), lastMoveAt: new Date() },
                        $inc: { moveCount: 1 }
                    }
                );

                // Broadcast to both players
                ludoNamespace.to(roomCode).emit('dice-rolled', {
                    diceNo: result.diceNo,
                    canMove: result.canMove,
                    autoPassTurn: result.autoPassTurn,
                    state: result.state
                });

                console.log(`[Ludo] Dice rolled: ${result.diceNo}, canMove: ${result.canMove}, autoPass: ${result.autoPassTurn}`);

            } catch (error) {
                console.error('[Ludo] Roll dice error:', error);
                socket.emit('error', { message: error.message || 'Failed to roll dice' });
            }
        });

        // Bring out piece (from home with 6)
        socket.on('bring-out-piece', async ({ pieceId, startPos }) => {
            try {
                const { roomCode, userId } = socket;
                if (!roomCode || !userId) {
                    socket.emit('error', { message: 'Not in a room' });
                    return;
                }

                const game = GameManager.getGame(roomCode);
                if (!game) {
                    socket.emit('error', { message: 'Game not found' });
                    return;
                }

                console.log(`[Ludo] Player ${socket.playerNo} bringing out piece ${pieceId}`);

                // Server validates and processes
                const result = game.bringOutPiece(userId, pieceId, startPos);

                // Save state
                await LudoRoom.findOneAndUpdate(
                    { roomCode: roomCode.toUpperCase() },
                    { 
                        $set: { gameState: game.getState(), lastMoveAt: new Date() },
                        $inc: { moveCount: 1 }
                    }
                );

                // Broadcast to both players
                ludoNamespace.to(roomCode).emit('piece-brought-out', {
                    pieceId,
                    startPos,
                    state: result.state
                });

            } catch (error) {
                console.error('[Ludo] Bring out piece error:', error);
                socket.emit('error', { message: error.message || 'Failed to bring out piece' });
            }
        });

        // Move piece
        socket.on('move-piece', async ({ pieceId }) => {
            try {
                const { roomCode, userId } = socket;
                if (!roomCode || !userId) {
                    socket.emit('error', { message: 'Not in a room' });
                    return;
                }

                const game = GameManager.getGame(roomCode);
                if (!game) {
                    socket.emit('error', { message: 'Game not found' });
                    return;
                }

                console.log(`[Ludo] Player ${socket.playerNo} moving piece ${pieceId}`);

                // Server validates and processes move
                const result = game.movePiece(userId, pieceId);

                // Save state
                await LudoRoom.findOneAndUpdate(
                    { roomCode: roomCode.toUpperCase() },
                    { 
                        $set: { gameState: game.getState(), lastMoveAt: new Date() },
                        $inc: { moveCount: 1 }
                    }
                );

                // Check if game ended
                if (result.winner) {
                    const room = await LudoRoom.findOne({ roomCode: roomCode.toUpperCase() });
                    const winnerId = result.winner === 1 ? room.player1 : room.player2;
                    const resultStr = result.winner === 1 ? 'player1' : 'player2';
                    
                    const gameResult = await endGame(room._id, winnerId, resultStr, 'game');

                    // Broadcast game over
                    ludoNamespace.to(roomCode).emit('game-over', {
                        winner: result.winner,
                        state: result.state,
                        prizeAmount: gameResult.prizeAmount
                    });

                    // Remove game from memory
                    GameManager.removeGame(roomCode);

                    console.log(`[Ludo] Game ${roomCode} ended, winner: Player ${result.winner}`);
                } else {
                    // Broadcast move to both players
                    ludoNamespace.to(roomCode).emit('piece-moved', {
                        pieceId,
                        newPos: result.newPos,
                        newTravelCount: result.newTravelCount,
                        collision: result.collision,
                        state: result.state
                    });
                }

            } catch (error) {
                console.error('[Ludo] Move piece error:', error);
                socket.emit('error', { message: error.message || 'Failed to move piece' });
            }
        });

        // Forfeit game
        socket.on('forfeit', async () => {
            try {
                const { roomCode, userId } = socket;
                if (!roomCode || !userId) {
                    socket.emit('error', { message: 'Not in a room' });
                    return;
                }

                const room = await LudoRoom.findOne({ roomCode: roomCode.toUpperCase(), status: 'playing' });
                if (!room) {
                    socket.emit('error', { message: 'Game not active' });
                    return;
                }

                const isPlayer1 = room.player1.toString() === userId;
                const winnerId = isPlayer1 ? room.player2 : room.player1;
                const resultStr = isPlayer1 ? 'player2' : 'player1';
                const winnerNo = isPlayer1 ? 2 : 1;

                const gameResult = await endGame(room._id, winnerId, resultStr, 'forfeit');

                // Broadcast forfeit
                ludoNamespace.to(roomCode).emit('game-over', {
                    winner: winnerNo,
                    reason: 'forfeit',
                    forfeitedBy: socket.playerNo,
                    prizeAmount: gameResult.prizeAmount
                });

                // Remove game from memory
                GameManager.removeGame(roomCode);

                console.log(`[Ludo] Player ${socket.playerNo} forfeited room ${roomCode}`);

            } catch (error) {
                console.error('[Ludo] Forfeit error:', error);
                socket.emit('error', { message: 'Failed to forfeit' });
            }
        });

        // Disconnect
        socket.on('disconnect', () => {
            console.log(`[Ludo] Client disconnected: ${socket.id}`);
            
            if (socket.roomCode) {
                socket.to(socket.roomCode).emit('player-disconnected', {
                    playerNo: socket.playerNo
                });
            }
        });
    });

    console.log('[Ludo] Socket.IO namespace initialized: /ludo');
}

module.exports = setupLudoSocket;
