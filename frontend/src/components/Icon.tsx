import type { ReactNode } from "react";

const paths = {
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6" /></>,
  volume: <><path d="M3 10v4h4l5 4V6l-5 4H3Z" /><path d="M16 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10" /></>,
  mute: <><path d="M3 10v4h4l5 4V6l-5 4H3Z" /><path d="m16 10 5 5m0-5-5 5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  cloud: <path d="M7 19a5 5 0 1 1 .7-9.95 5.65 5.65 0 0 1 10.95 2.45A3.75 3.75 0 1 1 19 19H7Z" />,
  partly: <><path d="M4.5 11a4 4 0 1 1 7.2-3.2M8 2v1m-6 5h1m.5-4.5 1 1M8 19a4 4 0 1 1 .7-7.95 5 5 0 0 1 9.6 1.45h.5a3.25 3.25 0 1 1 0 6.5H8Z" /></>,
  snow: <path d="M12 2v20M3.3 7l17.4 10m0-10L3.3 17M9 4l3 3 3-3m-6 16 3-3 3 3M4 10l4 1-1-4m10 10-1-4 4 1M4 14l4-1-1 4m10-10-1 4 4-1" />,
  moon: <path d="M20.7 15.3A8.8 8.8 0 1 1 8.7 3.2a7.1 7.1 0 0 0 12 12.1Z" />,
  thermometer: <><path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0Zm2-5v8" /><circle cx="12" cy="18" r="1" /></>,
  flood: <><path d="M12 2.8c2 3 4 5.1 4 7.7a4 4 0 0 1-8 0c0-2.6 2-4.7 4-7.7Z" /><path d="M3 17c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1M3 21c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1" /></>,
  heat: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  combined: <><circle cx="9" cy="10" r="5.5" /><circle cx="15" cy="14" r="5.5" /></>,
  route: <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M6 15.5V10a4 4 0 0 1 4-4h5.5M8.5 18H14a4 4 0 0 0 4-4V8.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4m8-4v4M4 10h16m-11 5h1m4 0h1" /></>,
  rain: <><path d="M7 15a4 4 0 1 1 .6-8 5 5 0 0 1 9.4 1.4h.6a3.3 3.3 0 1 1 0 6.6M9 16l-1 3m5-2-1 4m5-5-1 3" /></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12a7 3 0 0 0 14 0V6M5 12a7 3 0 0 0 14 0" /></>,
  location: <><path d="M19 10c0 5-7 11-7 11s-7-6-7-11a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.3" /></>,
  search: <><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15 15 4.2 4.2" /></>,
  chevron: <path d="m10 6 6 6-6 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
  extent: <><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" /><circle cx="12" cy="12" r="2.5" /></>,
  map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export default function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
