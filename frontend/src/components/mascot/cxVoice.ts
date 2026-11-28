import { useCallback, useEffect, useState } from "react";

function voiceRank(voice: SpeechSynthesisVoice) {
  const quality = /premium|enhanced|natural|neural|studio/i.test(`${voice.name} ${voice.voiceURI}`) ? 10 : 0;
  const conversational = /^(Tara|Samantha|Serena)\b/i.test(voice.name) ? 3 : 0;
  return quality + conversational + (/^en[-_]IN$/i.test(voice.lang) ? 2 : 0) + (voice.default ? 1 : 0);
}

export function useCXVoice() {
  const speech = typeof SpeechSynthesisUtterance === "undefined" ? undefined : window.speechSynthesis;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceId, setVoiceId] = useState("");

  useEffect(() => {
    if (!speech) return;
    const refresh = () => setVoices(speech.getVoices().filter((voice) => voice.localService && /^en(?:$|[-_])/i.test(voice.lang))
      .sort((a, b) => voiceRank(b) - voiceRank(a)));
    refresh();
    speech.addEventListener?.("voiceschanged", refresh);
    return () => speech.removeEventListener?.("voiceschanged", refresh);
  }, [speech]);

  const voice = voices.find((option) => option.voiceURI === voiceId) ?? voices[0];
  const say = useCallback((text: string, done?: () => void) => {
    if (!speech) return;
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.pitch = 1;
    utterance.rate = .97;
    utterance.onend = utterance.onerror = () => done?.();
    speech.cancel();
    speech.speak(utterance);
  }, [speech, voice]);

  return { read: speech ? say : undefined, voices, voiceId, setVoiceId };
}
