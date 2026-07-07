import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Serve static files from Vite build folder (dist)
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Room states: roomId -> room object
const rooms = new Map();

// Helper to generate a unique Room ID
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 4; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(id));
  return id;
}

// Preset symbols and colors for up to 6 players
const SYMBOLS = ['X', 'O', '▲', '■', '◆', '★'];
const COLORS = [
  '#00f0ff', // Neon Blue
  '#ff007f', // Neon Pink
  '#39ff14', // Neon Green
  '#bd00ff', // Neon Purple
  '#ff9900', // Neon Orange
  '#fffb00'  // Neon Yellow
];

// Helper to check for a win
function checkWin(board, size, symbol) {
  // size = N + 1
  // Row check
  for (let r = 0; r < size; r++) {
    let win = true;
    let line = [];
    for (let c = 0; c < size; c++) {
      let idx = r * size + c;
      if (board[idx] !== symbol) {
        win = false;
        break;
      }
      line.push(idx);
    }
    if (win) return line;
  }

  // Column check
  for (let c = 0; c < size; c++) {
    let win = true;
    let line = [];
    for (let r = 0; r < size; r++) {
      let idx = r * size + c;
      if (board[idx] !== symbol) {
        win = false;
        break;
      }
      line.push(idx);
    }
    if (win) return line;
  }

  // Main diagonal
  let diag1Win = true;
  let diag1Line = [];
  for (let i = 0; i < size; i++) {
    let idx = i * size + i;
    if (board[idx] !== symbol) {
      diag1Win = false;
      break;
    }
    diag1Line.push(idx);
  }
  if (diag1Win) return diag1Line;

  // Anti-diagonal
  let diag2Win = true;
  let diag2Line = [];
  for (let i = 0; i < size; i++) {
    let idx = i * size + (size - 1 - i);
    if (board[idx] !== symbol) {
      diag2Win = false;
      break;
    }
    diag2Line.push(idx);
  }
  if (diag2Win) return diag2Line;

  return null;
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let playerIndex = -1;

  // 1. Create Room
  socket.on('create-room', ({ playerName, maxPlayers }) => {
    const numPlayers = parseInt(maxPlayers, 10);
    if (isNaN(numPlayers) || numPlayers < 2 || numPlayers > 6) {
      socket.emit('error-msg', 'Invalid number of players (must be 2-6).');
      return;
    }

    const roomId = generateRoomId();
    const newRoom = {
      id: roomId,
      maxPlayers: numPlayers,
      gridSize: numPlayers + 1,
      players: [
        {
          id: socket.id,
          name: playerName,
          symbol: SYMBOLS[0],
          color: COLORS[0],
          isReady: false,
          isHost: true
        }
      ],
      board: Array((numPlayers + 1) * (numPlayers + 1)).fill(null),
      status: 'lobby', // 'lobby' | 'playing' | 'ended'
      turnIndex: 0,
      winnerId: null, // string | 'draw' | null
      winLine: null,  // Array of indices
      chat: []
    };

    rooms.set(roomId, newRoom);
    currentRoomId = roomId;
    playerIndex = 0;

    socket.join(roomId);
    socket.emit('room-created', newRoom);
    io.to(roomId).emit('room-update', newRoom);
    console.log(`Room created: ${roomId} by player: ${playerName}`);
  });

  // 2. Join Room
  socket.on('join-room', ({ playerName, roomId }) => {
    const rId = roomId.trim().toUpperCase();
    const room = rooms.get(rId);

    if (!room) {
      socket.emit('error-msg', 'Room not found.');
      return;
    }

    if (room.status !== 'lobby') {
      socket.emit('error-msg', 'Game has already started in this room.');
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('error-msg', 'Room is full.');
      return;
    }

    const nextIndex = room.players.length;
    const newPlayer = {
      id: socket.id,
      name: playerName,
      symbol: SYMBOLS[nextIndex],
      color: COLORS[nextIndex],
      isReady: false,
      isHost: false
    };

    room.players.push(newPlayer);
    currentRoomId = rId;
    playerIndex = nextIndex;

    socket.join(rId);
    socket.emit('room-joined', room);
    io.to(rId).emit('room-update', room);
    
    // System message in chat
    const sysMsg = {
      sender: 'System',
      text: `${playerName} has joined the room.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMsg);
    io.to(rId).emit('chat-update', room.chat);

    console.log(`Player ${playerName} joined room: ${rId}`);
  });

  // 3. Toggle Ready Status
  socket.on('toggle-ready', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isReady = !player.isReady;
      io.to(currentRoomId).emit('room-update', room);
    }
  });

  // 4. Start Game
  socket.on('start-game', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Only host can start
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error-msg', 'Only the host can start the game.');
      return;
    }

    // Check if room is full
    if (room.players.length < room.maxPlayers) {
      socket.emit('error-msg', `Need ${room.maxPlayers} players to start. Current: ${room.players.length}`);
      return;
    }

    // Check if everyone is ready (except host, or including host - let's say all other players must be ready)
    const nonHostPlayers = room.players.filter(p => !p.isHost);
    const allReady = nonHostPlayers.every(p => p.isReady);
    if (!allReady) {
      socket.emit('error-msg', 'All players must be ready to start.');
      return;
    }

    // Start game
    room.status = 'playing';
    room.board = Array(room.gridSize * room.gridSize).fill(null);
    room.turnIndex = 0;
    room.winnerId = null;
    room.winLine = null;

    // Reset ready states for next round
    room.players.forEach(p => {
      p.isReady = false;
    });

    io.to(currentRoomId).emit('room-update', room);
    
    const sysMsg = {
      sender: 'System',
      text: 'The match has begun!',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMsg);
    io.to(currentRoomId).emit('chat-update', room.chat);

    console.log(`Game started in room: ${currentRoomId}`);
  });

  // 5. Make Move
  socket.on('make-move', ({ cellIndex }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.status !== 'playing') return;

    // Check if it's this player's turn
    const activePlayer = room.players[room.turnIndex];
    if (!activePlayer || activePlayer.id !== socket.id) {
      socket.emit('error-msg', "It's not your turn!");
      return;
    }

    const idx = parseInt(cellIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= room.board.length || room.board[idx] !== null) {
      socket.emit('error-msg', 'Invalid move.');
      return;
    }

    // Place mark
    room.board[idx] = activePlayer.symbol;

    // Check for win
    const winLine = checkWin(room.board, room.gridSize, activePlayer.symbol);
    if (winLine) {
      room.status = 'ended';
      room.winnerId = activePlayer.id;
      room.winLine = winLine;

      const sysMsg = {
        sender: 'System',
        text: `🏆 ${activePlayer.name} has won the match!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      room.chat.push(sysMsg);
      io.to(currentRoomId).emit('chat-update', room.chat);
    } else {
      // Check for draw (board full)
      const isDraw = room.board.every(cell => cell !== null);
      if (isDraw) {
        room.status = 'ended';
        room.winnerId = 'draw';
        room.winLine = null;

        const sysMsg = {
          sender: 'System',
          text: '🤝 It is a draw!',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        room.chat.push(sysMsg);
        io.to(currentRoomId).emit('chat-update', room.chat);
      } else {
        // Next turn
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }
    }

    io.to(currentRoomId).emit('room-update', room);
  });

  // 6. Send Chat Message
  socket.on('send-chat', ({ text }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const chatMsg = {
      sender: player.name,
      text: text.trim().substring(0, 100), // limit length
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chat.push(chatMsg);
    // Keep chat history bounded (e.g. last 100 messages)
    if (room.chat.length > 100) {
      room.chat.shift();
    }

    io.to(currentRoomId).emit('chat-update', room.chat);
  });

  // 7. Restart Game
  socket.on('restart-game', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.status !== 'ended') return;

    // Only host can restart
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('error-msg', 'Only the host can restart the game.');
      return;
    }

    // Reset board and return to playing
    room.status = 'playing';
    room.board = Array(room.gridSize * room.gridSize).fill(null);
    room.turnIndex = 0;
    room.winnerId = null;
    room.winLine = null;

    io.to(currentRoomId).emit('room-update', room);

    const sysMsg = {
      sender: 'System',
      text: 'New round started!',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMsg);
    io.to(currentRoomId).emit('chat-update', room.chat);
    
    console.log(`Game restarted in room: ${currentRoomId}`);
  });

  // 8. Leave Room / Disconnect
  const handleLeave = () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const leavingIdx = room.players.findIndex(p => p.id === socket.id);
    if (leavingIdx === -1) return;

    const leavingPlayer = room.players[leavingIdx];
    room.players.splice(leavingIdx, 1);

    socket.leave(currentRoomId);
    
    console.log(`Player ${leavingPlayer.name} left room: ${currentRoomId}`);

    if (room.players.length === 0) {
      // Room is empty, delete it
      rooms.delete(currentRoomId);
      console.log(`Room deleted (empty): ${currentRoomId}`);
    } else {
      // If host left, designate a new host
      if (leavingPlayer.isHost) {
        room.players[0].isHost = true;
        // Keep their ready status false or sync
        const sysMsg = {
          sender: 'System',
          text: `${room.players[0].name} is now the host.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        room.chat.push(sysMsg);
      }

      const leaveMsg = {
        sender: 'System',
        text: `${leavingPlayer.name} has left the room.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      room.chat.push(leaveMsg);

      // If game was playing, reset it back to lobby because a player left
      if (room.status === 'playing') {
        room.status = 'lobby';
        room.board = Array(room.gridSize * room.gridSize).fill(null);
        room.turnIndex = 0;
        room.winnerId = null;
        room.winLine = null;
        // Reset all ready states
        room.players.forEach(p => {
          p.isReady = false;
        });
        const resetMsg = {
          sender: 'System',
          text: 'A player disconnected. The game has returned to the lobby.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        room.chat.push(resetMsg);
      }

      // Re-assign symbols and colors to preserve index orders
      room.players.forEach((p, idx) => {
        p.symbol = SYMBOLS[idx];
        p.color = COLORS[idx];
      });

      io.to(currentRoomId).emit('room-update', room);
      io.to(currentRoomId).emit('chat-update', room.chat);
    }

    currentRoomId = null;
    playerIndex = -1;
  };

  socket.on('leave-room', handleLeave);
  socket.on('disconnect', handleLeave);
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Lightweight Nexus Grid server running on port ${PORT}`);
});
