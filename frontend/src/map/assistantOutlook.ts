import { useEffect, useState } from "react";
import { api, type AssistantOutlook } from "../api/client";

export const assistantRefreshMs = 5 * 60_000;

export function useAssistantOutlook() {
  const [outlook, setOutlook] = useState<AssistantOutlook | null>(null);
  useEffect(() => {
    let request: AbortController | undefined;
    function refresh() {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      void api.getAssistantOutlook(controller.signal).then((value) => {
        if (!controller.signal.aborted) setOutlook(value);
      }).catch(() => {
        if (!controller.signal.aborted) setOutlook({ status: "unavailable" });
      });
    }
    refresh();
    const timer = window.setInterval(refresh, assistantRefreshMs);
    return () => {
      window.clearInterval(timer);
      request?.abort();
    };
  }, []);
  return outlook;
}
