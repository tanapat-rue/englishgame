import { useEffect } from 'react';
import { ClientMessage, GameState, ServerMessage } from '../types';

interface SharedGameState {
  gameState: GameState | null;
  myId: string | null;
}

interface Props {
  roomId: string;
  playerName: string;
  shared: SharedGameState;
  send: (msg: ClientMessage) => void;
  connected: boolean;
  onRegisterHandler: (fn: (msg: ServerMessage) => void) => void;
  onLeave: () => void;
}

export default function LobbyScreen({ roomId, playerName, shared, send, connected, onRegisterHandler, onLeave }: Props) {
  const { gameState, myId } = shared;

  // Register a no-op handler; App.tsx already handles room_state and screen transitions
  useEffect(() => {
    onRegisterHandler(() => {});
  }, [onRegisterHandler]);

  // Send join_room as soon as the WS is connected
  useEffect(() => {
    if (connected) {
      send({ type: 'join_room', playerName });
    }
    // Only run when connection first comes up — playerName won't change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const handleStartGame = () => {
    const connectedCount = gameState?.players.filter(p => p.isConnected).length ?? 0;
    if (connectedCount >= 2) send({ type: 'start_game' });
  };

  const connectedPlayers = gameState?.players.filter(p => p.isConnected) ?? [];
  const canStart = connectedPlayers.length >= 2;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-indigo-950/30 to-gray-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="text-5xl">🎮</div>
          <h2 className="text-2xl font-black text-white">Game Lobby</h2>
          <p className="text-gray-400 text-sm">Share the code with friends to join</p>
        </div>

        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-3xl p-6 space-y-5">
          {/* Room code */}
          <div className="text-center py-3">
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Room Code</p>
            <p className="text-5xl font-mono font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400 tracking-[0.2em]">
              {roomId}
            </p>
          </div>

          {/* Players */}
          <div className="space-y-2">
            <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">
              Players ({connectedPlayers.length}/6)
            </p>
            {connectedPlayers.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 animate-[fadeIn_0.3s_ease-in]"
                style={{ animationDelay: `${i * 100}ms` }}>
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-sm font-bold text-white shadow-lg shadow-indigo-500/20">
                  {p.name.charAt(0).toUpperCase()}
                </div>
                <span className="text-white font-semibold flex-1">{p.name}</span>
                {p.id === myId && (
                  <span className="text-xs bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-500/30">you</span>
                )}
                <span className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse" />
              </div>
            ))}
            {connectedPlayers.length === 0 && (
              <div className="text-center py-6">
                <div className="flex justify-center gap-1 mb-2">
                  <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce [animation-delay:0ms]" />
                  <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce [animation-delay:150ms]" />
                  <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce [animation-delay:300ms]" />
                </div>
                <p className="text-gray-500 text-sm">
                  {connected ? 'Waiting for players...' : 'Connecting...'}
                </p>
              </div>
            )}
          </div>

          {!connected && (
            <p className="text-yellow-400 text-sm text-center animate-pulse">Reconnecting...</p>
          )}

          <button
            onClick={handleStartGame}
            disabled={!canStart || !connected}
            className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-400 hover:to-emerald-400 disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97] text-white rounded-2xl py-5 text-lg font-bold shadow-xl shadow-green-500/30 transition-all duration-150"
          >
            {canStart ? '🚀 Start Game' : `Need ${2 - connectedPlayers.length} more player(s)`}
          </button>

          <button
            onClick={onLeave}
            className="w-full text-gray-500 hover:text-gray-300 text-sm py-2 transition-colors"
          >
            Leave Room
          </button>
        </div>
      </div>
    </div>
  );
}
