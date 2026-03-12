/**
 * Server-Side Ludo Game Logic
 * All game rules and validations are handled here
 */

class LudoGame {
    constructor(roomCode, player1Id, player2Id, betAmount) {
        this.roomCode = roomCode;
        this.player1Id = player1Id.toString();
        this.player2Id = player2Id.toString();
        this.betAmount = betAmount;
        this.state = this.createInitialState();
    }

    createInitialState() {
        return {
            // Player 1 (Red) - Active
            player1: [
                { id: 'A1', pos: 0, travelCount: 0 },
                { id: 'A2', pos: 0, travelCount: 0 },
                { id: 'A3', pos: 0, travelCount: 0 },
                { id: 'A4', pos: 0, travelCount: 0 },
            ],
            // Player 2 (Green) - Not used in 2-player mode
            player2: [
                { id: 'B1', pos: 0, travelCount: 0 },
                { id: 'B2', pos: 0, travelCount: 0 },
                { id: 'B3', pos: 0, travelCount: 0 },
                { id: 'B4', pos: 0, travelCount: 0 },
            ],
            // Player 3 (Yellow) - Active (This is Player 2 in 2-player mode)
            player3: [
                { id: 'C1', pos: 0, travelCount: 0 },
                { id: 'C2', pos: 0, travelCount: 0 },
                { id: 'C3', pos: 0, travelCount: 0 },
                { id: 'C4', pos: 0, travelCount: 0 },
            ],
            // Player 4 (Blue) - Not used in 2-player mode
            player4: [
                { id: 'D1', pos: 0, travelCount: 0 },
                { id: 'D2', pos: 0, travelCount: 0 },
                { id: 'D3', pos: 0, travelCount: 0 },
                { id: 'D4', pos: 0, travelCount: 0 },
            ],
            chancePlayer: 1, // Red (Player 1) starts
            diceNo: 0,
            isDiceRolled: false,
            pileSelectionPlayer: -1,
            cellSelectionPlayer: -1,
            touchDiceBlock: false,
            currentPosition: [],
            fireworks: false,
            winner: null,
        };
    }

    /**
     * Roll dice - Server generates random number and validates turn
     */
    rollDice(playerId) {
        const playerNo = this.getPlayerNumber(playerId);
        
        // Validate it's this player's turn
        if (this.state.chancePlayer !== playerNo) {
            throw new Error('Not your turn');
        }

        if (this.state.isDiceRolled) {
            throw new Error('Dice already rolled');
        }

        // Generate dice number (1-6)
        const diceNo = Math.floor(Math.random() * 6) + 1;
        this.state.diceNo = diceNo;
        this.state.isDiceRolled = true;

        console.log(`Player ${playerNo} rolled ${diceNo}`);

        // Check if player can make any move
        const playerPieces = this.getPlayerPieces(playerNo);
        const isAnyPieceAlive = playerPieces.findIndex(e => e.pos !== 0 && e.travelCount < 57);
        const isAnyPieceLocked = playerPieces.findIndex(e => e.pos === 0);
        const canMoveAnyPiece = playerPieces.some(pile => pile.pos !== 0 && pile.travelCount + diceNo <= 57);
        const canBringOut = diceNo === 6 && isAnyPieceLocked !== -1;

        let canMove = false;
        let autoPassTurn = false;

        if (isAnyPieceAlive === -1) {
            // No pieces on board
            if (canBringOut) {
                canMove = true;
                this.state.pileSelectionPlayer = playerNo;
            } else {
                // Auto pass turn
                autoPassTurn = true;
            }
        } else {
            // Pieces on board
            if (canMoveAnyPiece || canBringOut) {
                canMove = true;
                if (canBringOut) this.state.pileSelectionPlayer = playerNo;
                if (canMoveAnyPiece) this.state.cellSelectionPlayer = playerNo;
            } else {
                // No valid moves
                autoPassTurn = true;
            }
        }

        if (autoPassTurn) {
            console.log(`Player ${playerNo} has no valid moves, auto-passing turn`);
            this.passTurn();
        }

        return {
            diceNo,
            canMove,
            autoPassTurn,
            state: this.state
        };
    }

