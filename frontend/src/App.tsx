import { useState, useCallback, useRef } from 'react';
import LobbyScreen from './screens/LobbyScreen';
import GameScreen from './screens/GameScreen';
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
        onRegisterHandler={(fn) => { screenHandlerRef.current = fn; }}
        onLeave={handleLeaveGame}
      />
    );
  }

  if (screen === 'game' && session) {
    return (
      <GameScreen
        roomId={session.roomId}
        playerName={session.playerName}
        shared={shared}
        send={send}
        connected={connected}
        onRegisterHandler={(fn) => { screenHandlerRef.current = fn; }}
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
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-white">20 Questions</h1>
          <p className="text-gray-400 text-sm">English Learning Game</p>
        </div>

        <div className="bg-gray-900 rounded-2xl p-6 space-y-4">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={20}
            className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-base outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500"
          />

          <div className="flex rounded-xl overflow-hidden border border-gray-700">
            <button
              onClick={() => setMode('create')}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${mode === 'create' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'}`}
            >
              Create Room
            </button>
            <button
              onClick={() => setMode('join')}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${mode === 'join' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'}`}
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
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-base outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500 uppercase tracking-widest"
            />
          )}

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            onClick={mode === 'create' ? handleCreate : handleJoin}
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl py-4 text-lg font-semibold transition-colors"
          >
            {loading ? 'Creating...' : mode === 'create' ? 'Create Room' : 'Join Room'}
          </button>
        </div>

        <p className="text-center text-gray-600 text-xs">
          No download required · Works in Safari, Chrome, Edge
        </p>
      </div>
    </div>
  );
}

export type { SharedGameState };
