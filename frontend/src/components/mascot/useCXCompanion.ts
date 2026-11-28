import { useEffect, useRef, useState } from "react";
import { api, type CXConversationAction, type CXConversationTurn, type DrivingOption, type PlaceSearchResult } from "../../api/client";
import { isWithinNavigationArea, type useDrivingPlanner } from "../../map/drivingPlanner";
import { loadIndiaCities } from "../../map/indiaCities";
import { cxLayerLabel, cxMapFollowup, distanceSpoken, parseVoiceCommand, readCXWakePhrase, selectCXTranscript, spokenWeather, upcomingDirection, weatherFollowup, type CXSiteAction } from "./cxCommands";
import { type VoiceOutput, type VoiceSession, useCXListening } from "./useCXListening";

const help = "Try asking me to center the map on Lalbagh, show the road flood risk layer, or run a moderate storm simulation. You can also ask for weather or directions.";
const CONVERSATION_IDLE_MS = 45_000;

function greetingReply(text: string): string | null {
  const message = text.toLowerCase().replace(/[.!?]+$/, "");
  if (/^(?:hello|hey|hi|good morning|good afternoon|good evening)$/.test(message)) return "Hello. What can I do for you?";
  if (/^(?:how are you|how's it going)$/.test(message)) return "I’m doing well. Ready when you are.";
  if (/^(?:who are you|what's your name|what is your name)$/.test(message)) return "I’m C X, your CityShield companion. I can check weather across India and help you navigate.";
  if (/^(?:what(?: is|'s) cityshield|how does cityshield work|what can (?:i do with|cityshield do))$/.test(message)) {
    return "CityShield shows India-wide weather and routes, with flood and rainfall simulation tools for Bengaluru. I can move the map, change layers, run a rainfall scenario, or help you check a route.";
  }
  if (/^(?:thanks|thank you)(?: c[ .-]*x)?$/.test(message)) return "You’re welcome.";
  return null;
}

function placeLabel(place: PlaceSearchResult) {
  return place.name.split(",").slice(0, 3).join(",").slice(0, 125).trim();
}

function placeWords(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isCurrentLocation(value: string | undefined) {
  return Boolean(value && /\b(?:my current (?:place|location|position)|current location|where i am|where i’m at|here)\b/i.test(value));
}

export function useCXCompanion(
  drive: ReturnType<typeof useDrivingPlanner>,
  route: DrivingOption | undefined,
  distances: number[],
  read: VoiceOutput | undefined,
  selectedWeatherLocation: { lat: number; lng: number },
  selectedPlaceName: string,
  language: string,
  onSiteCommand: (command: CXSiteAction) => string | Promise<string>,
  onAlertsCommand?: (enabled: boolean) => string,
) {
  const choice = useRef<{ results: PlaceSearchResult[]; expiresAt: number; purpose: "navigate" | "map"; origin?: PlaceSearchResult } | null>(null);
  const [awake, setAwake] = useState(false);
  const [response, setResponse] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const typedTurn = useRef(0);
  const inputMode = useRef<"voice" | "text">("voice");
  const conversation = useRef<{
    expiresAt: number; timer?: number; topic?: "weather" | "map"; history: CXConversationTurn[];
    weatherLocation?: { lat: number; lng: number };
  }>({
    expiresAt: 0, history: [],
  });
  const request = useRef<AbortController | null>(null);
  const lastReply = useRef("");
  const startingTrip = useRef(false);
  const announced = useRef<{ route: DrivingOption; points: Set<number> } | null>(null);
  const { navigationMode, routeMatch, navigationLocation, navigationNotice, offRoute } = drive;
  const weatherLocation = navigationLocation ?? drive.points.destination ?? drive.points.source ?? selectedWeatherLocation;
  const tracking = navigationMode === "active" && route && routeMatch && navigationLocation && !offRoute &&
    navigationLocation.accuracy_m <= 65 &&
    routeMatch.distance_from_route_m <= Math.max(30, navigationLocation.accuracy_m) &&
    Date.now() - navigationLocation.timestamp <= 15_000;

  function resetConversation() {
    request.current?.abort();
    request.current = null;
    window.clearTimeout(conversation.current.timer);
    conversation.current = { expiresAt: 0, history: [] };
    choice.current = null;
    lastReply.current = "";
    setAwake(false);
  }

  function keepConversationOpen() {
    window.clearTimeout(conversation.current.timer);
    conversation.current.expiresAt = Date.now() + CONVERSATION_IDLE_MS;
    conversation.current.timer = window.setTimeout(resetConversation, CONVERSATION_IDLE_MS);
    setAwake(true);
  }

  function stopSession() {
    resetConversation();
    startingTrip.current = false;
    announced.current = null;
    typedTurn.current += 1;
    setTextBusy(false);
  }

  function interruptTurn() {
    typedTurn.current += 1;
    request.current?.abort();
    request.current = null;
    keepConversationOpen();
    setResponse("Go ahead with your follow-up.");
  }

  async function onCommand(transcript: string, session: VoiceSession, mode: "voice" | "text" = "voice") {
    const turn = typedTurn.current;
    inputMode.current = mode;
    const wakeCommand = readCXWakePhrase(transcript);
    const text = wakeCommand ?? transcript;
    let command = parseVoiceCommand(text);
    if (command.kind === "stop") {
      session.stop();
      return;
    }
    if (mode === "voice" && wakeCommand === undefined && Date.now() >= conversation.current.expiresAt) {
      session.wait();
      return;
    }
    keepConversationOpen();
    if (wakeCommand === "") {
      const hello = "I’m here. What can I do for you?";
      lastReply.current = hello;
      session.reply(hello);
      return;
    }
    if (choice.current && Date.now() > choice.current.expiresAt) choice.current = null;
    if (command.kind === "unknown" && choice.current && /[\p{L}\p{N}]/u.test(text)) {
      const query = placeWords(text);
      if (choice.current.results.some((place) => ` ${placeWords(place.name)} `.includes(` ${query} `))) {
        command = { kind: "choose-place", query };
      }
    }
    if (command.kind === "unknown") {
      if (conversation.current.topic === "weather") command = weatherFollowup(text) ?? command;
      if (conversation.current.topic === "map") command = cxMapFollowup(text) ?? command;
    }
    function reply(text: string) {
      if (typedTurn.current !== turn) return;
      keepConversationOpen();
      lastReply.current = text;
      session.reply(text);
    }
    switch (command.kind) {
      case "workspace":
      case "layer":
      case "pan":
      case "zoom":
      case "reset-map":
      case "flood-demo":
      case "simulation":
      case "simulation-help":
      case "stop-simulation":
        choice.current = null;
        conversation.current.topic = undefined;
        reply(await onSiteCommand(command));
        return;
      case "alerts-on":
        reply(onAlertsCommand?.(true) ?? "Weather alerts are on for this location.");
        return;
      case "alerts-off":
        reply(onAlertsCommand?.(false) ?? "Weather alerts are off.");
        return;
      case "standby":
        resetConversation();
        session.reply(mode === "voice" ? "Standing by. Say hello C X when you need me." : "Standing by. Type your next request when ready.");
        return;
      case "repeat":
        reply(lastReply.current || help);
        return;
      case "decline":
        choice.current = null;
        reply("Okay. I cancelled that request.");
        return;
      case "confirm":
      case "choose":
      case "choose-place": {
        const pending = choice.current;
        if (!pending) {
          reply("There’s no place waiting for confirmation. Try asking me to find a place or navigate to it.");
          return;
        }
        const candidates = pending.results;
        const named = command.kind === "choose-place" ? placeWords(command.query) : "";
        const matches = named ? candidates.filter((place) => ` ${placeWords(place.name)} `.includes(` ${named} `)) : [];
        const result = command.kind === "choose" ? candidates[command.index]
          : command.kind === "choose-place" ? (matches.length === 1 ? matches[0] : undefined)
            : candidates.length === 1 ? candidates[0] : undefined;
        if (!result) {
          reply(`Say ${candidates.length === 1 ? "yes" : `an option number from one to ${candidates.length}`}, or say cancel.`);
          return;
        }
        choice.current = null;
        if (pending.purpose === "map") {
          reply(await onSiteCommand({ kind: "select-place", place: result }));
          return;
        }
        if (pending.origin) {
          reply(await compareNamedRoute(pending.origin, result));
          return;
        }
        startingTrip.current = true;
        drive.navigateTo(result);
        reply(`Getting your GPS location for the route to ${placeLabel(result)}.`);
        return;
      }
      case "cancel-route":
        choice.current = null;
        startingTrip.current = false;
        drive.stopNavigation();
        reply("Navigation stopped.");
        return;
      case "direction":
      case "eta": {
        if (!tracking || !route || !routeMatch) {
          reply("I need an active route and a reliable GPS position near it to give directions.");
          return;
        }
        if (command.kind === "eta") {
          const minutes = Math.max(1, Math.round(route.eta_seconds * (1 - routeMatch.progress) / 60));
          reply(`About ${distanceSpoken(routeMatch.remaining_m)} left. Estimated time remaining, about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
          return;
        }
        const turn = upcomingDirection(route, distances, routeMatch.progress_m);
        reply(turn ? turn.distance <= Math.max(25, navigationLocation?.accuracy_m ?? 0)
          ? "The next mapped turn is very close. Follow the road signs and the route on the map."
          : `In about ${distanceSpoken(turn.distance)}. ${turn.step.instruction}`
          : "I don’t have another turn instruction from the routing provider. Your route is on the map.");
        return;
      }
      case "destination":
      case "show-place":
      case "weather": {
        conversation.current.topic = command.kind === "weather" ? "weather" : command.kind === "show-place" ? "map" : undefined;
        if (command.kind !== "weather") choice.current = null;
        const controller = new AbortController();
        request.current = controller;
        const timer = window.setTimeout(() => controller.abort(), 18_000);
        let answer = command.kind === "weather"
          ? "The weather forecast is unavailable right now. Try again in a moment."
          : "Place search is unavailable right now. Try again in a moment.";
        try {
          if (command.kind === "weather") {
            let target = conversation.current.weatherLocation ?? weatherLocation;
            let locationName: string | null = null;
            if (command.location) {
              const response = await api.searchPlaces(command.location, controller.signal);
              if (controller.signal.aborted) return;
              const match = response.results.find((item) => isWithinNavigationArea(item) && item.name.trim());
              if (match) {
                target = { lat: match.lat, lng: match.lng };
                locationName = placeLabel(match);
                conversation.current.weatherLocation = target;
              } else {
                answer = `I couldn’t find ${command.location} in India. Try a nearby city or district.`;
              }
            }
            if (!command.location || locationName) {
              answer = await spokenWeather(command.period, controller.signal, target, command.rainProbability);
              if (locationName) answer = `For ${locationName}, ${answer}`;
              conversation.current.weatherLocation = target;
            }
          } else if (command.kind === "show-place") {
            const alternatives = session.alternatives?.flatMap((transcript) => {
              const candidate = parseVoiceCommand(readCXWakePhrase(transcript) ?? transcript);
              return candidate.kind === "show-place" ? [candidate.query] : [];
            });
            answer = await showMapPlace(command.query, controller.signal, alternatives);
          } else {
            const response = await api.searchPlaces(command.query, controller.signal);
            if (controller.signal.aborted) return;
            const results = response.results.filter((item) => isWithinNavigationArea(item) && item.name.trim()).slice(0, 3);
            if (!results.length) {
              answer = "I couldn’t find that place in India. Try a more specific place name or neighbourhood.";
            } else {
              choice.current = { results, expiresAt: Date.now() + 45_000, purpose: "navigate" };
              answer = results.length === 1 ? `Navigate to ${placeLabel(results[0])}? Say yes or cancel.`
                : `I found ${results.length} places. ${results.map((item, index) => `Option ${index + 1}, ${placeLabel(item)}.`).join(" ")} Reply with the option number, or cancel.`;
            }
          }
        } catch {
          // Give a spoken recovery prompt if the session still owns this request.
        } finally {
          window.clearTimeout(timer);
          if (request.current === controller) {
            request.current = null;
            reply(answer);
          }
        }
        return;
      }
      case "help":
        reply(help);
        return;
      case "unknown": {
        if (choice.current) {
          reply("Reply with the place name, its option number, or say cancel. Say yes if there’s one option.");
          return;
        }
        const greeting = greetingReply(text);
        if (greeting) {
          reply(greeting);
          return;
        }
        if (text.length > 500) {
          reply("Could you ask that in a shorter sentence?");
          return;
        }
        const controller = new AbortController();
        request.current = controller;
        const timer = window.setTimeout(() => controller.abort(), 14_000);
        let answer = "I couldn’t reach conversation mode just now. Try asking me to center the map on a place, show a layer, or check the weather.";
        let handledAction = false;
        try {
          const result = await api.askCX(text, conversation.current.history, controller.signal);
          if (controller.signal.aborted) return;
          if (result.status === "ready" && typeof result.reply === "string" && result.reply.trim() && result.reply.length <= 500) {
            answer = result.reply;
            const turns: CXConversationTurn[] = [
              ...conversation.current.history, { role: "user", text }, { role: "assistant", text: answer },
            ];
            conversation.current.history = turns.slice(-4);
            if (result.action) {
              answer = "I couldn’t finish that action. Try again in a moment.";
              await handleConversationAction(result.action, { ...session, reply: (message) => {
                if (controller.signal.aborted || request.current !== controller) return;
                handledAction = true;
                turns[turns.length - 1] = { role: "assistant", text: message.slice(0, 500) };
                conversation.current.history = turns.slice(-4);
                reply(message);
              } }, controller.signal, mode);
              return;
            }
          } else if (result.status === "unavailable" && result.reason === "disabled") {
            answer = help;
          } else if (result.status === "unavailable" && result.reason === "busy") {
            answer = "Conversation mode is busy. Try again in a moment.";
          }
        } catch {
          // Only reply if this conversation is still active.
        } finally {
          window.clearTimeout(timer);
          if (request.current === controller) {
            request.current = null;
            if (!handledAction) reply(answer);
          }
        }
        return;
      }
    }
  }

  async function showMapPlace(query: string, signal: AbortSignal, alternatives: string[] = []) {
    async function search(candidate: string) {
      const query = candidate.replace(/\s+in\s+/i, ", ");
      let results: PlaceSearchResult[];
      try {
        results = (await api.searchPlaces(query, signal)).results;
      } catch (error) {
        signal.throwIfAborted();
        const [name, state] = query.split(",").map(placeWords);
        const { places } = await loadIndiaCities(signal);
        const cities = places.filter((city) => placeWords(city.name) === name &&
          (!state || state === "india" || placeWords(city.state) === state));
        if (!cities.length) throw error;
        results = cities.map((city) => ({ ...city, name: `${city.name}, ${city.state}`, category: "city" }));
      }
      const matches: PlaceSearchResult[] = [];
      for (const place of results) {
        if (!isWithinNavigationArea(place) || !place.name.trim()) continue;
        const duplicate = matches.some((match) => {
          const separation = Math.hypot(match.lat - place.lat, match.lng - place.lng);
          return (separation < 0.008 && placeWords(match.name) === placeWords(place.name)) ||
            (separation < 0.001 && placeWords(match.name.split(",")[0]) === placeWords(place.name.split(",")[0]));
        });
        if (!duplicate) matches.push(place);
        if (matches.length === 3) break;
      }
      return matches;
    }
    let results = await search(query);
    let usedAlternative = false;
    const alternativesByName = new Map(alternatives.map((candidate) => [placeWords(candidate), candidate]));
    alternativesByName.delete(placeWords(query));
    for (const candidate of [...alternativesByName.values()].slice(0, 2)) {
      if (results.length || signal.aborted) break;
      results = await search(candidate);
      usedAlternative = results.length > 0;
    }
    signal.throwIfAborted();
    if (!results.length) return `I couldn’t find ${query} in India. Try including the city or a nearby landmark.`;
    if (results.length === 1 && !usedAlternative) return onSiteCommand({ kind: "select-place", place: results[0] });
    choice.current = { results, expiresAt: Date.now() + 45_000, purpose: "map" };
    if (results.length === 1) return `Did you mean ${placeLabel(results[0])}? Reply yes or cancel.`;
    const options = results.map((place, index) => `Option ${index + 1}, ${placeLabel(place)}.`).join(" ");
    return `I found several places. ${options} Choose an option, say which city it’s in, or say cancel.`;
  }

  async function compareNamedRoute(origin: PlaceSearchResult, destination: PlaceSearchResult) {
    drive.setPoint("source", { ...origin, name: placeLabel(origin) });
    drive.setPoint("destination", { ...destination, name: placeLabel(destination) });
    const result = await drive.compare();
    if (!result) return "I couldn’t get a route between those places right now.";
    const route = result.routes[0];
    return `Route ready from ${placeLabel(origin)} to ${placeLabel(destination)}.${route
      ? ` About ${Math.max(1, Math.round(route.eta_seconds / 60))} minutes. Open Routes to see the options.` : ""}`;
  }

  async function handleConversationAction(action: CXConversationAction, session: VoiceSession, signal: AbortSignal, mode: "voice" | "text") {
    if (action.kind === "eta" || action.kind === "direction") {
      await onCommand(action.kind === "eta" ? "How far is left?" : "What’s the next turn?", session, mode);
      return;
    }
    switch (action.kind) {
      case "show-place":
        conversation.current.topic = "map";
        session.reply(await showMapPlace(action.query, signal));
        return;
      case "layer":
      case "workspace":
      case "pan":
      case "zoom":
      case "reset-map":
      case "simulation":
      case "stop-simulation":
      case "flood-demo":
        conversation.current.topic = undefined;
        session.reply(await onSiteCommand(action.kind === "layer" ? { ...action, label: cxLayerLabel(action.layer) } : action));
        return;
    }
    if (action.kind === "weather") {
      const period = action.day ? { day: action.day } as const
        : action.hours ? { hours: action.hours, atEnd: action.at_end } as const : undefined;
      const answer = await spokenWeather(
        period ?? (action.focus === "rain_probability" ? { day: "today" } : undefined),
        signal,
        conversation.current.weatherLocation ?? weatherLocation,
        action.focus === "rain_probability",
      );
      if (!signal.aborted) {
        conversation.current.topic = "weather";
        lastReply.current = answer;
        session.reply(answer);
      }
      return;
    }
    if (action.kind !== "route") return;
    conversation.current.topic = undefined;
    if (!action.destination) {
      lastReply.current = "Where would you like to go?";
      session.reply(lastReply.current);
      return;
    }
    const currentOrigin = !action.source || isCurrentLocation(action.source);
    const endpoints = currentOrigin ? [action.destination] : [action.source, action.destination];
    const places: PlaceSearchResult[][] = [];
    for (const endpoint of endpoints) {
      if (!endpoint) return;
      const result = await api.searchPlaces(endpoint, signal);
      places.push(result.results.filter((item) => isWithinNavigationArea(item) && item.name.trim()).slice(0, 3));
    }
    if (signal.aborted) return;
    if (places.some((matches) => matches.length === 0)) {
      lastReply.current = "I couldn’t find one of those places in India. Try a nearby landmark or a more specific city name.";
      session.reply(lastReply.current);
      return;
    }
    if (!currentOrigin && places[0].length > 1) {
      lastReply.current = "I found several matches for the starting place. Repeat the route with a more specific origin, such as the city or neighbourhood.";
      session.reply(lastReply.current);
      return;
    }
    const destinations = places[currentOrigin ? 0 : 1];
    if (destinations.length > 1) {
      choice.current = { results: destinations, expiresAt: Date.now() + 45_000, purpose: "navigate", origin: currentOrigin ? undefined : places[0][0] };
      lastReply.current = `I found several destinations. ${destinations.map((place, index) => `Option ${index + 1}, ${placeLabel(place)}.`).join(" ")} Reply with the option number, or cancel.`;
      session.reply(lastReply.current);
      return;
    }
    const destination = destinations[0];
    if (currentOrigin) {
      if (!action.source) {
        choice.current = { results: [destination], expiresAt: Date.now() + 45_000, purpose: "navigate" };
        lastReply.current = `Navigate to ${placeLabel(destination)}? Reply yes or cancel.`;
        session.reply(lastReply.current);
        return;
      }
      lastReply.current = `Starting a route from your current location to ${placeLabel(destination)}.`;
      startingTrip.current = true;
      drive.navigateTo(destination);
    } else {
      const answer = await compareNamedRoute(places[0][0], destination);
      if (!signal.aborted) lastReply.current = answer;
    }
    if (!signal.aborted) session.reply(lastReply.current);
  }

  const listener = useCXListening(read, (text, session) => {
    const turn = typedTurn.current;
    return onCommand(text, {
      ...session,
      reply: (message) => {
        if (typedTurn.current === turn) setResponse(message);
        session.reply(message);
      },
    });
  }, stopSession, interruptTurn, ["locating", "routing", "active", "rerouting"].includes(navigationMode),
  language, (candidates) => selectCXTranscript(candidates, Date.now() < conversation.current.expiresAt),
  [selectedPlaceName, ...(choice.current?.results.map((place) => place.name) ?? [])]
    .map((name) => name.split(",")[0].trim()).filter(Boolean));
  const { phase, speak } = listener;
  const waitingForChoice = Boolean(choice.current && Date.now() <= choice.current.expiresAt);

  async function submitText(value: string) {
    const text = value.trim();
    if (!text || listener.active || textBusy) return;
    const turn = ++typedTurn.current;
    setTextBusy(true);
    try {
      await onCommand(text, {
        reply: (message) => { if (typedTurn.current === turn) setResponse(message); },
        wait: () => {},
        stop: () => { stopSession(); setResponse("The assistant session ended."); },
      }, "text");
    } catch {
      if (typedTurn.current === turn) setResponse("I couldn’t finish that request. Please try again.");
    } finally {
      if (typedTurn.current === turn) setTextBusy(false);
    }
  }

  useEffect(() => {
    const typed = inputMode.current === "text" && (phase === "off" || phase === "error");
    if ((!typed && phase !== "listening") || waitingForChoice || !startingTrip.current) return;
    if (navigationMode === "error") {
      const text = navigationNotice || "I couldn’t start the route. Check your GPS and try again.";
      if (typed || speak(text)) {
        setResponse(text);
        lastReply.current = text;
        startingTrip.current = false;
      }
    }
    if (navigationMode === "active" && route) {
      const minutes = Math.max(1, Math.round(route.eta_seconds / 60));
      const text = `Navigation started. The route is ${distanceSpoken(route.distance_km * 1000)}, about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
      if (typed || speak(text)) {
        setResponse(text);
        lastReply.current = text;
        startingTrip.current = false;
      }
    }
  }, [phase, navigationMode, navigationNotice, route, speak, waitingForChoice]);

  useEffect(() => {
    if (phase !== "listening" || waitingForChoice || startingTrip.current || !tracking || !route || !routeMatch || !navigationLocation) return;
    const turn = upcomingDirection(route, distances, routeMatch.progress_m);
    const lookAhead = Math.min(300, Math.max(65, (navigationLocation.speed_mps ?? 0) * 10));
    if (!turn || turn.distance > lookAhead || turn.distance <= Math.max(25, navigationLocation.accuracy_m)) return;
    if (announced.current?.route !== route) announced.current = { route, points: new Set() };
    if (announced.current.points.has(turn.step.point_index)) return;
    const text = `In about ${distanceSpoken(turn.distance)}. ${turn.step.instruction}`;
    if (speak(text)) {
      announced.current.points.add(turn.step.point_index);
      lastReply.current = text;
    }
  }, [distances, phase, navigationLocation, route, routeMatch, speak, tracking, waitingForChoice]);

  const placeOptions = waitingForChoice ? choice.current?.results.map(placeLabel) ?? [] : [];
  function respondToPlace(index?: number) {
    const command = index === undefined ? "Cancel" : `Option ${index + 1}`;
    if (listener.active) listener.execute(command, false);
    else void submitText(command);
  }

  return { ...listener, awake, response, textBusy, submitText, placeOptions, respondToPlace,
    canAnnounce: phase === "listening" && !waitingForChoice };
}
