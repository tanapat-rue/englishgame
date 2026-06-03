import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientMessage, GameState, ServerMessage, SpeakEntry } from '../types';
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

const QWERTY_ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
];

export default function HangmanScreen({ playerName, shared, send, connected, onRegisterHandler, onLeave }: Props) {
  const [gameState, setGameState] = useState<GameState | null>(shared.gameState);
  const [myId] = useState<string | null>(shared.myId);
  const [secretWord, setSecretWord] = useState<string | null>(shared.secretWord);
  const [speakLog, setSpeakLog] = useState<SpeakEntry[]>([]);
  const [guessedLetters, setGuessedLetters] = useState<string[]>(shared.gameState?.guessedLetters ?? []);
  const [wrongLetters, setWrongLetters] = useState<string[]>(shared.gameState?.wrongLetters ?? []);
  const [hintsUsed, setHintsUsed] = useState(shared.gameState?.hintsUsed ?? 0);
  const [gameOver, setGameOver] = useState<{ winnerTeam: 'guessers' | 'master'; secretWord: string; scores: Array<{ name: string; score: number }> } | null>(null);
  const [lastEvent, setLastEvent] = useState<{ type: 'correct' | 'wrong' | 'hint'; label: string } | null>(null);
  const [newLetters, setNewLetters] = useState<Set<string>>(new Set());
  const [audioBlocked, setAudioBlocked] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const isPressingRef = useRef(false);

  const { transcript, isListening, isSupported, startListening, stopListening } = useSpeechRecognition();

  const [iceServers, setIceServers] = useState<RTCIceServer[]>([]);
  useEffect(() => {
    const base = import.meta.env.DEV ? 'http://localhost:8787' : (import.meta.env.VITE_WORKER_URL ?? '');
    fetch(`${base}/api/turn-credentials`)
      .then(r => r.json())
      .then((d: { iceServers?: RTCIceServer[] }) => { if (d.iceServers?.length) setIceServers(d.iceServers); })
      .catch(() => {});
  }, []);

  const handleSendSignal = useCallback((targetId: string, signalData: unknown) => {
    send({ type: 'webrtc_signal', targetId, signalData });
  }, [send]);

  const { initLocalStream, setMuted, handleIncomingSignal, initiateConnectionTo, streamReady, remoteStreams, getAudioLevels, debugLog } = useWebRTC({
    myId, onSendSignal: handleSendSignal, iceServers,
  });

  // VU meter — RAF driven, no React state
  const localBarRef = useRef<HTMLDivElement>(null);
  const remoteBarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const { local, remote } = getAudioLevels();
      if (localBarRef.current) {
        localBarRef.current.style.width = `${Math.round(local * 100)}%`;
        localBarRef.current.style.backgroundColor = local > 0.1 ? '#4ade80' : '#374151';
      }
      for (const [pid, el] of remoteBarRefs.current.entries()) {
        const lvl = remote.get(pid) ?? 0;
        el.style.width = `${Math.round(lvl * 100)}%`;
        el.style.backgroundColor = lvl > 0.1 ? '#4ade80' : '#374151';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getAudioLevels]);

  const handleIncomingSignalRef = useRef(handleIncomingSignal);
  handleIncomingSignalRef.current = handleIncomingSignal;

  useEffect(() => {
    onRegisterHandler((msg: ServerMessage) => {
      switch (msg.type) {
        case 'room_state':
          setGameState(msg.state);
          setGuessedLetters(msg.state.guessedLetters);
          setWrongLetters(msg.state.wrongLetters);
          setHintsUsed(msg.state.hintsUsed);
          break;
        case 'secret_word':
          setSecretWord(msg.word);
          break;
        case 'letter_result':
          setGuessedLetters(msg.guessedLetters);
          setWrongLetters(msg.wrongLetters);
          if (msg.correct) {
            setNewLetters(prev => new Set(prev).add(msg.letter));
            setTimeout(() => setNewLetters(prev => { const s = new Set(prev); s.delete(msg.letter); return s; }), 600);
            setLastEvent({ type: 'correct', label: `✅ ${msg.letter.toUpperCase()} — ${msg.playerName}!` });
          } else {
            setLastEvent({ type: 'wrong', label: `❌ No "${msg.letter.toUpperCase()}"` });
          }
          setTimeout(() => setLastEvent(null), 2000);
          break;
        case 'hint_given':
          setGuessedLetters(prev => [...prev, msg.letter]);
          setHintsUsed(msg.hintsUsed);
          setNewLetters(prev => new Set(prev).add(msg.letter));
          setTimeout(() => setNewLetters(prev => { const s = new Set(prev); s.delete(msg.letter); return s; }), 600);
          setLastEvent({ type: 'hint', label: `💡 Hint: "${msg.letter.toUpperCase()}"` });
          setTimeout(() => setLastEvent(null), 2000);
          break;
        case 'speak_logged':
          setSpeakLog(prev => [...prev, msg.entry]);
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

  // Mic init
  useEffect(() => { initLocalStream(); }, [initLocalStream]);
  useEffect(() => {
    const unlock = () => {
      initLocalStream();
      document.querySelectorAll<HTMLAudioElement>('audio[data-remote]').forEach(el => {
        if (el.paused) el.play().catch(() => {});
      });
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('touchstart', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, [initLocalStream]);

  // WebRTC connections
  useEffect(() => {
    if (!streamReady || !myId || !gameState) return;
    gameState.players.forEach(p => {
      if (p.id !== myId && p.isConnected && p.id > myId) initiateConnectionTo(p.id);
    });
  }, [streamReady, gameState, myId, initiateConnectionTo]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [speakLog]);

  const isWordMaster = gameState?.players.find(p => p.id === myId)?.role === 'word_master';
  const wordLength = gameState?.wordLength ?? 0;
  const wordLetters = isWordMaster && secretWord ? secretWord.split('') : Array.from({ length: wordLength }, () => '');
  const wrongCount = wrongLetters.length;
  const livesLeft = (gameState?.maxWrong ?? 6) - wrongCount;
  const myScore = gameState?.players.find(p => p.id === myId)?.score ?? 0;

  const handleGuessLetter = useCallback((letter: string) => {
    if (guessedLetters.includes(letter) || isWordMaster) return;
    send({ type: 'guess_letter', letter });
  }, [guessedLetters, isWordMaster, send]);

  const handleGiveHint = useCallback(() => {
    if (hintsUsed >= 3) return;
    send({ type: 'give_hint' });
  }, [hintsUsed, send]);

  const handlePressStart = useCallback(() => {
    if (isPressingRef.current) return;
    isPressingRef.current = true;
    initLocalStream();
    setMuted(false);
    if (isSupported) startListening();
  }, [initLocalStream, setMuted, isSupported, startListening]);

  const handlePressEnd = useCallback(() => {
    if (!isPressingRef.current) return;
    isPressingRef.current = false;
    setMuted(true);
    const text = stopListening();
    if (text.trim()) send({ type: 'speak_log', text: text.trim() });
  }, [setMuted, stopListening, send]);

  if (gameOver) {
    return <GameOverScreen gameOver={gameOver} onLeave={onLeave} />;
  }

  return (
    <div className="h-screen bg-gray-950 flex flex-col overflow-hidden">

      {/* Hidden audio */}
      {Array.from(remoteStreams.entries()).map(([pid, stream]) => (
        <RemoteAudio key={pid} stream={stream} onBlocked={() => setAudioBlocked(true)} />
      ))}

      {!streamReady && (
        <button onClick={() => initLocalStream()}
          className="flex-shrink-0 w-full bg-indigo-600 text-white font-bold text-sm py-2.5 text-center">
          🎙️ Tap to enable microphone
        </button>
      )}

      {audioBlocked && streamReady && (
        <button onClick={() => { document.querySelectorAll<HTMLAudioElement>('audio').forEach(a => a.play().catch(() => {})); setAudioBlocked(false); }}
          className="flex-shrink-0 w-full bg-yellow-500 text-black font-bold text-sm py-2.5 text-center">
          🔇 Tap to enable voice chat
        </button>
      )}

      {/* ═══ HEADER ═══ */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 pt-3 pb-1">
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${
          isWordMaster ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
        }`}>
          <span>{isWordMaster ? '🎯' : '🔍'}</span>
          <span>{isWordMaster ? 'Word Master' : 'Guesser'}</span>
        </div>

        {/* Lives */}
        <div className="flex items-center gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={`text-lg transition-all duration-300 ${i < livesLeft ? 'opacity-100' : 'opacity-20 scale-75'}`}>
              ❤️
            </span>
          ))}
        </div>

        <div className="text-right">
          <p className="text-yellow-400 font-black text-lg leading-none">{myScore}</p>
          <p className="text-gray-600 text-[10px]">pts</p>
        </div>
      </div>

      {/* ═══ PLAYERS STRIP ═══ */}
      <div className="flex-shrink-0 px-3 pb-1 flex gap-1.5 overflow-x-auto">
        {gameState?.players.filter(p => p.isConnected).map(p => {
          const level = remoteLevelForPlayer(p.id, myId, remoteBarRefs);
          return (
            <div key={p.id} className={`flex-shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-lg ${p.id === myId ? 'bg-indigo-500/20' : 'bg-white/5'}`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 ${p.role === 'word_master' ? 'bg-amber-500' : 'bg-indigo-600'} text-white`}>
                {p.name.charAt(0).toUpperCase()}
              </div>
              <span className="text-white text-[11px] font-medium">{p.id === myId ? 'You' : p.name}</span>
              <span className="text-yellow-400 text-[10px]">{p.score}</span>
              {/* Speaking indicator — driven by a data attr the RAF loop updates */}
              <div className="w-4 h-1.5 bg-gray-800 rounded-full overflow-hidden flex-shrink-0">
                <div
                  data-player-bar={p.id}
                  ref={el => { if (el) remoteBarRefs.current.set(p.id, el); else remoteBarRefs.current.delete(p.id); }}
                  className="h-full rounded-full transition-none"
                  style={{ width: '0%' }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ═══ HANGMAN + WORD ═══ */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-1">
        {/* Hangman drawing */}
        <HangmanDrawing wrongCount={wrongCount} />

        {/* Word + event flash */}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 pl-2">
          {/* Secret word (master) or blank slots (guesser) */}
          {isWordMaster ? (
            <div className="bg-amber-900/20 border border-amber-600/30 rounded-xl px-4 py-2 text-center w-full">
              <p className="text-amber-400/60 text-[10px] mb-1">Secret Word</p>
              <p className="text-amber-200 text-2xl font-black tracking-widest uppercase">{secretWord}</p>
            </div>
          ) : (
            <div className="flex flex-wrap justify-center gap-1.5">
              {wordLetters.map((letter, i) => (
                <LetterSlot key={i} letter={letter} revealed={letter !== '' && guessedLetters.includes(letter)} isNew={newLetters.has(letter)} />
              ))}
            </div>
          )}

          {/* Event flash */}
          {lastEvent && (
            <div className={`px-4 py-1.5 rounded-full text-sm font-bold text-center ${
              lastEvent.type === 'correct' ? 'bg-green-500/20 text-green-300 border border-green-500/30' :
              lastEvent.type === 'hint' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' :
              'bg-red-500/20 text-red-300 border border-red-500/30'
            }`}>
              {lastEvent.label}
            </div>
          )}

          {/* Wrong letters */}
          {wrongLetters.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1">
              {wrongLetters.map(l => (
                <span key={l} className="w-6 h-6 rounded-md bg-red-900/40 border border-red-600/40 text-red-400 text-xs font-bold flex items-center justify-center uppercase">
                  {l}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ═══ WORD MASTER HINT ═══ */}
      {isWordMaster && (
        <div className="flex-shrink-0 px-4 pb-1">
          <button
            onClick={handleGiveHint}
            disabled={hintsUsed >= 3}
            className={`w-full py-2.5 rounded-xl font-bold text-sm transition-all ${
              hintsUsed >= 3
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white active:scale-[0.98]'
            }`}
          >
            💡 Give Hint ({3 - hintsUsed} left) — reveals a random letter
          </button>
        </div>
      )}

      {/* ═══ KEYBOARD (guessers) ═══ */}
      {!isWordMaster && (
        <div className="flex-shrink-0 px-2 pb-1 space-y-1">
          {QWERTY_ROWS.map((row, ri) => (
            <div key={ri} className="flex justify-center gap-1">
              {row.map(letter => {
                const isWrong = wrongLetters.includes(letter);
                const isCorrect = guessedLetters.includes(letter) && !isWrong;
                const isUsed = guessedLetters.includes(letter);
                return (
                  <button
                    key={letter}
                    onClick={() => handleGuessLetter(letter)}
                    disabled={isUsed}
                    className={`w-9 h-10 rounded-lg font-bold text-sm uppercase select-none transition-all duration-150 ${
                      isWrong ? 'bg-red-900/30 text-red-600 border border-red-800/30' :
                      isCorrect ? 'bg-green-900/30 text-green-600 border border-green-800/30' :
                      'bg-gray-800 text-white border border-gray-700 active:scale-90 active:bg-indigo-600'
                    }`}
                  >
                    {letter}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* ═══ VOICE SECTION ═══ */}
      <div className="flex-1 flex flex-col min-h-0 px-3 pb-3 pt-1 gap-2">
        {/* Log */}
        <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0">
          {speakLog.length === 0 ? (
            <p className="text-gray-600 text-xs text-center pt-2">Discuss clues with your team — hold to talk</p>
          ) : speakLog.map((entry, i) => (
            <div key={i} className={`rounded-xl px-3 py-2 ${entry.playerName === playerName ? 'bg-indigo-950/60 border border-indigo-800/40 ml-6' : 'bg-gray-900 mr-6'}`}>
              <div className="flex justify-between items-center mb-0.5">
                <span className="text-gray-400 text-[10px] font-semibold">{entry.playerName === playerName ? 'You' : entry.playerName}</span>
                <span className="text-yellow-500 text-[10px] font-bold">+{entry.score}pts</span>
              </div>
              <p className="text-white text-sm">{entry.text}</p>
              {entry.words.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {entry.words.map(w => (
                    <span key={w} className="text-emerald-400/60 text-[10px] bg-emerald-900/20 px-1.5 rounded-full">{w}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>

        {/* Transcript preview */}
        {transcript && (
          <div className="flex-shrink-0 bg-white/5 rounded-xl px-3 py-2 text-white text-sm border border-white/10">
            {transcript}
          </div>
        )}

        {/* Hold to talk */}
        <button
          onPointerDown={handlePressStart}
          onPointerUp={handlePressEnd}
          onPointerLeave={handlePressEnd}
          onTouchStart={handlePressStart}
          onTouchEnd={handlePressEnd}
          className={`flex-shrink-0 w-full rounded-2xl py-3.5 text-white font-bold text-base select-none transition-all duration-150 ${
            isListening
              ? 'bg-gradient-to-r from-red-500 to-pink-500 scale-[0.98] shadow-lg shadow-red-500/30'
              : 'bg-gradient-to-r from-indigo-600/50 to-purple-600/50 border border-indigo-500/30 active:scale-[0.98]'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            {isListening ? (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
                Recording...
              </>
            ) : <>🎙️ Hold to Talk</>}
          </span>
        </button>

        {!connected && <p className="text-yellow-400 text-xs text-center animate-pulse">Reconnecting...</p>}
      </div>

      {/* Debug */}
      <details className="flex-shrink-0 bg-black/60 border-t border-gray-800/50">
        <summary className="px-3 py-1 text-[10px] text-gray-700 cursor-pointer">
          debug ({remoteStreams.size} peers, mic {streamReady ? '✅' : '❌'})
        </summary>
        <div className="px-3 pt-1 pb-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-gray-700 text-[9px] w-8">local</span>
            <div className="flex-1 h-1 bg-gray-900 rounded-full overflow-hidden">
              <div ref={localBarRef} className="h-full rounded-full" style={{ width: '0%' }} />
            </div>
          </div>
        </div>
        <div className="px-3 pb-1 max-h-16 overflow-y-auto font-mono text-[9px] text-green-500/50">
          {debugLog.slice(-10).map((l, i) => <p key={i}>{l}</p>)}
        </div>
      </details>
    </div>
  );
}

// dummy to avoid unused import error — bar refs are set by the RAF loop
function remoteLevelForPlayer(_pid: string, _myId: string | null, _refs: React.MutableRefObject<Map<string, HTMLDivElement>>) {
  return 0;
}

// ═══ HANGMAN SVG ══════════════════════════════════════════════════════════════

function HangmanDrawing({ wrongCount }: { wrongCount: number }) {
  const parts = [
    // 1: head
    <circle key="head" cx="90" cy="38" r="14" stroke="#ef4444" strokeWidth="3" fill="none" />,
    // 2: body
    <line key="body" x1="90" y1="52" x2="90" y2="100" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />,
    // 3: left arm
    <line key="la" x1="90" y1="65" x2="65" y2="85" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />,
    // 4: right arm
    <line key="ra" x1="90" y1="65" x2="115" y2="85" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />,
    // 5: left leg
    <line key="ll" x1="90" y1="100" x2="65" y2="130" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />,
    // 6: right leg
    <line key="rl" x1="90" y1="100" x2="115" y2="130" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />,
  ];

  return (
    <svg width="150" height="155" viewBox="0 0 150 155" className="flex-shrink-0">
      {/* Gallows — always visible */}
      <line x1="15" y1="148" x2="135" y2="148" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      <line x1="40" y1="148" x2="40" y2="10" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      <line x1="40" y1="10" x2="90" y2="10" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      <line x1="90" y1="10" x2="90" y2="24" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      {/* Body parts revealed progressively */}
      {parts.slice(0, wrongCount).map(p => p)}
      {/* Face details on wrong=1 */}
      {wrongCount >= 1 && (
        <>
          <circle cx="85" cy="34" r="2" fill="#ef4444" />
          <circle cx="95" cy="34" r="2" fill="#ef4444" />
          <path d={wrongCount >= 6 ? "M 84 44 Q 90 40 96 44" : "M 84 42 Q 90 46 96 42"} stroke="#ef4444" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

// ═══ LETTER SLOT ══════════════════════════════════════════════════════════════

function LetterSlot({ letter, revealed, isNew }: { letter: string; revealed: boolean; isNew: boolean }) {
  return (
    <div className={`w-8 h-10 flex flex-col items-center justify-end pb-0.5 border-b-2 transition-colors duration-200 ${
      revealed ? 'border-green-400' : 'border-gray-600'
    }`}>
      <span className={`text-lg font-black uppercase transition-all duration-300 ${
        revealed
          ? `text-white ${isNew ? 'scale-125 text-green-300' : 'scale-100'}`
          : 'scale-0 text-transparent'
      }`}>
        {letter}
      </span>
    </div>
  );
}

// ═══ REMOTE AUDIO ═════════════════════════════════════════════════════════════

function RemoteAudio({ stream, onBlocked }: { stream: MediaStream; onBlocked: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => onBlockedRef.current());
  }, [stream]);
  return <audio ref={ref} data-remote="true" />;
}

// ═══ GAME OVER ════════════════════════════════════════════════════════════════

function GameOverScreen({ gameOver, onLeave }: {
  gameOver: { winnerTeam: 'guessers' | 'master'; secretWord: string; scores: Array<{ name: string; score: number }> };
  onLeave: () => void;
}) {
  const win = gameOver.winnerTeam === 'guessers';
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-4">
          <div className={`text-8xl ${win ? 'animate-bounce' : ''}`}>{win ? '🎉' : '💀'}</div>
          <h2 className="text-3xl font-black text-white">{win ? 'Guessers Win! 🎊' : 'Word Master Wins!'}</h2>
          <div className="inline-flex items-center gap-3 bg-white/10 backdrop-blur-sm rounded-2xl px-6 py-3 border border-white/20">
            <span className="text-gray-400">The word was</span>
            <span className="text-white font-black text-2xl tracking-widest uppercase">{gameOver.secretWord}</span>
          </div>
        </div>

        <div className="space-y-2">
          {gameOver.scores.map((s, i) => (
            <div key={s.name} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${
              i === 0 ? 'bg-gradient-to-r from-yellow-900/40 to-amber-900/30 border border-yellow-600/40' : 'bg-white/5 border border-white/10'
            }`}>
              <span className="text-xl w-8 text-center">{['🥇','🥈','🥉'][i] ?? `${i+1}.`}</span>
              <span className="text-white font-semibold flex-1">{s.name}</span>
              <span className={`font-black text-xl ${i === 0 ? 'text-yellow-400' : 'text-gray-400'}`}>{s.score}</span>
            </div>
          ))}
        </div>

        <button onClick={onLeave}
          className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 active:scale-[0.97] text-white rounded-3xl py-5 text-xl font-black shadow-2xl shadow-indigo-500/30 transition-all">
          Play Again
        </button>
      </div>
    </div>
  );
}
