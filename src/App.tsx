import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import confetti from 'canvas-confetti';
import { 
  Copy, Plus, Users, Play, Send, Volume2, VolumeX, LogOut, 
  RefreshCw, AlertCircle, MessageSquare, Home
} from 'lucide-react';
import { SYMBOLS, COLORS, checkWin } from './utils/gameHelpers';
import './App.css';

// Socket type definition matching the server structures
interface Player {
  id: string;
  socketId: string;
  name: string;
  symbol: string;
  color: string;
  isReady: boolean;
  isHost: boolean;
  isOffline: boolean;
}

interface ChatMessage {
  sender: string;
  text: string;
  timestamp: string;
}

interface Room {
  id: string;
  maxPlayers: number;
  gridSize: number;
  players: Player[];
  board: (string | null)[];
  status: 'lobby' | 'playing' | 'ended';
  turnIndex: number;
  winnerId: string | 'draw' | null;
  winLine: number[] | null;
  chat: ChatMessage[];
}

interface Toast {
  id: string;
  text: string;
  type: 'info' | 'error';
}

function App() {
  // Navigation & Mode
  const [view, setView] = useState<'welcome' | 'local-setup' | 'lobby' | 'playing' | 'ended'>('welcome');
  const [mode, setMode] = useState<'local' | 'online' | null>(null);
  
  // User Inputs
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('nexus_player_name') || '');
  const [maxPlayers, setMaxPlayers] = useState(3); // Default 3 players -> 4x4 grid
  const [joinRoomId, setJoinRoomId] = useState('');
  const [chatInput, setChatInput] = useState('');
  
  // Persistence State
  const [savedRoomId, setSavedRoomId] = useState<string | null>(() => localStorage.getItem('nexus_room_id') || null);
  
  // Online State
  const [roomState, setRoomState] = useState<Room | null>(null);
  const socketRef = useRef<Socket | null>(null);
  
  // Local Pass & Play State
  const [localPlayers, setLocalPlayers] = useState<Omit<Player, 'isReady' | 'isHost' | 'socketId'>[]>([]);
  const [localBoard, setLocalBoard] = useState<(string | null)[]>([]);
  const [localTurnIndex, setLocalTurnIndex] = useState(0);
  const [localWinner, setLocalWinner] = useState<string | 'draw' | null>(null); // name or 'draw'
  const [localWinLine, setLocalWinLine] = useState<number[] | null>(null);
  const [localGridSize, setLocalGridSize] = useState(3);
  
  // Feedback
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Audio synthesis helper using Web Audio API
  const playAudio = (type: 'click' | 'place' | 'win' | 'draw' | 'join' | 'ready') => {
    if (!soundEnabled) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      const now = ctx.currentTime;
      
      if (type === 'click') {
        osc.frequency.setValueAtTime(450, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 0.08);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
      } else if (type === 'place') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(320, now + 0.12);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === 'ready') {
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.16);
      } else if (type === 'join') {
        osc.frequency.setValueAtTime(350, now);
        osc.frequency.exponentialRampToValueAtTime(480, now + 0.15);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (type === 'win') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(261.63, now); // C4
        osc.frequency.setValueAtTime(329.63, now + 0.1); // E4
        osc.frequency.setValueAtTime(392.00, now + 0.2); // G4
        osc.frequency.setValueAtTime(523.25, now + 0.3); // C5
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.setValueAtTime(0.08, now + 0.3);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.5);
      } else if (type === 'draw') {
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.setValueAtTime(180, now + 0.12);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    } catch (e) {
      console.warn("Audio synthesis not allowed or supported by browser", e);
    }
  };

  const addToast = (text: string, type: 'info' | 'error' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  // Connect socket.io during online mode setup
  useEffect(() => {
    if (mode === 'online') {
      const socketUrl = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:5000' : window.location.origin);
      socketRef.current = io(socketUrl);

      const socket = socketRef.current;

      // Automatically attempt reconnect on socket connection if stored credentials match
      socket.on('connect', () => {
        const savedPlayerId = localStorage.getItem('nexus_player_id');
        const savedRId = localStorage.getItem('nexus_room_id');
        if (savedPlayerId && savedRId) {
          socket.emit('reconnect-player', { playerId: savedPlayerId, roomId: savedRId });
        }
      });

      socket.on('connect_error', () => {
        addToast('Connection error. Is the server running?', 'error');
        setMode(null);
        setView('welcome');
      });

      socket.on('error-msg', (msg: string) => {
        addToast(msg, 'error');
      });

      socket.on('room-created', ({ room, playerId }: { room: Room, playerId: string }) => {
        setRoomState(room);
        setView('lobby');
        playAudio('join');
        localStorage.setItem('nexus_player_id', playerId);
        localStorage.setItem('nexus_room_id', room.id);
        localStorage.setItem('nexus_player_name', playerName);
        setSavedRoomId(room.id);
      });

      socket.on('room-joined', ({ room, playerId }: { room: Room, playerId: string }) => {
        setRoomState(room);
        setView('lobby');
        playAudio('join');
        localStorage.setItem('nexus_player_id', playerId);
        localStorage.setItem('nexus_room_id', room.id);
        localStorage.setItem('nexus_player_name', playerName);
        setSavedRoomId(room.id);
      });

      socket.on('room-reconnected', (room: Room) => {
        setRoomState(room);
        if (room.status === 'playing') {
          setView('playing');
        } else if (room.status === 'ended') {
          setView('ended');
        } else {
          setView('lobby');
        }
        addToast('Reconnected to session!');
        playAudio('join');
      });

      socket.on('reconnect-failed', (msg: string) => {
        addToast(msg, 'error');
        localStorage.removeItem('nexus_room_id');
        localStorage.removeItem('nexus_player_id');
        setSavedRoomId(null);
        setRoomState(null);
        setMode(null);
        setView('welcome');
      });

      socket.on('room-update', (room: Room) => {
        setRoomState(room);
        if (room.status === 'playing') {
          setView('playing');
        } else if (room.status === 'ended') {
          setView('ended');
          if (room.winnerId === 'draw') {
            playAudio('draw');
          } else {
            playAudio('win');
            triggerConfetti();
          }
        } else if (room.status === 'lobby') {
          setView('lobby');
        }
      });

      socket.on('chat-update', (chat: ChatMessage[]) => {
        setRoomState(prev => prev ? { ...prev, chat } : null);
      });

      return () => {
        socket.disconnect();
        socketRef.current = null;
      };
    }
  }, [mode]);

  // Scroll chat to bottom
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [roomState?.chat]);

  const triggerConfetti = () => {
    confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.6 },
      colors: ['#00f0ff', '#ff007f', '#39ff14', '#bd00ff', '#ff9900', '#fffb00']
    });
  };

  // --- ONLINE GAME ACTIONS ---
  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim()) {
      addToast('Please enter your name.', 'error');
      return;
    }
    playAudio('click');
    setMode('online');
    setTimeout(() => {
      if (socketRef.current) {
        socketRef.current.emit('create-room', { 
          playerName: playerName.trim(), 
          maxPlayers 
        });
      }
    }, 200);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim()) {
      addToast('Please enter your name.', 'error');
      return;
    }
    if (!joinRoomId.trim()) {
      addToast('Please enter a Room ID.', 'error');
      return;
    }
    playAudio('click');
    setMode('online');
    setTimeout(() => {
      if (socketRef.current) {
        socketRef.current.emit('join-room', {
          playerName: playerName.trim(),
          roomId: joinRoomId.trim().toUpperCase()
        });
      }
    }, 200);
  };

  const handleToggleReady = () => {
    playAudio('ready');
    if (socketRef.current) {
      socketRef.current.emit('toggle-ready');
    }
  };

  const handleStartGame = () => {
    playAudio('click');
    if (socketRef.current) {
      socketRef.current.emit('start-game');
    }
  };

  const handleOnlineMove = (cellIndex: number) => {
    if (!roomState || roomState.status !== 'playing') return;
    
    // Check if it's my turn using persistent ID
    const myPersistentId = localStorage.getItem('nexus_player_id');
    const me = roomState.players.find(p => p.id === myPersistentId);
    const activePlayer = roomState.players[roomState.turnIndex];
    
    if (!me || me.id !== activePlayer.id) {
      addToast("It's not your turn!", 'error');
      return;
    }

    if (roomState.board[cellIndex] !== null) return;

    playAudio('place');
    if (socketRef.current) {
      socketRef.current.emit('make-move', { cellIndex });
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    
    if (socketRef.current) {
      socketRef.current.emit('send-chat', { text: chatInput.trim() });
      setChatInput('');
    }
  };

  const handleRestartOnlineGame = () => {
    playAudio('click');
    if (socketRef.current) {
      socketRef.current.emit('restart-game');
    }
  };

  const handleLeaveRoom = () => {
    playAudio('click');
    if (socketRef.current) {
      socketRef.current.emit('leave-room');
    }
    localStorage.removeItem('nexus_room_id');
    localStorage.removeItem('nexus_player_id');
    setSavedRoomId(null);
    setRoomState(null);
    setMode(null);
    setView('welcome');
  };

  // Auto Reconnection triggers
  const handleAutoReconnect = () => {
    playAudio('click');
    setMode('online');
  };

  const handleClearSession = () => {
    playAudio('click');
    localStorage.removeItem('nexus_room_id');
    localStorage.removeItem('nexus_player_id');
    setSavedRoomId(null);
  };

  // --- LOCAL GAME (PASS & PLAY) ACTIONS ---
  const handleLocalSetupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    playAudio('click');
    const size = maxPlayers + 1;
    setLocalGridSize(size);
    
    // Create local players configurations
    const playersArr = [];
    for (let i = 0; i < maxPlayers; i++) {
      const customNameInput = (document.getElementById(`local-p${i}-name`) as HTMLInputElement)?.value;
      playersArr.push({
        id: `local-p${i}`,
        name: customNameInput?.trim() || `Player ${i + 1}`,
        symbol: SYMBOLS[i],
        color: COLORS[i],
        isOffline: false
      });
    }

    setLocalPlayers(playersArr);
    setLocalBoard(Array(size * size).fill(null));
    setLocalTurnIndex(0);
    setLocalWinner(null);
    setLocalWinLine(null);
    setView('playing');
  };

  const handleLocalMove = (cellIndex: number) => {
    if (localWinner || localBoard[cellIndex] !== null) return;

    playAudio('place');
    const newBoard = [...localBoard];
    const activePlayer = localPlayers[localTurnIndex];
    newBoard[cellIndex] = activePlayer.symbol;
    setLocalBoard(newBoard);

    // Check Win
    const winLine = checkWin(newBoard, localGridSize, activePlayer.symbol);
    if (winLine) {
      setLocalWinner(activePlayer.name);
      setLocalWinLine(winLine);
      setView('ended');
      playAudio('win');
      triggerConfetti();
    } else {
      // Check Draw
      const isDraw = newBoard.every(cell => cell !== null);
      if (isDraw) {
        setLocalWinner('draw');
        setView('ended');
        playAudio('draw');
      } else {
        // Next Turn
        setLocalTurnIndex((localTurnIndex + 1) % localPlayers.length);
      }
    }
  };

  const handleRestartLocalGame = () => {
    playAudio('click');
    setLocalBoard(Array(localGridSize * localGridSize).fill(null));
    setLocalTurnIndex(0);
    setLocalWinner(null);
    setLocalWinLine(null);
    setView('playing');
  };

  const handleExitLocalGame = () => {
    playAudio('click');
    setLocalPlayers([]);
    setLocalBoard([]);
    setLocalTurnIndex(0);
    setLocalWinner(null);
    setLocalWinLine(null);
    setMode(null);
    setView('welcome');
  };

  return (
    <>
      {/* Sound Controller Button */}
      <button 
        id="toggle-sound-btn"
        className="btn btn-outline" 
        onClick={() => { playAudio('click'); setSoundEnabled(!soundEnabled); }}
        style={{ position: 'fixed', top: '24px', right: '24px', padding: '10px', borderRadius: '50%', zIndex: 10 }}
        aria-label={soundEnabled ? 'Mute sound' : 'Unmute sound'}
      >
        {soundEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
      </button>

      {/* 1. WELCOME SCREEN */}
      {view === 'welcome' && (
        <div id="welcome-panel" className="glass-panel welcome-container">
          <div className="welcome-logo floating-icon">🌌</div>
          <h1>NEXUS GRID</h1>
          <p className="welcome-subtitle">Dynamic Multi-Player Tic-Tac-Toe</p>

          {/* Persistent Reconnection card */}
          {savedRoomId && (
            <div style={{ border: '1px solid var(--neon-blue)', background: 'rgba(0, 240, 255, 0.04)', borderRadius: '12px', padding: '16px', marginBottom: '24px', display: 'flex', flexDirection: 'column', gap: '10px', textAlign: 'left', animation: 'popIn 0.3s ease' }}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem', color: '#fff' }}>Active Session Found</div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>You have an active session in Room <strong>{savedRoomId}</strong>.</p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  id="btn-reconnect-session"
                  type="button" 
                  className="btn btn-neon-blue" 
                  style={{ flex: 1, padding: '8px 14px', fontSize: '0.85rem', borderRadius: '8px' }} 
                  onClick={handleAutoReconnect}
                >
                  Reconnect
                </button>
                <button 
                  id="btn-discard-session"
                  type="button" 
                  className="btn btn-outline" 
                  style={{ padding: '8px 14px', fontSize: '0.85rem', borderRadius: '8px' }} 
                  onClick={handleClearSession}
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          <form onSubmit={(e) => e.preventDefault()} id="welcome-form">
            <div className="input-group">
              <label htmlFor="name-input">Your Nickname</label>
              <input 
                id="name-input"
                type="text" 
                maxLength={12}
                placeholder="Enter player name..." 
                className="input-field" 
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                required
              />
            </div>

            {/* Custom Tab Panel */}
            <div className="tab-container" role="tablist">
              <button 
                id="tab-local"
                type="button" 
                className={`tab-btn ${mode === 'local' ? 'active' : ''}`}
                onClick={() => { playAudio('click'); setMode('local'); }}
                role="tab"
                aria-selected={mode === 'local'}
              >
                Local Play
              </button>
              <button 
                id="tab-online"
                type="button" 
                className={`tab-btn ${mode === 'online' ? 'active' : ''}`}
                onClick={() => { playAudio('click'); setMode('online'); }}
                role="tab"
                aria-selected={mode === 'online'}
              >
                Online Rooms
              </button>
            </div>

            {/* Local Play setup trigger */}
            {mode === 'local' && (
              <div style={{ animation: 'popIn 0.3s ease' }}>
                <div className="slider-container">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>Total Players</span>
                    <span style={{ color: 'var(--neon-blue)', fontWeight: 700 }}>{maxPlayers} Players</span>
                  </div>
                  <input 
                    id="players-range-local"
                    type="range" 
                    min={2} 
                    max={6} 
                    value={maxPlayers}
                    onChange={(e) => { playAudio('click'); setMaxPlayers(parseInt(e.target.value, 10)); }}
                    style={{ width: '100%', accentColor: 'var(--neon-blue)' }}
                  />
                  <div className="slider-labels">
                    <span>2</span>
                    <span>3</span>
                    <span>4</span>
                    <span>5</span>
                    <span>6</span>
                  </div>
                </div>

                <div className="board-preview-desc">
                  Board Size: <strong>{maxPlayers + 1} x {maxPlayers + 1}</strong> ({ (maxPlayers + 1) * (maxPlayers + 1) } boxes)
                  <br />
                  Line to Win: <strong>{maxPlayers + 1} in a row</strong>
                </div>

                <button 
                  id="btn-next-local"
                  type="button" 
                  className="btn btn-primary" 
                  style={{ width: '100%', marginTop: '24px' }}
                  onClick={() => { playAudio('click'); setView('local-setup'); }}
                >
                  Configure Players & Start
                </button>
              </div>
            )}

            {/* Online setup trigger */}
            {mode === 'online' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'popIn 0.3s ease' }}>
                <div style={{ border: '1px solid var(--border-glow)', borderRadius: '12px', padding: '16px', background: 'rgba(0,0,0,0.15)' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '14px', textAlign: 'left' }}>Option A: Create a Room</h3>
                  
                  <div className="slider-container">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Players</span>
                      <span style={{ color: 'var(--neon-pink)', fontWeight: 700, fontSize: '0.9rem' }}>{maxPlayers} Players</span>
                    </div>
                    <input 
                      id="players-range-online"
                      type="range" 
                      min={2} 
                      max={6} 
                      value={maxPlayers}
                      onChange={(e) => { playAudio('click'); setMaxPlayers(parseInt(e.target.value, 10)); }}
                      style={{ width: '100%', accentColor: 'var(--neon-pink)' }}
                    />
                  </div>

                  <button 
                    id="btn-create-room"
                    type="button" 
                    className="btn btn-neon-pink" 
                    style={{ width: '100%' }}
                    onClick={handleCreateRoom}
                  >
                    <Plus size={18} /> Create Room Code
                  </button>
                </div>

                <div style={{ border: '1px solid var(--border-glow)', borderRadius: '12px', padding: '16px', background: 'rgba(0,0,0,0.15)' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '14px', textAlign: 'left' }}>Option B: Join Existing Room</h3>
                  
                  <div className="input-group" style={{ marginBottom: '14px' }}>
                    <input 
                      id="room-code-input"
                      type="text" 
                      placeholder="Enter 4-digit Code (e.g. ABCD)" 
                      className="input-field" 
                      value={joinRoomId}
                      onChange={(e) => setJoinRoomId(e.target.value)}
                      maxLength={4}
                      style={{ textAlign: 'center', letterSpacing: '2px', textTransform: 'uppercase' }}
                    />
                  </div>

                  <button 
                    id="btn-join-room"
                    type="button" 
                    className="btn btn-neon-blue" 
                    style={{ width: '100%' }}
                    onClick={handleJoinRoom}
                  >
                    <Users size={18} /> Join Room
                  </button>
                </div>
              </div>
            )}

            {!mode && (
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginTop: '20px' }}>
                Select a game mode above to begin your match.
              </p>
            )}
          </form>
        </div>
      )}

      {/* 2. LOCAL SETUP CONFIGURATION SCREEN */}
      {view === 'local-setup' && mode === 'local' && (
        <div id="local-setup-panel" className="glass-panel welcome-container" style={{ maxWidth: '520px' }}>
          <h2>Player Customization</h2>
          <p style={{ fontSize: '0.9rem', marginBottom: '24px' }}>Set nicknames for each player taking turns.</p>

          <form onSubmit={handleLocalSetupSubmit}>
            <div className="local-setup-form">
              {Array.from({ length: maxPlayers }).map((_, idx) => (
                <div key={idx} className="local-player-row">
                  <div 
                    className="player-symbol-preview" 
                    style={{ backgroundColor: `${COLORS[idx]}20`, color: COLORS[idx], border: `1px solid ${COLORS[idx]}` }}
                  >
                    {SYMBOLS[idx]}
                  </div>
                  <input 
                    id={`local-p${idx}-name`}
                    type="text" 
                    maxLength={12}
                    placeholder={`Player ${idx + 1} Name`}
                    defaultValue={`Player ${idx + 1}`}
                    required
                  />
                </div>
              ))}
            </div>

            <div className="action-buttons">
              <button 
                id="btn-back-setup"
                type="button" 
                className="btn btn-outline" 
                onClick={() => { playAudio('click'); setView('welcome'); }}
              >
                Back
              </button>
              <button 
                id="btn-start-local"
                type="submit" 
                className="btn btn-primary"
              >
                <Play size={18} /> Start Match
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 3. MULTIPLAYER ROOM LOBBY SCREEN */}
      {view === 'lobby' && mode === 'online' && roomState && (
        <div id="online-lobby-panel" className="glass-panel lobby-container">
          <div className="lobby-main">
            <div className="lobby-header">
              <h2>Lobby Room</h2>
              <p>Invite friends to join this matchmaking room.</p>
              
              <div className="room-id-box">
                <code>{roomState.id}</code>
                <button 
                  id="btn-copy-code"
                  className="copy-btn" 
                  onClick={() => {
                    navigator.clipboard.writeText(roomState.id);
                    addToast('Room Code copied to clipboard!');
                    playAudio('click');
                  }}
                  title="Copy room code"
                >
                  <Copy size={20} />
                </button>
              </div>
            </div>

            <div className="players-list">
              <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Players ({roomState.players.length} / {roomState.maxPlayers})
              </h3>
              
              {/* Render joined players */}
              {roomState.players.map((player) => {
                const myPersistentId = localStorage.getItem('nexus_player_id');
                const isMe = player.id === myPersistentId;
                return (
                  <div key={player.id} className={`player-card ${isMe ? 'active-card' : ''}`}>
                    <div className="player-info">
                      <div 
                        className="player-avatar" 
                        style={{ backgroundColor: `${player.color}20`, color: player.color, border: `1px solid ${player.color}` }}
                      >
                        {player.symbol}
                      </div>
                      <div className="player-name-container">
                        <span className="player-name">{player.name} {isMe && '(You)'}</span>
                        <span className="player-role">{player.isHost ? 'Room Owner' : 'Challenger'}</span>
                      </div>
                    </div>

                    <div>
                      {player.isOffline ? (
                        <span className="player-status-badge status-offline" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.25)' }}>Offline</span>
                      ) : player.isHost ? (
                        <span className="player-status-badge status-host">Host</span>
                      ) : (
                        <span className={`player-status-badge ${player.isReady ? 'status-ready' : 'status-waiting'}`}>
                          {player.isReady ? 'Ready' : 'Waiting'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Render empty slots */}
              {Array.from({ length: roomState.maxPlayers - roomState.players.length }).map((_, idx) => (
                <div key={`empty-${idx}`} className="player-card" style={{ borderStyle: 'dashed', opacity: 0.6 }}>
                  <div className="player-info">
                    <div className="player-avatar" style={{ border: '1px dashed var(--text-muted)', color: 'var(--text-muted)' }}>
                      ?
                    </div>
                    <span className="status-empty">Waiting for slot...</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="action-buttons" style={{ marginTop: '12px' }}>
              <button 
                id="btn-leave-lobby"
                className="btn btn-outline" 
                onClick={handleLeaveRoom}
              >
                <LogOut size={18} /> Leave
              </button>

              {roomState.players.find(p => p.id === localStorage.getItem('nexus_player_id'))?.isHost ? (
                <button 
                  id="btn-start-online"
                  className={`btn btn-primary ${
                    roomState.players.length < roomState.maxPlayers || 
                    !roomState.players.filter(p => !p.isHost).every(p => p.isReady) 
                      ? 'btn-disabled' : ''
                  }`}
                  onClick={handleStartGame}
                  disabled={
                    roomState.players.length < roomState.maxPlayers || 
                    !roomState.players.filter(p => !p.isHost).every(p => p.isReady)
                  }
                >
                  <Play size={18} /> Start Match
                </button>
              ) : (
                <button 
                  id="btn-ready-toggle"
                  className="btn btn-neon-blue" 
                  onClick={handleToggleReady}
                >
                  {roomState.players.find(p => p.id === localStorage.getItem('nexus_player_id'))?.isReady ? 'Not Ready' : 'Ready Up'}
                </button>
              )}
            </div>
          </div>

          {/* Lobby Chat Component */}
          <div className="chat-container">
            <div className="chat-header">
              <MessageSquare size={16} />
              <span>Match Chat</span>
            </div>
            
            <div className="chat-messages">
              {roomState.chat.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 'auto' }}>
                  No messages yet. Send a greetings!
                </div>
              ) : (
                roomState.chat.map((msg, idx) => {
                  const isSystem = msg.sender === 'System';
                  const isMe = msg.sender === playerName;
                  return (
                    <div 
                      key={idx} 
                      className={`chat-bubble ${isSystem ? 'system' : isMe ? 'me' : 'other'}`}
                    >
                      {!isSystem && (
                        <div className="chat-meta">
                          <span className="chat-sender" style={{ color: isMe ? 'var(--neon-pink)' : 'var(--neon-blue)' }}>
                            {msg.sender}
                          </span>
                          <span className="chat-time">{msg.timestamp}</span>
                        </div>
                      )}
                      <div>{msg.text}</div>
                    </div>
                  );
                })
              )}
              <div ref={chatBottomRef} />
            </div>

            <form onSubmit={handleSendChat} className="chat-input-area">
              <input 
                id="chat-message-input"
                type="text" 
                placeholder="Type message..." 
                className="chat-input"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                maxLength={100}
              />
              <button id="btn-send-chat" type="submit" className="chat-send-btn">
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 4. GAMEPLAY SCREEN & 5. ENDED SCREEN */}
      {(view === 'playing' || view === 'ended') && (
        <div id="gameplay-panel" className="glass-panel game-container">
          {/* Main game board */}
          <div className="game-main">
            <div className="status-banner">
              {mode === 'local' ? (
                <>
                  <div className="turn-display">
                    {view === 'playing' && (
                      <div 
                        className="turn-indicator-dot" 
                        style={{ backgroundColor: localPlayers[localTurnIndex]?.color, boxShadow: `0 0 10px ${localPlayers[localTurnIndex]?.color}` }} 
                      />
                    )}
                    <span className="turn-text">
                      {view === 'playing' 
                        ? `${localPlayers[localTurnIndex]?.name}'s Turn` 
                        : localWinner === 'draw' 
                          ? "It's a Draw!" 
                          : `🏆 ${localWinner} Wins!`
                      }
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontWeight: 600 }}>
                    Local Play
                  </div>
                </>
              ) : (
                roomState && (
                  <>
                    <div className="turn-display">
                      {view === 'playing' && (
                        <div 
                          className="turn-indicator-dot" 
                          style={{ 
                            backgroundColor: roomState.players[roomState.turnIndex]?.color, 
                            boxShadow: `0 0 10px ${roomState.players[roomState.turnIndex]?.color}` 
                          }} 
                        />
                      )}
                      <span className="turn-text">
                        {view === 'playing' 
                          ? `${roomState.players[roomState.turnIndex]?.name}'s Turn` 
                          : roomState.winnerId === 'draw' 
                            ? "It's a Draw!" 
                            : `🏆 ${roomState.players.find(p => p.id === roomState.winnerId)?.name} Wins!`
                        }
                      </span>
                    </div>
                    <div style={{ color: 'var(--neon-blue)', fontSize: '0.9rem', fontWeight: 700, textShadow: '0 0 5px rgba(0, 240, 255, 0.2)' }}>
                      Room Code: {roomState.id}
                    </div>
                  </>
                )
              )}
            </div>

            {/* Board Render */}
            <div className="board-wrapper">
              <div 
                className={`board-grid grid-${mode === 'local' ? `${localGridSize}x${localGridSize}` : `${roomState?.gridSize}x${roomState?.gridSize}`}`}
                style={{ 
                  gridTemplateColumns: `repeat(${mode === 'local' ? localGridSize : roomState?.gridSize}, 1fr)`,
                  gridTemplateRows: `repeat(${mode === 'local' ? localGridSize : roomState?.gridSize}, 1fr)` 
                }}
              >
                {(mode === 'local' ? localBoard : roomState?.board || []).map((cell, idx) => {
                  // Determine visual properties of player symbols
                  let cellColor = '';
                  let isWinning = false;
                  
                  if (mode === 'local') {
                    const pl = localPlayers.find(p => p.symbol === cell);
                    cellColor = pl ? pl.color : '';
                    isWinning = localWinLine?.includes(idx) || false;
                  } else if (roomState) {
                    const pl = roomState.players.find(p => p.symbol === cell);
                    cellColor = pl ? pl.color : '';
                    isWinning = roomState.winLine?.includes(idx) || false;
                  }

                  return (
                    <button 
                      key={idx}
                      id={`cell-${idx}`}
                      className={`board-cell ${cell ? 'occupied' : ''} ${isWinning ? 'winning-cell' : ''}`}
                      disabled={view === 'ended'}
                      onClick={() => mode === 'local' ? handleLocalMove(idx) : handleOnlineMove(idx)}
                    >
                      {cell && (
                        <div 
                          className="symbol-wrapper" 
                          style={{ 
                            color: cellColor, 
                            textShadow: `0 0 12px ${cellColor}80` 
                          }}
                        >
                          {cell}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Winner Overlay Banner */}
            {view === 'ended' && (
              <div className="winner-overlay" style={{ animation: 'popIn 0.3s ease' }}>
                <div style={{ fontSize: '3rem' }}>🏆</div>
                <div className="winner-announce">
                  {mode === 'local' 
                    ? localWinner === 'draw' 
                      ? "Draw Match!" 
                      : `${localWinner} Won!`
                    : roomState?.winnerId === 'draw'
                      ? "Draw Match!"
                      : `${roomState?.players.find(p => p.id === roomState.winnerId)?.name} Won!`
                  }
                </div>
                <div className="winner-subtitle">
                  {mode === 'local' 
                    ? 'Well played everyone!' 
                    : 'The results are recorded in the history.'
                  }
                </div>

                <div className="action-buttons" style={{ marginTop: '16px' }}>
                  {mode === 'local' ? (
                    <>
                      <button 
                        id="btn-local-exit"
                        className="btn btn-outline" 
                        onClick={handleExitLocalGame}
                      >
                        <Home size={18} /> Home
                      </button>
                      <button 
                        id="btn-local-rematch"
                        className="btn btn-primary" 
                        onClick={handleRestartLocalGame}
                      >
                        <RefreshCw size={18} /> Play Again
                      </button>
                    </>
                  ) : (
                    roomState && (
                      <>
                        <button 
                          id="btn-online-exit"
                          className="btn btn-outline" 
                          onClick={handleLeaveRoom}
                        >
                          <LogOut size={18} /> Leave
                        </button>
                        {roomState.players.find(p => p.id === localStorage.getItem('nexus_player_id'))?.isHost ? (
                          <button 
                            id="btn-online-rematch"
                            className="btn btn-primary" 
                            onClick={handleRestartOnlineGame}
                          >
                            <RefreshCw size={18} /> Play Again
                          </button>
                        ) : (
                          <div style={{ fontStyle: 'italic', fontSize: '0.9rem', color: 'var(--text-muted)', margin: 'auto' }}>
                            Waiting for host to restart game...
                          </div>
                        )}
                      </>
                    )
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: Scoreboard & chat */}
          <div className="game-sidebar">
            {/* Scoreboard Panel */}
            <div className="glass-panel" style={{ padding: '20px' }}>
              <div className="scoreboard-title">Players Order</div>
              
              <div className="scoreboard-players">
                {(mode === 'local' ? localPlayers : roomState?.players || []).map((player, idx) => {
                  let isCurrentTurn = false;
                  if (mode === 'local') {
                    isCurrentTurn = localTurnIndex === idx && view === 'playing';
                  } else if (roomState) {
                    isCurrentTurn = roomState.turnIndex === idx && view === 'playing';
                  }

                  return (
                    <div 
                      key={player.id} 
                      className={`scoreboard-player-row ${isCurrentTurn ? 'active-turn' : ''}`}
                      style={isCurrentTurn ? { borderColor: `${player.color}50` } : {}}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div 
                          className="player-avatar" 
                          style={{ 
                            width: '28px', 
                            height: '28px', 
                            fontSize: '0.95rem',
                            backgroundColor: `${player.color}20`, 
                            color: player.color, 
                            border: `1px solid ${player.color}` 
                          }}
                        >
                          {player.symbol}
                        </div>
                        <span style={{ fontWeight: 600, fontSize: '0.95rem', color: isCurrentTurn ? '#fff' : 'var(--text-secondary)' }}>
                          {player.name}
                        </span>
                      </div>
                      
                      {player.isOffline ? (
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#ef4444' }}>Offline</span>
                      ) : isCurrentTurn && (
                        <span 
                          style={{ 
                            fontSize: '0.75rem', 
                            fontWeight: 800, 
                            color: player.color,
                            textTransform: 'uppercase',
                            letterSpacing: '1px'
                          }}
                        >
                          Active
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Chat Panel in game (Online mode only) */}
            {mode === 'online' && roomState && (
              <div className="chat-container" style={{ height: '350px' }}>
                <div className="chat-header">
                  <MessageSquare size={16} />
                  <span>Match Chat</span>
                </div>
                
                <div className="chat-messages">
                  {roomState.chat.map((msg, idx) => {
                    const isSystem = msg.sender === 'System';
                    const isMe = msg.sender === playerName;
                    return (
                      <div 
                        key={idx} 
                        className={`chat-bubble ${isSystem ? 'system' : isMe ? 'me' : 'other'}`}
                      >
                        {!isSystem && (
                          <div className="chat-meta">
                            <span className="chat-sender" style={{ color: isMe ? 'var(--neon-pink)' : 'var(--neon-blue)' }}>
                              {msg.sender}
                            </span>
                            <span className="chat-time">{msg.timestamp}</span>
                          </div>
                        )}
                        <div>{msg.text}</div>
                      </div>
                    );
                  })}
                  <div ref={chatBottomRef} />
                </div>

                <form onSubmit={handleSendChat} className="chat-input-area">
                  <input 
                    id="chat-message-input-game"
                    type="text" 
                    placeholder="Send text..." 
                    className="chat-input"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    maxLength={100}
                  />
                  <button id="btn-send-chat-game" type="submit" className="chat-send-btn">
                    <Send size={16} />
                  </button>
                </form>
              </div>
            )}

            {/* Exit/Leave controls during active gameplay */}
            {view === 'playing' && (
              <button 
                id="btn-leave-active-game"
                className="btn btn-outline" 
                style={{ width: '100%' }}
                onClick={mode === 'local' ? handleExitLocalGame : handleLeaveRoom}
              >
                <LogOut size={16} /> Quit Match
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toast Notification Container */}
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast ${toast.type === 'info' ? 'info-toast' : ''}`}>
            <AlertCircle size={16} />
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export default App;
