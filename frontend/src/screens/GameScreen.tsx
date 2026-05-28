import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatEntry, ClientMessage, GameState, ServerMessage } from '../types';
import { useWebRTC } from '../hooks/useWebRTC';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';

interface SharedGameState {
  gameState: GameState | null;
  myId: string | null;
  secretWord: string | null;
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

type ChatEntryKind = ChatEntry & { kind: 'question' | 'answer' };

export default function GameScreen({ playerName, shared, send, connected, onRegisterHandler, onLeave }: Props) {
  const [gameState, setGameState] = useState<GameState | null>(shared.gameState);
  const [myId] = useState<string | null>(shared.myId);
  // Initialise from shared so even if secret_word arrived before this screen mounted it shows
  const [secretWord, setSecretWord] = useState<string | null>(shared.secretWord);
  const [chatLog, setChatLog] = useState<ChatEntryKind[]>([]);
  const [gameOver, setGameOver] = useState<{ winnerName: string | null; secretWord: string; scores: Array<{ name: string; score: number }> } | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const isPressingRef = useRef(false);

  const { transcript, isListening, isSupported, startListening, stopListening } = useSpeechRecognition();

  const [iceServers, setIceServers] = useState<RTCIceServer[]>([]);
  useEffect(() => {
    const base = import.meta.env.DEV ? 'http://localhost:8787' : (import.meta.env.VITE_WORKER_URL ?? '');
    fetch(`${base}/api/turn-credentials`)
      .then(r => r.json())
      .then((d: { iceServers?: RTCIceServer[] }) => { if (d.iceServers?.length) setIceServers(d.iceServers); })
      .catch(() => {}); // silently fall back to STUN only
  }, []);

  const handleSendSignal = useCallback((targetId: string, signalData: unknown) => {
    send({ type: 'webrtc_signal', targetId, signalData });
  }, [send]);

  const { initLocalStream, setMuted, handleIncomingSignal, initiateConnectionTo, streamReady, remoteStreams, getAudioLevels, debugLog } = useWebRTC({
    myId,
    onSendSignal: handleSendSignal,
    iceServers,
  });

  // VU meter state — driven by our own RAF loop so the hook never calls setState at 60fps
  const localBarRef = useRef<HTMLDivElement>(null);
  const remoteBarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const { local, remote } = getAudioLevels();
      if (localBarRef.current) {
        localBarRef.current.style.width = `${Math.round(local * 100)}%`;
        localBarRef.current.style.backgroundColor = local > 0.6 ? '#4ade80' : local > 0.1 ? '#16a34a' : '#374151';
      }
      for (const [pid, el] of remoteBarRefs.current.entries()) {
        const lvl = remote.get(pid) ?? 0;
        el.style.width = `${Math.round(lvl * 100)}%`;
        el.style.backgroundColor = lvl > 0.6 ? '#4ade80' : lvl > 0.1 ? '#16a34a' : '#374151';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getAudioLevels]);

  const handleIncomingSignalRef = useRef(handleIncomingSignal);
  handleIncomingSignalRef.current = handleIncomingSignal;

  // Register message handler with App
  useEffect(() => {
    onRegisterHandler((msg: ServerMessage) => {
      switch (msg.type) {
        case 'room_state':
          setGameState(msg.state);
          break;
        case 'secret_word':
          setSecretWord(msg.word);
          break;
        case 'ai_evaluation':
          setChatLog(prev => [...prev, {
            id: crypto.randomUUID(),
            kind: 'question',
            playerName: msg.playerName,
            question: msg.question,
            score: msg.score,
            feedback: msg.feedback,
            highlightedWords: msg.highlightedWords,
            timestamp: Date.now(),
          }]);
          break;
        case 'giver_answer':
          setChatLog(prev => [...prev, {
            id: crypto.randomUUID(),
            kind: 'answer',
            playerName: msg.playerName,
            question: msg.answer,
            score: 0,
            feedback: '',
            highlightedWords: [],
            timestamp: Date.now(),
          }]);
          break;
        case 'turn_update':
          setGameState(prev => prev ? { ...prev, currentGuesserId: msg.currentGuesserId, questionsLeft: msg.questionsLeft } : prev);
          break;
        case 'game_over':
          setGameOver(msg);
          break;
        case 'webrtc_signal':
          handleIncomingSignalRef.current(msg.fromId, msg.signalData);
          break;
      }
    });
  }, [onRegisterHandler]);

