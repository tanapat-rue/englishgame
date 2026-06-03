import { useState, useCallback, useRef } from 'react';
import LobbyScreen from './screens/LobbyScreen';
import HangmanScreen from './screens/HangmanScreen';
import { useWebSocket } from './hooks/useWebSocket';
import { GameState, ServerMessage } from './types';

type AppScreen = 'home' | 'lobby' | 'game';

interface GameSession {
  roomId: string;
  playerName: string;
}

// Lifted state that survives the lobby→game screen transition
interface SharedGameState {
  gameState: GameState | null;
  myId: string | null;
  secretWord: string | null;
}

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [session, setSession] = useState<GameSession | null>(null);
  const [shared, setShared] = useState<SharedGameState>({ gameState: null, myId: null, secretWord: null });

  // onMessage is consumed by both lobby and game screens via the same WS connection.
  // We use a ref so the WS hook never needs to re-subscribe when the handler changes.
  const screenHandlerRef = useRef<((msg: ServerMessage) => void) | null>(null);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'room_state') {
      setShared(prev => ({ ...prev, gameState: msg.state, myId: prev.myId ?? msg.yourPlayerId }));
      if (msg.state.status === 'playing') setScreen('game');
    }
    // Buffer secret_word at App level so GameScreen always gets it even if it
    // wasn't mounted yet when the WS event arrived
    if (msg.type === 'secret_word') {
      setShared(prev => ({ ...prev, secretWord: msg.word }));
    }
    screenHandlerRef.current?.(msg);
  }, []);

  // WS is created once per session (roomId) and lives until the user leaves
  const { send, connected } = useWebSocket({
    roomId: session?.roomId ?? '',
    onMessage: handleMessage,
    enabled: screen !== 'home',
  });

  const handleJoinRoom = (roomId: string, playerName: string) => {
    setSession({ roomId, playerName });
    setShared({ gameState: null, myId: null, secretWord: null });
    setScreen('lobby');
  };

  const handleLeaveGame = () => {
    setSession(null);
    setShared({ gameState: null, myId: null, secretWord: null });
    setScreen('home');
  };

  if (screen === 'lobby' && session) {
    return (
      <LobbyScreen
        roomId={session.roomId}
        playerName={session.playerName}
        shared={shared}
        send={send}
        connected={connected}
        onRegisterHandler={(fn: (msg: ServerMessage) => void) => { screenHandlerRef.current = fn; }}
        onLeave={handleLeaveGame}
      />
    );
  }

  if (screen === 'game' && session) {
    return (
      <HangmanScreen
        roomId={session.roomId}
        playerName={session.playerName}
        shared={shared}
        send={send}
        connected={connected}
        onRegisterHandler={(fn: (msg: ServerMessage) => void) => { screenHandlerRef.current = fn; }}
        onLeave={handleLeaveGame}
      />
    );
  }

  return <HomeScreen onJoin={handleJoinRoom} />;
}

function HomeScreen({ onJoin }: { onJoin: (roomId: string, name: string) => void }) {
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const apiBase = import.meta.env.DEV ? 'http://localhost:8787' : (import.meta.env.VITE_WORKER_URL ?? '');

  const handleCreate = async () => {
    if (!name.trim()) { setError('Please enter your name'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/room/create`, { method: 'POST' });
      const data = await res.json() as { roomId: string };
      onJoin(data.roomId, name.trim());
    } catch {
      setError('Could not connect to server. Is the worker running?');
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = () => {
    if (!name.trim()) { setError('Please enter your name'); return; }
    if (!roomCode.trim()) { setError('Please enter a room code'); return; }
    onJoin(roomCode.trim().toUpperCase(), name.trim());
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-indigo-950/30 to-gray-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="text-center space-y-3">
          <div className="text-6xl">🎯</div>
          <h1 className="text-4xl font-black text-white tracking-tight">Hangman</h1>
          <p className="text-indigo-300/70 text-sm font-medium">Practice English through voice & guessing</p>
        </div>

        {/* Card */}
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-3xl p-6 space-y-5">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={20}
            className="w-full bg-white/10 text-white rounded-2xl px-5 py-4 text-base outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500 border border-white/10"
          />

          <div className="flex rounded-2xl overflow-hidden border border-white/10">
            <button
              onClick={() => setMode('create')}
              className={`flex-1 py-3.5 text-sm font-bold transition-all ${mode === 'create' ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white' : 'bg-white/5 text-gray-400'}`}
            >
              Create Room
            </button>
            <button
              onClick={() => setMode('join')}
              className={`flex-1 py-3.5 text-sm font-bold transition-all ${mode === 'join' ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white' : 'bg-white/5 text-gray-400'}`}
            >
              Join Room
            </button>
          </div>

          {mode === 'join' && (
            <input
              type="text"
              placeholder="Room code (e.g. ABC123)"
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase())}
              maxLength={6}
              className="w-full bg-white/10 text-white rounded-2xl px-5 py-4 text-base outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500 border border-white/10 uppercase tracking-[0.3em] text-center font-mono"
            />
          )}

          {error && <p className="text-red-400 text-sm text-center font-medium">{error}</p>}

          <button
            onClick={mode === 'create' ? handleCreate : handleJoin}
            disabled={loading}
            className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-400 hover:to-purple-400 disabled:opacity-50 active:scale-[0.97] text-white rounded-2xl py-5 text-lg font-bold shadow-xl shadow-indigo-500/30 transition-all duration-150"
          >
            {loading ? 'Creating...' : mode === 'create' ? 'Create Room' : 'Join Room'}
          </button>
        </div>

        <p className="text-center text-gray-600 text-xs">
          No download needed · Voice-powered · AI scoring
        </p>
      </div>
    </div>
  );
}

export type { SharedGameState };