    /**
     * Bring out a piece from home (only with 6)
     */
    bringOutPiece(playerId, pieceId, startPos) {
        const playerNo = this.getPlayerNumber(playerId);
        
        // Validate turn
        if (this.state.chancePlayer !== playerNo) {
            throw new Error('Not your turn');
        }

        if (!this.state.isDiceRolled) {
            throw new Error('Roll dice first');
        }

        if (this.state.diceNo !== 6) {
            throw new Error('Need 6 to bring out piece');
        }

        const playerKey = `player${playerNo}`;
        const piece = this.state[playerKey].find(p => p.id === pieceId);
        
        if (!piece || piece.pos !== 0) {
            throw new Error('Invalid piece');
        }

        // Update piece position
        piece.pos = startPos;
        piece.travelCount = 1;

        // Update current positions
        this.state.currentPosition.push({ id: pieceId, pos: startPos });

        console.log(`Player ${playerNo} brought out piece ${pieceId}`);

        // Player gets another turn for rolling 6
        this.state.isDiceRolled = false;
        this.state.pileSelectionPlayer = -1;
        this.state.cellSelectionPlayer = -1;

        return { state: this.state };
    }

    /**
     * Move a piece on the board
     * Destination is calculated on server to ensure consistency
     */
    movePiece(playerId, pieceId) {
        const playerNo = this.getPlayerNumber(playerId);
        
        // Validate turn
        if (this.state.chancePlayer !== playerNo) {
            throw new Error('Not your turn');
        }

        if (!this.state.isDiceRolled) {
            throw new Error('Roll dice first');
        }

        const diceNo = this.state.diceNo;
        const playerKey = `player${playerNo}`;
        const piece = this.state[playerKey].find(p => p.id === pieceId);

        if (!piece || piece.pos === 0 || piece.travelCount >= 57) {
            throw new Error('Invalid piece for movement');
        }

        const oldTravelCount = piece.travelCount;
        const newTravelCount = oldTravelCount + diceNo;

        if (newTravelCount > 57) {
            throw new Error('Travel count exceeds limit');
        }

        // Calculate final position step by step
        let newPos = piece.pos;
        for (let i = 0; i < diceNo; i++) {
            newPos = this.getNextPos(playerNo, newPos);
        }

        // Update piece position
        this.updatePiecePosition(playerNo, pieceId, newPos, newTravelCount);

        // Check for collision
        const collision = this.checkCollision(playerNo, pieceId, newPos);

        console.log(`Player ${playerNo} moved piece ${pieceId} to pos ${newPos} (travel: ${newTravelCount})`);

        // Check win condition
        if (this.checkWin(playerNo)) {
            this.state.winner = playerNo;
            this.state.fireworks = true;
            console.log(`Player ${playerNo} WON!`);
            return { state: this.state, winner: playerNo, collision };
        }

        // Determine next turn
        const gotSix = diceNo === 6;
        const reachedHome = newTravelCount === 57;

        if (gotSix || reachedHome || collision) {
            // Same player gets another turn (Ludo rules: 6, reaching home, or capturing opponent)
            console.log(`Player ${playerNo} gets another turn (${gotSix ? 'rolled 6' : reachedHome ? 'reached home' : 'captured piece'})`);
            this.state.isDiceRolled = false;
            this.state.pileSelectionPlayer = -1;
            this.state.cellSelectionPlayer = -1;
        } else {
            // Pass turn
            this.passTurn();
        }

        return { state: this.state, collision, newPos, newTravelCount };
    }