  // Request mic + unblock audio on first user gesture.
  // Mobile browsers require getUserMedia to be called from a user gesture.
  const micInitedRef = useRef(false);
  useEffect(() => {
    const unlock = () => {
      if (!micInitedRef.current) {
        micInitedRef.current = true;
        initLocalStream();
      }
      document.querySelectorAll<HTMLAudioElement>('audio[data-remote]').forEach(el => {
        if (el.paused) el.play().catch(() => {});
      });
    };
    document.addEventListener('pointerdown', unlock);
    return () => document.removeEventListener('pointerdown', unlock);
  }, [initLocalStream]);

  // Initiate WebRTC offers once stream is ready and whenever players change
  useEffect(() => {
    if (!streamReady || !myId || !gameState) return;
    gameState.players.forEach(p => {
      // Only the lexicographically larger ID initiates to avoid double-offers
      if (p.id !== myId && p.isConnected && p.id > myId) {
        initiateConnectionTo(p.id);
      }
    });
  }, [streamReady, gameState, myId, initiateConnectionTo]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatLog]);

  const myRole = gameState?.players.find(p => p.id === myId)?.role;
  const isGiver = myRole === 'giver';
  const isMyTurn = !isGiver && myId !== null && gameState?.currentGuesserId === myId;

  // Hold-to-speak: unmute WebRTC AND start STT simultaneously
  const handlePressStart = useCallback(() => {
    if (isPressingRef.current) return;
    isPressingRef.current = true;
    if (!micInitedRef.current) {
      micInitedRef.current = true;
      initLocalStream();
    }
    setMuted(false);
    if (isSupported) startListening();
  }, [initLocalStream, setMuted, isSupported, startListening]);

  const handlePressEnd = useCallback(() => {
    if (!isPressingRef.current) return;
    isPressingRef.current = false;
    setMuted(true);
    const text = stopListening();
    if (!text.trim()) return;
    if (isMyTurn) {
      send({ type: 'ask_question', text: text.trim() });
    } else if (isGiver) {
      send({ type: 'giver_answer', answer: text.trim() });
    }
  }, [setMuted, stopListening, isMyTurn, isGiver, send]);

  const handleNextTurn = useCallback(() => send({ type: 'next_turn' }), [send]);

  const aiEnabled = gameState?.aiEnabled ?? false;
  const guessers = gameState?.players.filter(p => p.role === 'guesser') ?? [];
  const currentGuesser = gameState?.players.find(p => p.id === gameState?.currentGuesserId);

  if (gameOver) {
    return <GameOverScreen gameOver={gameOver} aiEnabled={aiEnabled} onLeave={onLeave} />;
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">

      {/* Hidden audio elements — one per remote peer */}
      {Array.from(remoteStreams.entries()).map(([peerId, stream]) => (
        <RemoteAudio key={peerId} stream={stream} onBlocked={() => setAudioBlocked(true)} />
      ))}

      {/* Autoplay-blocked banner — tap to unlock audio */}
      {audioBlocked && (
        <button
          onClick={() => {
            // Play all audio elements; this gesture unlocks autoplay for the page
            document.querySelectorAll('audio').forEach(a => a.play().catch(() => {}));
            setAudioBlocked(false);
          }}
          className="w-full bg-yellow-500 text-black font-bold text-sm py-3 text-center z-50"
        >
          🔇 Tap here to enable voice chat
        </button>
      )}

      {/* ── Header ── */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-gray-400 text-xs uppercase tracking-widest mb-1">
            {isGiver ? '🎯 You are the Giver' : '🔍 You are a Guesser'}
          </p>
          {isGiver && secretWord && (
            <div className="bg-indigo-900/60 border border-indigo-600 rounded-xl px-3 py-2 mt-1">
              <p className="text-gray-400 text-xs">Secret word</p>
              <p className="text-indigo-200 text-2xl font-bold tracking-wide">{secretWord}</p>
            </div>
          )}
          {!isGiver && aiEnabled && (
            <div className="flex items-center gap-1.5 mt-1">
              <p className="text-gray-400 text-xs">Your score:</p>
              <p className="text-yellow-400 font-bold text-sm">
                {gameState?.players.find(p => p.id === myId)?.score ?? 0} pts
              </p>
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-gray-400 text-xs">Questions left</p>
          <p className={`text-3xl font-bold tabular-nums ${(gameState?.questionsLeft ?? 0) <= 5 ? 'text-red-400' : 'text-white'}`}>
            {gameState?.questionsLeft ?? 20}
          </p>
        </div>
      </div>

      {/* ── Guesser scoreboard (visible to all) ── */}
      {guessers.length > 0 && (
        <div className="bg-gray-900/60 border-b border-gray-800 px-4 py-2 flex gap-3 overflow-x-auto">
          {guessers.filter(p => p.isConnected).map(p => (
            <div key={p.id} className={`flex items-center gap-2 rounded-xl px-3 py-1.5 flex-shrink-0 ${
              p.id === gameState?.currentGuesserId ? 'bg-green-900/60 ring-1 ring-green-500' : 'bg-gray-800'
            }`}>
              <div className="w-6 h-6 rounded-full bg-indigo-700 flex items-center justify-center text-xs font-bold text-indigo-100">
                {p.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-white text-xs font-medium leading-none">{p.name}{p.id === myId ? ' (you)' : ''}</p>
                {aiEnabled && <p className="text-yellow-400 text-xs leading-none mt-0.5">{p.score} pts</p>}
              </div>
              {p.id === gameState?.currentGuesserId && (
                <span className="text-green-400 text-xs ml-1">●</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Chat log ── */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {chatLog.length === 0 && (
          <p className="text-center text-gray-600 text-sm mt-10">
            Game started!{currentGuesser ? ` ${currentGuesser.name} asks first.` : ''}
          </p>
        )}
        {chatLog.map(entry => (
          <ChatBubble
            key={entry.id}
            entry={entry}
            isMe={entry.playerName === playerName}
            aiEnabled={aiEnabled}
          />
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* ── Turn label ── */}
      <div className="bg-gray-900 border-t border-gray-800 px-4 py-2 text-sm text-center">
        {isMyTurn
          ? <span className="text-green-400 font-semibold">Your turn to ask!</span>
          : isGiver
            ? <span className="text-orange-300">
                Listening to <span className="font-semibold">{currentGuesser?.name ?? '...'}</span>
              </span>
            : <span className="text-gray-400">
                <span className="text-white font-semibold">{currentGuesser?.name ?? '...'}</span> is asking...
              </span>
        }
      </div>

      {/* ── Controls ── */}
      <div className="bg-gray-900 border-t border-gray-800 p-4 space-y-3">

        {/* Current guesser's speaking button */}
        {isMyTurn && (
          <div className="space-y-2">
            {transcript && (
              <div className="bg-gray-800 rounded-xl px-4 py-3 text-white text-sm">
                {transcript}
              </div>
            )}
            <button
              onPointerDown={handlePressStart}
              onPointerUp={handlePressEnd}
              onPointerLeave={handlePressEnd}
              className={`w-full py-5 rounded-2xl text-white text-xl font-bold select-none transition-all ${
                isListening ? 'bg-red-600 scale-[0.98]' : 'bg-indigo-600 active:scale-[0.98]'
              }`}
            >
              {isListening ? '🎙️ Listening...' : '🎙️ Hold to Speak'}
            </button>
            {!isSupported && (
              <p className="text-yellow-400 text-xs text-center">
                Speech recognition not supported. Your voice is still sent — type if needed.
              </p>
            )}
          </div>
        )}

        {/* Giver controls */}
        {isGiver && (
          <div className="space-y-2">
            {transcript && (
              <div className="bg-gray-800 rounded-xl px-4 py-3 text-white text-sm">
                {transcript}
              </div>
            )}
            <button
              onPointerDown={handlePressStart}
              onPointerUp={handlePressEnd}
              onPointerLeave={handlePressEnd}
              className={`w-full py-4 rounded-2xl text-white text-base font-semibold select-none transition-all ${
                isListening ? 'bg-orange-600 scale-[0.98]' : 'bg-gray-700 active:scale-[0.98]'
              }`}
            >
              {isListening ? '🔊 Speaking...' : '🔊 Hold to Answer'}
            </button>
            <button
              onClick={handleNextTurn}
              className="w-full bg-green-600 hover:bg-green-500 active:scale-[0.98] text-white rounded-2xl py-4 text-base font-semibold transition-all"
            >
              Next Question →
            </button>
          </div>
        )}

        {/* Waiting state */}
        {!isMyTurn && !isGiver && (
          <p className="text-center text-gray-400 py-3">
            Waiting for <span className="text-white font-semibold">{currentGuesser?.name ?? '...'}</span> to ask...
          </p>
        )}

        {!connected && (
          <p className="text-yellow-400 text-xs text-center">Reconnecting...</p>
        )}
      </div>

      {/* ── WebRTC Debug Panel ── */}
      <details className="bg-black border-t border-gray-700">
        <summary className="px-3 py-1.5 text-xs text-gray-500 cursor-pointer select-none">
          🔧 WebRTC ({remoteStreams.size} peer{remoteStreams.size !== 1 ? 's' : ''}, mic: {streamReady ? '✅' : '❌'})
        </summary>
        <div className="px-3 pt-2 pb-1 space-y-1">
          {/* Local mic VU — bar updated directly via ref in RAF loop */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-[10px] w-16 flex-shrink-0">🎙️ local</span>
            <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div ref={localBarRef} className="h-full rounded-full" style={{ width: '0%' }} />
            </div>
          </div>
          {/* Remote VU bars — one per stream, bar updated via ref */}
          {Array.from(remoteStreams.keys()).map(pid => (
            <div key={pid} className="flex items-center gap-2">
              <span className="text-gray-500 text-[10px] w-16 flex-shrink-0 truncate">🔈 {pid.slice(0, 6)}</span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  ref={el => { if (el) remoteBarRefs.current.set(pid, el); else remoteBarRefs.current.delete(pid); }}
                  className="h-full rounded-full"
                  style={{ width: '0%' }}
                />
              </div>
            </div>
          ))}
          {remoteStreams.size === 0 && <p className="text-gray-600 text-[10px]">no remote streams yet</p>}
        </div>
        <div className="px-3 pb-2 max-h-36 overflow-y-auto font-mono text-[10px] text-green-400 space-y-0.5 border-t border-gray-800 mt-1 pt-1">
          {debugLog.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      </details>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RemoteAudio({ stream, onBlocked }: { stream: MediaStream; onBlocked: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  // Use a ref for onBlocked so the effect never needs to re-run due to a new callback identity
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => onBlockedRef.current());
    // Only re-run when the stream itself changes, not on every render
  }, [stream]);
  return <audio ref={ref} data-remote="true" />;
}


function ChatBubble({ entry, isMe, aiEnabled }: { entry: ChatEntryKind; isMe: boolean; aiEnabled: boolean }) {
  const isAnswer = entry.kind === 'answer';
  return (
    <div className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
      <p className="text-gray-500 text-xs mb-1 px-1">
        {isAnswer ? `${entry.playerName} (answer)` : entry.playerName}
      </p>
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 space-y-2 ${
        isAnswer
          ? 'bg-orange-900/60 border border-orange-700'
          : isMe ? 'bg-indigo-800' : 'bg-gray-800'
      }`}>
        <p className="text-white text-base">{entry.question}</p>
        {!isAnswer && aiEnabled && (
          <>
            <div className="flex items-center gap-2">
              <ScoreBadge score={entry.score} />
              <p className="text-gray-300 text-xs flex-1">{entry.feedback}</p>
            </div>
            {entry.highlightedWords.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {entry.highlightedWords.map(w => (
                  <span key={w} className="bg-yellow-800 text-yellow-200 text-xs px-2 py-0.5 rounded-full">{w}</span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 8 ? 'bg-green-700 text-green-100' : score >= 5 ? 'bg-yellow-700 text-yellow-100' : 'bg-red-800 text-red-200';
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${color}`}>{score}/10</span>;
}

function GameOverScreen({ gameOver, aiEnabled, onLeave }: {
  gameOver: { winnerName: string | null; secretWord: string; scores: Array<{ name: string; score: number }> };
  aiEnabled: boolean;
  onLeave: () => void;
}) {
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <p className="text-5xl">{gameOver.winnerName ? '🏆' : '😔'}</p>
          <h2 className="text-2xl font-bold text-white">
            {gameOver.winnerName ? `${gameOver.winnerName} won!` : 'No one guessed it!'}
          </h2>
          <p className="text-gray-400">
            The secret word was: <span className="text-indigo-300 font-bold">{gameOver.secretWord}</span>
          </p>
        </div>
        <div className="bg-gray-900 rounded-2xl p-6 space-y-3">
          <p className="text-gray-400 text-xs uppercase tracking-widest">
            {aiEnabled ? 'Final Scores' : 'Players'}
          </p>
          {gameOver.scores.map((s, i) => (
            <div key={s.name} className="flex items-center gap-3 bg-gray-800 rounded-xl px-4 py-3">
              <span className="text-lg">{i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}</span>
              <span className="text-white font-medium flex-1">{s.name}</span>
              {aiEnabled && <span className="text-yellow-400 font-bold">{s.score} pts</span>}
            </div>
          ))}
        </div>
        <button
          onClick={onLeave}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl py-4 text-lg font-semibold transition-colors"
        >
          Play Again
        </button>
      </div>
    </div>
  );
}
