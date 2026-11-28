import { useEffect, useRef, useState } from "react";

type TranscriptEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
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
) {
  const [phase, setPhase] = useState<Phase>("off");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const latest = useRef({ read, onCommand, onStop, keepListening });
  latest.current = { read, onCommand, onStop, keepListening };
  const state = useRef<{
    enabled: boolean;
    recognizer?: Recognition;
    timer?: number;
    lastInput: number;
    speaking: boolean;
    emptyEnds: number;
  }>({ enabled: false, lastInput: 0, speaking: false, emptyEnds: 0 }).current;

  function releaseMic() {
    const recognizer = state.recognizer;
    state.recognizer = undefined;
    if (!recognizer) return;
    recognizer.onstart = recognizer.onend = recognizer.onerror = recognizer.onresult = null;
    recognizer.abort();
  }

  function releaseSession() {
    state.enabled = false;
    window.clearTimeout(state.timer);
    releaseMic();
    if (state.speaking) window.speechSynthesis?.cancel();
    state.speaking = false;
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

  function resume() {
    if (!state.enabled) return;
    setPhase("starting");
    state.timer = window.setTimeout(listen, 350);
  }

  function speak(text: string) {
    if (!state.enabled || state.speaking || !latest.current.read) return false;
    window.clearTimeout(state.timer);
    releaseMic();
    state.speaking = true;
    setPhase("speaking");
    const finish = () => {
      if (!state.enabled || !state.speaking) return;
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
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = true;
    let transcript = "";
    let noSpeech = false;
    recognition.onstart = () => {
      if (state.recognizer === recognition) setPhase("listening");
    };
    recognition.onresult = (event) => {
      if (state.recognizer !== recognition) return;
      const results = Array.from(event.results);
      const heard = results.map((result) => result[0]?.transcript.trim() ?? "").filter(Boolean).join(" ");
      if (heard) setTranscript(heard);
      transcript = results.filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript.trim() ?? "").filter(Boolean).join(" ").trim();
    };
    recognition.onerror = ({ error }) => {
      if (state.recognizer !== recognition) return;
      if (error === "no-speech") {
        noSpeech = true;
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
      if (!transcript) {
        state.emptyEnds += 1;
        if (state.emptyEnds >= 2) fail(noSpeech
          ? "I didn’t hear a request. Check your microphone, then try again."
          : "Speech recognition stopped. Start a new voice session to try again.");
        else resume();
        return;
      }
      state.emptyEnds = 0;
      setPhase("working");
      const session: VoiceSession = {
        reply: (text) => {
          state.lastInput = Date.now();
          speak(text);
        },
        wait: resume,
        stop,
      };
      void latest.current.onCommand(transcript, session).catch(() => {
        if (state.enabled) session.reply("I couldn’t finish that request. Please try again.");
      });
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
  return { active, phase, error, transcript, supported: Boolean(read && recognitionConstructor()), start, stop, speak };
}
