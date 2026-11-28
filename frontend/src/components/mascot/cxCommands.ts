import { api, type DrivingOption, type LatLng } from "../../api/client";
import { summarizeHourly } from "../../map/weatherReport";

export type WeatherPeriod = { hours: number; atEnd?: boolean } | { day: "today" | "tomorrow" };
export type VoiceCommand =
  | { kind: "alerts-on" | "alerts-off" }
  | { kind: "weather"; period?: WeatherPeriod; location?: string; rainProbability?: boolean }
  | { kind: "destination"; query: string }
  | { kind: "choose"; index: number }
  | { kind: "confirm" | "decline" | "cancel-route" | "stop" | "standby" | "direction" | "eta" | "repeat" | "help" | "unknown" };

const numbers: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const ordinals: Record<string, number> = { first: 1, second: 2, third: 3 };

function spokenNumber(value: string) {
  const words = value.split(/[ -]+/);
  if (words.length === 1) return numbers[value] ?? (/^\d+$/.test(value) ? Number(value) : NaN);
  const tens = numbers[words[0]];
  const ones = numbers[words[1]];
  return words.length === 2 && tens >= 20 && tens % 10 === 0 && ones >= 1 && ones <= 9
    ? tens + ones : NaN;
}

export function readCXWakePhrase(transcript: string): string | undefined {
  const match = /^(?:(?:hello|hey|hi)[\s,]+c[ .-]*x(?:\s+agent)?|c[ .-]*x\s+agent)\b[\s,.!?:-]*/i.exec(transcript.trim());
  return match ? transcript.trim().slice(match[0].length).trim() : undefined;
}

