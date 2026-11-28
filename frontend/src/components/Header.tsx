import React, { useState, useEffect } from "react";

export default function Header() {
  const [timeString, setTimeString] = useState("Thu, 18 Sep 2026 04:32 PM");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      // Format as "Thu, 18 Sep 2026 04:32 PM"
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const day = days[now.getDay()];
      const date = now.getDate();
      const month = months[now.getMonth()];
      const year = now.getFullYear();
      let hours = now.getHours();
      const minutes = now.getMinutes().toString().padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12 || 12;
      const formattedHours = hours.toString().padStart(2, "0");
      setTimeString(`${day}, ${date} ${month} ${year} ${formattedHours}:${minutes} ${ampm}`);
    };
    updateTime();
    const interval = setInterval(updateTime, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="bg-[#071326]/95 backdrop-blur-md text-white px-5 py-2.5 border-b border-[#132d4b] flex items-center justify-between flex-wrap gap-3 z-30 shadow-lg select-none">
      {/* Left: Brand & Title */}
      <div className="flex items-center gap-6">
        {/* Brand logo & tagline */}
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center">
            {/* Cyan glowing cloud icon */}
            <svg
              className="w-9 h-9 text-[#00E5FF] drop-shadow-[0_0_10px_rgba(0,229,255,0.7)]"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
            </svg>
          </div>
          <div>
            <div className="text-lg font-black tracking-wider text-white flex items-center gap-1.5 leading-tight">
              <span className="bg-gradient-to-r from-white via-[#E0F7FA] to-[#00E5FF] bg-clip-text text-transparent drop-shadow-sm font-extrabold tracking-widest">
                CITYSHIELD
              </span>
            </div>
            <div className="text-[10.5px] text-[#00E5FF] font-medium tracking-wide">
              Research prototype · Bellandur
            </div>
          </div>
        </div>

        {/* Separator */}
        <div className="hidden lg:block h-8 w-[1px] bg-slate-700/60" />

        {/* System Subtitle */}
        <div className="hidden md:block">
          <h1 className="text-[14.5px] font-bold text-slate-100 tracking-tight leading-snug">
            Bengaluru Flood & Heatwave Intelligence
          </h1>
          <p className="text-[11.5px] text-slate-400 font-normal">
            Local flood and heat research layers.
          </p>
        </div>
      </div>

      {/* Right: Controls, Status & SIH Badge */}
      <div className="flex items-center gap-3.5 flex-wrap">
        {/* Ward / Location selector */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0d223a] border border-[#1b3e64] text-xs font-medium text-slate-200 hover:border-[#00E5FF]/40 cursor-pointer transition-colors shadow-inner">
          <span className="text-[#00E5FF] text-sm">📍</span>
          <span>Local research layers</span>
        </div>

        {/* Local clock; this is not a data timestamp. */}
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0d223a]/80 border border-[#183554] text-xs text-slate-300 font-mono">
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span>Local time · {timeString}</span>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0d223a] border border-[#1b3e64] text-xs text-slate-200">
          <span className="font-semibold text-white">Research only</span>
          <span className="text-slate-500">|</span>
          <span className="text-[11px] text-slate-300">Not an official warning service</span>
        </div>

        {/* Theme Icon Pill */}
        <div className="flex items-center gap-1 p-1 rounded-full bg-[#0d223a] border border-[#1b3e64]">
          <div className="w-6 h-6 rounded-full bg-[#00e5ff]/20 text-[#00E5FF] flex items-center justify-center text-xs">
            🌙
          </div>
        </div>

      </div>
    </header>
  );
}
