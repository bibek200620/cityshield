import { useEffect, useRef, useState } from "react";
import { api, type CXConversationAction, type CXConversationTurn, type DrivingOption, type PlaceSearchResult } from "../../api/client";
import { isWithinNavigationArea, type useDrivingPlanner } from "../../map/drivingPlanner";
import { distanceSpoken, parseVoiceCommand, readCXWakePhrase, spokenWeather, upcomingDirection, weatherFollowup } from "./cxCommands";
import { type VoiceOutput, type VoiceSession, useCXListening } from "./useCXListening";

const help = "Ask for weather or a forecast in any Indian city, or say navigate to a place. On a route, ask for the next turn or how far is left. Say stop listening to turn off the microphone.";
const CONVERSATION_IDLE_MS = 45_000;

function greetingReply(text: string): string | null {
  const message = text.toLowerCase().replace(/[.!?]+$/, "");
  if (/^(?:hello|hey|hi|good morning|good afternoon|good evening)$/.test(message)) return "Hello. What can I do for you?";
  if (/^(?:how are you|how's it going)$/.test(message)) return "I’m doing well. Ready when you are.";
  if (/^(?:who are you|what's your name|what is your name)$/.test(message)) return "I’m C X, your CityShield companion. I can check weather across India and help you navigate.";
  if (/^(?:thanks|thank you)(?: c[ .-]*x)?$/.test(message)) return "You’re welcome.";
  return null;
}

function placeLabel(place: PlaceSearchResult) {
  return place.name.split(",").slice(0, 3).join(",").slice(0, 125).trim();
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
  onAlertsCommand?: (enabled: boolean) => string,
) {
  const choice = useRef<{ results: PlaceSearchResult[]; expiresAt: number } | null>(null);
  const [awake, setAwake] = useState(false);
  const conversation = useRef<{
    expiresAt: number; timer?: number; weather: boolean; history: CXConversationTurn[];
    weatherLocation?: { lat: number; lng: number };
  }>({
    expiresAt: 0, weather: false, history: [],
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
    conversation.current = { expiresAt: 0, weather: false, history: [] };
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
  }

  async function onCommand(transcript: string, session: VoiceSession) {
    const wakeCommand = readCXWakePhrase(transcript);
    const text = wakeCommand ?? transcript;
    let command = parseVoiceCommand(text);
    if (command.kind === "stop") {
      session.stop();
      return;
    }
    if (wakeCommand === undefined && Date.now() >= conversation.current.expiresAt) {
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
    if (command.kind === "unknown" && conversation.current.weather) command = weatherFollowup(text) ?? command;
    function reply(text: string) {
      keepConversationOpen();
      lastReply.current = text;
      session.reply(text);
    }
    if (choice.current && Date.now() > choice.current.expiresAt) choice.current = null;
    switch (command.kind) {
      case "alerts-on":
        reply(onAlertsCommand?.(true) ?? "Weather alerts are on for this location.");
        return;
      case "alerts-off":
        reply(onAlertsCommand?.(false) ?? "Weather alerts are off.");
        return;
      case "standby":
        resetConversation();
        session.reply("Standing by. Say hello C X when you need me.");
        return;
      case "repeat":
        reply(lastReply.current || help);
        return;
      case "decline":
        choice.current = null;
        reply("Okay. No destination changed.");
        return;
      case "confirm":
      case "choose": {
        const candidates = choice.current?.results;
        if (!candidates) {
          reply("There’s no destination waiting for confirmation. Say navigate to, followed by the place name.");
          return;
        }
        const result = command.kind === "choose" ? candidates[command.index] : candidates.length === 1 ? candidates[0] : undefined;
        if (!result) {
          reply(`Say ${candidates.length === 1 ? "yes" : `an option number from one to ${candidates.length}`}, or say cancel.`);
          return;
        }
        choice.current = null;
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
      case "weather": {
        conversation.current.weather = command.kind === "weather";
        if (command.kind === "destination") choice.current = null;
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
          } else {
            const response = await api.searchPlaces(command.query, controller.signal);
            if (controller.signal.aborted) return;
            const results = response.results.filter((item) => isWithinNavigationArea(item) && item.name.trim()).slice(0, 3);
            if (!results.length) {
              answer = "I couldn’t find that place in India. Try a more specific place name or neighbourhood.";
            } else {
              choice.current = { results, expiresAt: Date.now() + 45_000 };
              answer = results.length === 1 ? `Navigate to ${placeLabel(results[0])}? Say yes or cancel.`
                : `I found ${results.length} places. ${results.map((item, index) => `Option ${index + 1}, ${placeLabel(item)}.`).join(" ")} Say the option number, or cancel.`;
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
          reply("Say yes or an option number to choose a destination, or say cancel.");
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
        let answer = "I couldn’t reach conversation mode just now. You can still ask me for weather or navigation.";
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
              await handleConversationAction(result.action, session, controller.signal);
              return;
            }
          } else if (result.status === "unavailable" && result.reason === "disabled") {
            answer = "I can help with weather and driving. Try asking for tomorrow’s forecast or tell me where you’d like to go.";
          } else if (result.status === "unavailable" && result.reason === "busy") {
            answer = "Conversation mode is busy. Try again in a moment.";
          }
        } catch {
          // Only reply if this conversation is still active.
        } finally {
          window.clearTimeout(timer);
          if (request.current === controller) {
            request.current = null;
            reply(answer);
          }
        }
        return;
      }
    }
  }

  async function handleConversationAction(action: CXConversationAction, session: VoiceSession, signal: AbortSignal) {
    if (action.kind === "eta" || action.kind === "direction") {
      await onCommand(action.kind === "eta" ? "How far is left?" : "What’s the next turn?", session);
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
        conversation.current.weather = true;
        lastReply.current = answer;
        session.reply(answer);
      }
      return;
    }
    if (action.kind !== "route") return;
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
    if (places.some((matches) => matches.length > 1)) {
      const results = places.flat();
      choice.current = { results, expiresAt: Date.now() + 45_000 };
      lastReply.current = `I found a few matching places. ${results.map((place, index) => `Option ${index + 1}, ${placeLabel(place)}.`).join(" ")} Say an option number for the destination, or repeat the route with a more specific starting place.`;
      session.reply(lastReply.current);
      return;
    }
    const destination = places[currentOrigin ? 0 : 1][0];
    if (currentOrigin) {
      lastReply.current = `Starting a route from your current location to ${placeLabel(destination)}.`;
      startingTrip.current = true;
      drive.navigateTo(destination);
    } else {
      lastReply.current = `Finding a route from ${placeLabel(places[0][0])} to ${placeLabel(destination)}.`;
      drive.setPoint("source", { ...places[0][0], name: placeLabel(places[0][0]) });
      drive.setPoint("destination", { ...destination, name: placeLabel(destination) });
      const route = await drive.compare();
      if (!route && !signal.aborted) lastReply.current = "I couldn’t get a route between those places right now.";
    }
    if (!signal.aborted) session.reply(lastReply.current);
  }

  const listener = useCXListening(read, onCommand, stopSession,
    ["locating", "routing", "active", "rerouting"].includes(navigationMode));
  const { phase, speak } = listener;
  const waitingForChoice = Boolean(choice.current && Date.now() <= choice.current.expiresAt);

  useEffect(() => {
    if (phase !== "listening" || waitingForChoice || !startingTrip.current) return;
    if (navigationMode === "error") {
      const text = navigationNotice || "I couldn’t start the route. Check your GPS and try again.";
      if (speak(text)) {
        lastReply.current = text;
        startingTrip.current = false;
      }
    }
    if (navigationMode === "active" && route) {
      const minutes = Math.max(1, Math.round(route.eta_seconds / 60));
      const text = `Navigation started. The route is ${distanceSpoken(route.distance_km * 1000)}, about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
      if (speak(text)) {
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

  return { ...listener, awake, canAnnounce: phase === "listening" && !waitingForChoice };
}