export function parseVoiceCommand(transcript: string): VoiceCommand {
  const text = transcript.trim().replace(/[’']/g, "'").replace(/[.!?,]+$/, "")
    .replace(/^(?:(?:hey|hi)[ ,]+)?c[ .-]*x\b[ ,:]*/i, "").replace(/^(?:please\s+)/i, "").trim();
  const lower = text.toLowerCase();
  if (/^(?:stop listening|mute microphone|end voice(?: mode| session)?|goodbye)$/.test(lower)) return { kind: "stop" };
  if (/^(?:stand by|standby|go to sleep|that's all|that is all)$/.test(lower)) return { kind: "standby" };
  if (/^(?:stop|cancel|end) (?:the )?(?:route|navigation|directions|trip)$/.test(lower)) return { kind: "cancel-route" };
  if (/^(?:yes(?: please)?|confirm|that's right|correct|go ahead)$/.test(lower)) return { kind: "confirm" };
  if (/^(?:no(?: thanks)?|cancel|never mind|forget it)$/.test(lower)) return { kind: "decline" };
  const option = /^(?:(?:option|number|choose) )?(?:the )?(1|2|3|one|two|three|first|second|third)(?: one)?$/.exec(lower);
  if (option) return { kind: "choose", index: (ordinals[option[1]] ?? spokenNumber(option[1])) - 1 };
  if (/^(?:repeat(?: that)?|say that again)$/.test(lower)) return { kind: "repeat" };
  if (/^(?:help|what can you do|what can i say)$/.test(lower)) return { kind: "help" };
  if (/^(?:(?:turn|switch) )?alerts? (?:on|enable)$/.test(lower)) return { kind: "alerts-on" };
  if (/^(?:(?:turn|switch) )?alerts? (?:off|disable)$/.test(lower)) return { kind: "alerts-off" };
  if (/\b(?:next turn|next step|next direction|which way|where do i turn)\b/.test(lower)) return { kind: "direction" };
  if (/\b(?:eta|e t a|how far|how long (?:until|to get|left|remaining)|time (?:left|remaining)|when (?:will|do) (?:we|i) (?:get there|arrive))\b/.test(lower)) return { kind: "eta" };
  const destination = /^(?:(?:can|could|would) you )?(?:(?:(?:navigate|drive|take me|go|route|(?:get |give me )?directions|show me the way) to)|(?:set (?:my |the )?destination to)|(?:how (?:do|can) i get to)|i(?:'d like| want) to go to)\s+(.+)$/i.exec(text);
  if (destination) {
    const query = destination[1].replace(/\s+please$/i, "").trim();
    return query.length >= 2 && query.length <= 120 ? { kind: "destination", query } : { kind: "unknown" };
  }
  const rainProbability = /^(?:what(?:'s| is)\s+)?(?:the\s+)?(?:chances?|probability)\s+of\s+rain(?: .+)?\??$/i.test(lower);
  const weatherRequest = rainProbability || /^(?:what(?:'s| is)\s+(?:the\s+)?(?:weather|temperature|forecast)(?: .+)?|weather(?: .+)?|forecast(?: .+)?|is it (?:raining|going to rain)(?: .+)?|will it rain(?: .+)?|rain(?: .+))\??$/i.test(lower);
  if (weatherRequest) {
    const inPlace = /\b(?:weather|temperature|forecast|chance of rain|probability of rain)\b.*?\b(?:in|at)\s+(?!(?:the\s+)?next\b)(.+?)(?=\s+(?:for (?:the )?next|next|in (?:the )?next|over (?:the )?next|today|tomorrow|right now|now)\b|$)/i.exec(text);
    const forPlace = /\b(?:weather|temperature|forecast)\s+for\s+(?!(?:the\s+)?next\b)(.+?)(?=\s+(?:for (?:the )?next|next|in (?:the )?next|over (?:the )?next|today|tomorrow|right now|now)\b|$)/i.exec(text);
    const requestedPlace = (inPlace?.[1] ?? forPlace?.[1])?.trim();
    const location = requestedPlace && !/^(?:(?:the )?next|today|tomorrow|right now|now)\b/i.test(requestedPlace)
      && !/^[a-z\d-]+(?: [a-z\d-]+)?\s+(?:hours?|hrs?|days?)[?.!]*$/i.test(requestedPlace)
      ? requestedPlace : undefined;
    const weatherCommand = (period?: WeatherPeriod, asksRainProbability = false): VoiceCommand => ({
      kind: "weather", ...(period ? { period } : {}), ...(location ? { location } : {}),
      ...(asksRainProbability ? { rainProbability: true } : {}),
    });
    if (rainProbability) return weatherCommand({ day: /\btomorrow\b/i.test(lower) ? "tomorrow" : "today" }, true);
    const duration = /\b(next|for(?: the next)?|in)\s+([a-z\d-]+(?: [a-z\d-]+)?)\s+(hours?|hrs?|days?)\b/.exec(lower);
    if (duration) {
      return weatherCommand({
        hours: spokenNumber(duration[2]) * (duration[3].startsWith("day") ? 24 : 1),
        atEnd: duration[1] === "in",
      });
    }
    if (/\b(?:next|in an) hour\b/.test(lower)) return weatherCommand({ hours: 1 });
    if (/\btomorrow\b/.test(lower)) return weatherCommand({ day: "tomorrow" });
    if (/\btoday\b/.test(lower) && !/\b(?:now|current)\b/.test(lower)) return weatherCommand({ day: "today" });
    if (/\b(?:next|hours?|days?|week|minutes?|weekend|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)) {
      return weatherCommand({ hours: NaN });
    }
    const forecast = /\bforecast\b/.test(lower) && !/\b(?:now|current)\b/.test(lower);
    return weatherCommand(forecast ? { hours: 3 } : undefined);
  }
  return { kind: "unknown" };
}

export function weatherFollowup(text: string): VoiceCommand | null {
  const period = text.trim().replace(/[?.!]+$/, "").replace(/^(?:and|what about|how about)\s+/i, "");
  if (!/^(?:tomorrow|today|(?:(?:for|in|next|the next)\s+).+\b(?:hours?|hrs?|days?))$/i.test(period)) {
    return null;
  }
  return parseVoiceCommand(`weather ${period}`);
}

const conditions = [
  { codes: [0], label: "clear skies" },
  { codes: [1, 2], label: "some cloud cover" },
  { codes: [3], label: "overcast skies" },
  { codes: [45, 48], label: "fog" },
  { codes: [51, 53, 55, 56, 57], label: "drizzle" },
  { codes: [61, 63, 65, 66, 67, 80, 81, 82], label: "rain" },
  { codes: [95, 96, 97, 99], label: "thunderstorms" },
];
const localDay = (timeMs: number) => Math.floor((timeMs + 19_800_000) / 86_400_000);
const localTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "numeric", hour12: true });

export async function spokenWeather(period: WeatherPeriod | undefined, signal: AbortSignal, location?: LatLng, rainProbability = false) {
  if (!period) {
    const result = await api.getWeatherNowcast(signal, location);
    if (result.status !== "ready") return "The current weather estimate is unavailable. Try again in a moment.";
    const condition = conditions.find(({ codes }) => codes.includes(result.weather_code ?? -1))?.label;
    return `Right now, about ${Math.round(result.air_temperature_c)} degrees Celsius`
      + ` and it feels like ${Math.round(result.feels_like_c)}${condition ? `, with ${condition}` : ""}.`;
  }
  if ("hours" in period && (!Number.isInteger(period.hours) || period.hours < 1 || period.hours > 48)) {
    return "I can forecast up to 48 hours. Try asking for the next six hours, or for tomorrow.";
  }
  const result = "hours" in period && period.hours <= 3
    ? await api.getWeatherNowcast(signal, location) : await api.getWeatherReport(signal, location);
  if (result.status !== "ready") return "The forecast is unavailable. Try again in a moment.";
  const label = "hours" in period
    ? `for the next ${period.hours === 1 ? "hour" : `${period.hours} hours`}`
    : period.day === "today" ? "for the rest of today" : "for tomorrow";
  const slots = "hours" in period ? result.hourly_forecast.slice(0, period.hours)
    : result.hourly_forecast.filter((slot) => localDay(Date.parse(slot.valid_at) - 1) === localDay(Date.now()) + (period.day === "tomorrow" ? 1 : 0));
  if (!slots.length || ("hours" in period && slots.length < period.hours)) return "I don't have enough forecast data for that time.";
  if ("hours" in period && period.atEnd) {
    const slot = slots[slots.length - 1];
    return `Around ${localTime.format(new Date(slot.valid_at))}, expect about ${Math.round(slot.air_temperature_c)} degrees Celsius`
      + (slot.precipitation_mm > 0 ? ` and about ${slot.precipitation_mm} millimetres of rain in the preceding hour.` : " with no rain forecast in the preceding hour.");
  }
  const summary = summarizeHourly(slots);
  const min = Math.round(summary.low);
  const max = Math.round(summary.high);
  const temperature = min === max ? `around ${min}` : `between ${min} and ${max}`;
  const rain = summary.firstWet
    ? ` About ${Number(summary.rain.toFixed(1))} millimetres of rain are forecast, with the first rainy hour ending at ${localTime.format(new Date(summary.firstWet.valid_at))}.`
    : " No rain is forecast for that period.";
  const probabilityNote = rainProbability ? " A rain-probability percentage is not available for this forecast." : "";
  return `For this location ${label}, expect temperatures ${temperature} degrees Celsius.${rain}${probabilityNote}`;
}

export function upcomingDirection(route: DrivingOption, distances: number[], progress: number) {
  for (const step of route.guidance ?? []) {
    const distance = distances[step.point_index] - progress;
    if (Number.isFinite(distance) && distance > 0 && step.instruction?.trim()) return { step, distance };
  }
  return null;
}

export function distanceSpoken(metres: number) {
  return metres < 1000 ? `${Math.max(10, Math.round(metres / 10) * 10)} metres`
    : `${Number((metres / 1000).toFixed(1))} kilometres`;
}
