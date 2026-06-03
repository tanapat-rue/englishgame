import { useCallback, useRef, useState } from 'react';

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionError extends Event {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionError) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

export function useSpeechRecognition() {
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // Both refs stay in sync — finalAccumRef holds committed final text,
  // interimRef holds the current in-progress segment.
  // stopListening reads refs directly so it's never stale.
  const finalAccumRef = useRef('');
  const interimRef = useRef('');

  const isSupported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const startListening = useCallback(() => {
    if (!isSupported) return;
    finalAccumRef.current = '';
    interimRef.current = '';
    setTranscript('');

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (ev) => {
      let newFinal = '';
      let newInterim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const text = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) newFinal += text;
        else newInterim += text;
      }
      if (newFinal) {
        finalAccumRef.current = (finalAccumRef.current
          ? finalAccumRef.current + ' ' + newFinal.trim()
          : newFinal.trim());
        interimRef.current = '';
      } else {
        interimRef.current = newInterim;
      }
      const display = finalAccumRef.current + (interimRef.current ? ' ' + interimRef.current : '');
      setTranscript(display.trim());
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => {
      setIsListening(false);
      // Promote any remaining interim to final on end
      if (interimRef.current.trim()) {
        finalAccumRef.current = (finalAccumRef.current
          ? finalAccumRef.current + ' ' + interimRef.current.trim()
          : interimRef.current.trim());
        interimRef.current = '';
        setTranscript(finalAccumRef.current);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isSupported]);

  const stopListening = useCallback((): string => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
    // Promote any interim that hasn't been finalised yet
    const interim = interimRef.current.trim();
    if (interim) {
      finalAccumRef.current = (finalAccumRef.current
        ? finalAccumRef.current + ' ' + interim
        : interim);
      interimRef.current = '';
    }
    const result = finalAccumRef.current.trim();
    setTranscript(result);
    return result;
  }, []); // no deps — reads refs directly, always current

  return { transcript, isListening, isSupported, startListening, stopListening };
}
