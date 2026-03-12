/**
 * Game Manager - Manages all active Ludo games
 */

const LudoGame = require('./LudoGame');

class GameManager {
    constructor() {
        this.games = new Map(); // roomCode -> LudoGame instance
    }

    /**
     * Create a new game instance
     */
    createGame(roomCode, player1Id, player2Id, betAmount) {
        if (this.games.has(roomCode)) {
            console.log(`Game ${roomCode} already exists, returning existing instance`);
            return this.games.get(roomCode);
        }

        const game = new LudoGame(roomCode, player1Id, player2Id, betAmount);
        this.games.set(roomCode, game);
        
        console.log(`Created new game: ${roomCode}`);
        return game;
    }

    /**
     * Get an existing game
     */
    getGame(roomCode) {
        return this.games.get(roomCode);
    }

    /**
     * Remove a game (when finished)
     */
    removeGame(roomCode) {
        const deleted = this.games.delete(roomCode);
        if (deleted) {
            console.log(`Removed game: ${roomCode}`);
        }
        return deleted;
    }

    /**
     * Get all active games count
     */
    getActiveGamesCount() {
        return this.games.size;
    }

    /**
     * Get all room codes
     */
    getAllRoomCodes() {
        return Array.from(this.games.keys());
    }
}

// Export singleton instance
module.exports = new GameManager();