    getNextPos(playerNo, currentPos) {
        const turningPoints = { 1: 52, 2: 13, 3: 26, 4: 39 };
        const homeStretches = { 1: 111, 2: 221, 3: 331, 4: 441 };
        
        // Turning into home stretch
        if (currentPos === turningPoints[playerNo]) {
            return homeStretches[playerNo];
        }
        
        // Inside home stretch
        if ([111, 112, 113, 114].includes(currentPos)) return currentPos + 1;
        if ([221, 222, 223, 224].includes(currentPos)) return currentPos + 1;
        if ([331, 332, 333, 334].includes(currentPos)) return currentPos + 1;
        if ([441, 442, 443, 444].includes(currentPos)) return currentPos + 1;
        
        if ([115, 225, 335, 445].includes(currentPos)) return 999; // Victory cell represented as 999

        // Standard track loop
        if (currentPos === 52) return 1;
        if (currentPos >= 1 && currentPos <= 51) return currentPos + 1;
        
        return currentPos;
    }

    isValidMove(playerNo, pieceId, newPos, newTravelCount) {
        // Obsolete but kept for signature if needed elsewhere
        return true;
    }

    updatePiecePosition(playerNo, pieceId, newPos, newTravelCount) {
        const playerKey = `player${playerNo}`;
        const piece = this.state[playerKey].find(p => p.id === pieceId);
        
        piece.pos = newPos;
        piece.travelCount = newTravelCount;

        // Update current positions
        const existingIndex = this.state.currentPosition.findIndex(p => p.id === pieceId);
        
        if (newTravelCount >= 57) {
            // Piece reached home, remove from board
            if (existingIndex !== -1) {
                this.state.currentPosition.splice(existingIndex, 1);
            }
        } else {
            if (existingIndex !== -1) {
                this.state.currentPosition[existingIndex] = { id: pieceId, pos: newPos };
            } else {
                this.state.currentPosition.push({ id: pieceId, pos: newPos });
            }
        }
    }

    checkCollision(playerNo, pieceId, newPos) {
        // Check if another player's piece is at this position
        const otherPlayerNo = playerNo === 1 ? 3 : 1;
        const otherPlayerKey = `player${otherPlayerNo}`;
        
        const collidedPiece = this.state[otherPlayerKey].find(p => 
            p.pos === newPos && p.pos !== 0 && p.travelCount < 57
        );

        if (collidedPiece) {
            console.log(`Collision! ${pieceId} hit ${collidedPiece.id}`);
            
            // Send opponent piece back home
            collidedPiece.pos = 0;
            collidedPiece.travelCount = 0;
            
            // Remove from current positions
            const index = this.state.currentPosition.findIndex(p => p.id === collidedPiece.id);
            if (index !== -1) {
                this.state.currentPosition.splice(index, 1);
            }

            return { pieceId: collidedPiece.id, playerNo: otherPlayerNo };
        }

        return null;
    }

    checkWin(playerNo) {
        const playerKey = `player${playerNo}`;
        return this.state[playerKey].every(p => p.travelCount >= 57);
    }

    passTurn() {
        const nextPlayer = this.state.chancePlayer === 1 ? 3 : 1;
        console.log(`Turn passed from ${this.state.chancePlayer} to ${nextPlayer}`);
        
        this.state.chancePlayer = nextPlayer;
        this.state.isDiceRolled = false;
        this.state.diceNo = 0;
        this.state.pileSelectionPlayer = -1;
        this.state.cellSelectionPlayer = -1;
        this.state.touchDiceBlock = false;
    }

    getPlayerNumber(playerId) {
        const id = playerId.toString();
        if (id === this.player1Id) return 1;
        if (id === this.player2Id) return 3;
        throw new Error('Invalid player');
    }

    getPlayerPieces(playerNo) {
        const playerKey = `player${playerNo}`;
        return this.state[playerKey] || [];
    }

    setState(newState) {
        if (!newState) return;
        
        // Merge top-level properties but ensure arrays exist
        this.state = {
            ...this.createInitialState(),
            ...newState
        };
    }

    getState() {
        return this.state;
    }
}

module.exports = LudoGame;
