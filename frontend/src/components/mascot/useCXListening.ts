import { useEffect, useRef, useState } from "react";

type SpeechResult = { isFinal: boolean; length?: number; [index: number]: { transcript: string } };
type TranscriptEvent = {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
};

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  phrases?: { push: (phrase: unknown) => void };
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: TranscriptEvent) => void) | null;
  start: () => void;
  abort: () => void;
}

function recognitionConstructor() {
  const browser = window as Window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

type Phase = "off" | "starting" | "listening" | "working" | "speaking" | "error";
export type VoiceOutput = (text: string, done?: () => void) => void;
export type VoiceSession = {
  reply: (text: string) => void;
  wait: () => void;
  stop: () => void;
};

export function useCXListening(
  read: VoiceOutput | undefined,
  onCommand: (transcript: string, session: VoiceSession) => Promise<void>,
  onStop: () => void,
  keepListening: boolean,
  language: string,
  chooseTranscript: (candidates: string[]) => string,
) {
  const [phase, setPhase] = useState<Phase>("off");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const latest = useRef({ read, onCommand, onStop, keepListening, language, chooseTranscript });
  latest.current = { read, onCommand, onStop, keepListening, language, chooseTranscript };
  const state = useRef<{
    enabled: boolean;
    recognizer?: Recognition;
    timer?: number;
    lastInput: number;
    speaking: boolean;
    working: boolean;
    emptyEnds: number;
    retryWithoutPhrases: boolean;
    generation: number;
    speechId: number;
  }>({ enabled: false, lastInput: 0, speaking: false, working: false, emptyEnds: 0, retryWithoutPhrases: false, generation: 0, speechId: 0 }).current;

  function releaseMic() {
    const recognizer = state.recognizer;
    state.recognizer = undefined;
    if (!recognizer) return;
    recognizer.onstart = recognizer.onend = recognizer.onerror = recognizer.onresult = null;
    recognizer.abort();
  }

  function releaseSession() {
    state.enabled = false;
    state.generation += 1;
    window.clearTimeout(state.timer);
    releaseMic();
    if (state.speaking) window.speechSynthesis?.cancel();
    state.speaking = false;
    state.working = false;
    latest.current.onStop();
  }

  function stop() {
    releaseSession();
    setPhase("off");
    setError("");
  }

  function fail(message: string) {
    releaseSession();
    setError(message);
    setPhase("error");
  }

  function resume(delay = 350) {
    if (!state.enabled) return;
    state.working = false;
    setPhase("starting");
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(listen, delay);
  }

  function speak(text: string) {
    if (!state.enabled || state.speaking || !latest.current.read) return false;
    window.clearTimeout(state.timer);
    releaseMic();
    state.working = false;
    state.speaking = true;
    const speechId = ++state.speechId;
    setPhase("speaking");
    const finish = () => {
      if (!state.enabled || !state.speaking || state.speechId !== speechId) return;
      state.speaking = false;
      window.clearTimeout(state.timer);
      resume();
    };
    state.timer = window.setTimeout(() => {
      window.speechSynthesis?.cancel();
      finish();
    }, Math.max(10_000, text.length * 130));
    latest.current.read(text, finish);
    return true;
  }

  function execute(transcript: string, fromSpeech = true) {
    if (!state.enabled || state.working) return;
    state.working = true;
    window.clearTimeout(state.timer);
    releaseMic();
    if (state.speaking) {
      state.speechId += 1;
      state.speaking = false;
      window.speechSynthesis?.cancel();
    }
    if (fromSpeech) setTranscript(transcript);
    setPhase("working");
    const generation = state.generation;
    const current = () => state.enabled && state.generation === generation;
    const session: VoiceSession = {
      reply: (text) => {
        if (!current()) return;
        state.lastInput = Date.now();
        speak(text);
      },
      wait: () => { if (current()) resume(); },
      stop: () => { if (current()) stop(); },
    };
    void latest.current.onCommand(transcript, session).catch(() => {
      if (current()) session.reply("I couldn’t finish that request. Please try again.");
    });
  }

  function listen() {
    if (!state.enabled) return;
    if (document.hidden || (!latest.current.keepListening && Date.now() - state.lastInput > 5 * 60_000)) {
      stop();
      return;
    }
    const RecognitionClass = recognitionConstructor();
    if (!RecognitionClass) return;
    const recognition = new RecognitionClass();
    state.recognizer = recognition;
    recognition.lang = latest.current.language;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    const Phrase = (window as Window & { SpeechRecognitionPhrase?: new (text: string, boost: number) => unknown }).SpeechRecognitionPhrase;
    if (Phrase && recognition.phrases && !state.retryWithoutPhrases) {
      try {
        for (const hint of ["Hello CX", "Bengaluru", "Mysuru", "Lalbagh", "road flood risk", "storm replay"]) {
          recognition.phrases.push(new Phrase(hint, 2));
        }
      } catch {
        state.retryWithoutPhrases = true;
      }
    }
    let candidates: string[] = [];
    let recoverableError = "";
    recognition.onstart = () => {
      if (state.recognizer === recognition) setPhase("listening");
    };
    recognition.onresult = (event) => {
      if (state.recognizer !== recognition) return;
      const results = Array.from(event.results);
      const heard = results.map((result) => result[0]?.transcript.trim() ?? "").filter(Boolean).join(" ");
      if (heard) setTranscript(heard);
      const finals = results.filter((result) => result.isFinal && result[0]?.transcript.trim());
      const primary = finals.map((result) => result[0].transcript.trim());
      const alternatives = finals.flatMap((result, index) =>
        Array.from({ length: Math.min(result.length ?? 1, 3) - 1 }, (_, alternate) => {
          const parts = [...primary];
          parts[index] = result[alternate + 1]?.transcript.trim() || parts[index];
          return parts.join(" ");
        }));
      candidates = primary.length ? [primary.join(" "), ...new Set(alternatives)] : [];
    };
    recognition.onerror = ({ error }) => {
      if (state.recognizer !== recognition) return;
      if (error === "phrases-not-supported" && !state.retryWithoutPhrases) {
        state.retryWithoutPhrases = true;
        releaseMic();
        resume();
        return;
      }
      if (["no-speech", "network", "aborted"].includes(error)) {
        recoverableError = error;
        return;
      }
      fail(error === "not-allowed" || error === "service-not-allowed"
        ? "Allow microphone access in your browser to talk to CX."
        : error === "audio-capture" ? "CX couldn’t access a microphone."
          : "Speech recognition is unavailable. Start a new voice session to try again.");
    };
    recognition.onend = () => {
      if (state.recognizer !== recognition) return;
      state.recognizer = undefined;
      if (!candidates.length) {
        state.emptyEnds += 1;
        if (state.emptyEnds >= (recoverableError === "network" ? 3 : 4)) fail(recoverableError === "no-speech"
          ? "I didn’t hear a request. Check your microphone, then try again."
          : "Speech recognition stopped. Try voice again or type your request.");
        else resume(recoverableError === "network" ? 700 * state.emptyEnds : 350);
        return;
      }
      state.emptyEnds = 0;
      execute(latest.current.chooseTranscript(candidates));
    };
    try {
      recognition.start();
    } catch {
      fail("CX couldn’t start the microphone. Check your browser permissions and try again.");
    }
  }

  function start() {
    if (state.enabled || !read || !recognitionConstructor()) return;
    window.speechSynthesis?.cancel();
    state.lastInput = Date.now();
    state.emptyEnds = 0;
    state.retryWithoutPhrases = false;
    state.enabled = true;
    setTranscript("");
    setError("");
    setPhase("starting");
    listen();
  }

  useEffect(() => {
    const onVisibility = () => { if (document.hidden && state.enabled) stop(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      releaseSession();
    };
    // The lifecycle handlers close over stable refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = phase !== "off" && phase !== "error";
  return { active, phase, error, transcript, supported: Boolean(read && recognitionConstructor()), start, stop, speak, execute };
}
