/**
 * BookNexa Widget Render Endpoint
 * Serves widget HTML at /widget/render
 * Query params: ?agentId=X&theme=sage&widget=concierge&agent=sophia
 */
import { Request, Response } from "express";

// ElevenLabs Agent IDs (REAL production agents from settings page)
const ELEVENLABS_AGENTS: Record<string, string> = {
  sophia: 'agent_2101k847qgn3ehss6c9gkg4cpj5t',
  amelia: 'agent_8301kg0zx5gaegdt87vgzmh6mx11',
  kai: 'agent_0101kg0ze2c5f7v8xwgwxe83pjwj'
};

// Agent greetings
const AGENT_GREETINGS: Record<string, string> = {
  sophia: "Hi there!! I'm Sophia — your AI Spa and Aesthetics Coordinator with BookNexa AI. It's so nice to meet you! I can help schedule consultations, answer questions about our treatments, or connect you with a licensed specialist. Would you like to book an appointment or learn more about our services today?",
  amelia: "Hello! I'm Amelia — your AI Spa and Aesthetics Coordinator with BookNexa AI. It's wonderful to connect with you! I'm here to help schedule consultations, answer questions about our treatments, or connect you with a licensed specialist. Would you like to book an appointment or learn more about our services today?",
  kai: "Hey there! I'm Kai — your AI Spa and Aesthetics Coordinator with BookNexa AI. Great to meet you! I can help schedule consultations, answer questions about our treatments, or connect you with a licensed specialist. Would you like to book an appointment or learn more about our services today?"
};

// Theme configurations - map short names to full theme objects
const THEMES: Record<string, { name: string; primary: string; dark: string; darker: string; glow: string; lotus: string }> = {
  'sage': {
    name: 'Sage Zen',
    primary: '#7C9A7C', dark: '#5a7a5a', darker: '#4a6a4a',
    glow: 'rgba(124,154,124,0.3)',
    lotus: 'https://assets.cdn.filesafe.space/NNFCwckEhjBk90UtMRSp/media/6999f31320c035893fa1fb79.png'
  },
  'gold': {
    name: 'Gold Luxury',
    primary: '#C9A962', dark: '#b08d3a', darker: '#8a6e28',
    glow: 'rgba(201,169,98,0.3)',
    lotus: 'https://assets.cdn.filesafe.space/NNFCwckEhjBk90UtMRSp/media/6999fbeb20c035eff8a78ca2.png'
  },
  'blue': {
    name: 'Ocean Blue',
    primary: '#5B9BD5', dark: '#3a7090', darker: '#2a5570',
    glow: 'rgba(91,155,213,0.3)',
    lotus: 'https://assets.cdn.filesafe.space/NNFCwckEhjBk90UtMRSp/media/6999f6e955d8bcc9ace4aa30.png'
  },
  'purple': {
    name: 'Purple Dream',
    primary: '#bea1f7', dark: '#9678d4', darker: '#7a5cb8',
    glow: 'rgba(190,161,247,0.3)',
    lotus: 'https://assets.cdn.filesafe.space/NNFCwckEhjBk90UtMRSp/media/6999f6e908245e25ed4d6c65.png'
  },
  'cream': {
    name: 'Cream Natural',
    primary: '#B8A890', dark: '#8a7a60', darker: '#6a5a40',
    glow: 'rgba(184,168,144,0.3)',
    lotus: 'https://assets.cdn.filesafe.space/NNFCwckEhjBk90UtMRSp/media/6999ef0a08245ebc80488e36.png'
  }
};

// All 33 languages - matching live settings page order
const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'ar', name: 'Arabic', flag: '🇸🇦' },
  { code: 'bg', name: 'Bulgarian', flag: '🇧🇬' },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳' },
  { code: 'hr', name: 'Croatian', flag: '🇭🇷' },
  { code: 'cs', name: 'Czech', flag: '🇨🇿' },
  { code: 'da', name: 'Danish', flag: '🇩🇰' },
  { code: 'nl', name: 'Dutch', flag: '🇳🇱' },
  { code: 'fil', name: 'Filipino', flag: '🇵🇭' },
  { code: 'fi', name: 'Finnish', flag: '🇫🇮' },
  { code: 'fr', name: 'French', flag: '🇫🇷' },
  { code: 'de', name: 'German', flag: '🇩🇪' },
  { code: 'el', name: 'Greek', flag: '🇬🇷' },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { code: 'hu', name: 'Hungarian', flag: '🇭🇺' },
  { code: 'id', name: 'Indonesian', flag: '🇮🇩' },
  { code: 'it', name: 'Italian', flag: '🇮🇹' },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', flag: '🇰🇷' },
  { code: 'ms', name: 'Malay', flag: '🇲🇾' },
  { code: 'no', name: 'Norwegian', flag: '🇳🇴' },
  { code: 'pl', name: 'Polish', flag: '🇵🇱' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', flag: '🇧🇷' },
  { code: 'ro', name: 'Romanian', flag: '🇷🇴' },
  { code: 'ru', name: 'Russian', flag: '🇷🇺' },
  { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
  { code: 'es', name: 'Spanish', flag: '🇪🇸' },
  { code: 'sv', name: 'Swedish', flag: '🇸🇪' },
  { code: 'ta', name: 'Tamil', flag: '🇮🇳' },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷' },
  { code: 'uk', name: 'Ukrainian', flag: '🇺🇦' },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳' }
];

interface WidgetOptions {
  agentId: string;
  theme?: string;
  widgetType?: string;
  agentName?: string;
}

function generateWidgetHTML(options: WidgetOptions): string {
  const {
    agentId,
    theme = 'sage',
    widgetType = 'concierge',
    agentName = 'Sophia'
  } = options;

  // Normalize theme key (handle both "sage" and "sage-zen" formats)
  const themeKey = theme.split('-')[0].toLowerCase();
  const t = THEMES[themeKey] || THEMES['sage'];

  const agentKey = agentName.toLowerCase();
  const elevenLabsId = ELEVENLABS_AGENTS[agentKey] || ELEVENLABS_AGENTS.sophia;
  const greeting = AGENT_GREETINGS[agentKey] || AGENT_GREETINGS.sophia;

  const langListHTML = LANGUAGES.map(l =>
    `<button data-code="${l.code}"><span class="lang-flag">${l.flag}</span> ${l.name}</button>`
  ).join('');

  // Generate different widgets based on type
  if (widgetType === 'banner') {
    return generateBannerWidget({ t, agentName, elevenLabsId, greeting, langListHTML });
  } else if (widgetType === 'classic') {
    return generateClassicWidget({ t, agentName, elevenLabsId, greeting, langListHTML });
  }

  // Default: concierge card widget
  return generateConciergeWidget({ t, agentName, elevenLabsId, greeting, langListHTML });
}

function generateConciergeWidget({ t, agentName, elevenLabsId, greeting, langListHTML }: any): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>BookNexa AI Widget</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500;600&family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400;1,500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      font-family: 'Inter', -apple-system, sans-serif;
      background: transparent;
      overflow: hidden;
    }
    .widget-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px;
    }

    /* ═══ CONCIERGE CARD ═══ */
    .widget-concierge {
      width: 280px;
      --c: ${t.primary};
      --cd: ${t.dark};
      --cdd: ${t.darker};
      --glow: ${t.glow};
    }
    .widget-concierge .glass-shell {
      padding: 10px;
      border-radius: 26px;
      background: rgba(255,255,255,0.25);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-shadow: 0 4px 30px rgba(0,0,0,0.06);
    }
    .widget-concierge .frame {
      border-radius: 18px;
      border: 3px solid var(--c);
      background: #fdfcf8;
      overflow: hidden;
    }
    .widget-concierge .hero {
      background: linear-gradient(170deg, #f8f8f8 0%, #f0f0f0 100%);
      padding: 40px 18px 14px;
      text-align: center;
      position: relative;
    }
    .widget-concierge .v10-lotus {
      width: 100px; height: 100px;
      margin: -35px auto -10px;
      background: url('${t.lotus}') center/170px no-repeat;
    }
    .widget-concierge .v10-name {
      font-family: 'Playfair Display', serif;
      font-size: 22px; font-weight: 500; font-style: italic;
      color: var(--cd);
      margin-bottom: 2px;
    }
    .widget-concierge .v10-role {
      font-family: 'Cormorant Garamond', serif;
      font-size: 11px; font-weight: 500;
      color: var(--cd);
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    .widget-concierge .orn {
      display: flex; align-items: center; justify-content: center;
      gap: 8px; margin-top: 8px;
    }
    .widget-concierge .orn i {
      width: 36px; height: 1px;
      background: linear-gradient(90deg, transparent, var(--c), transparent);
    }
    .widget-concierge .orn b {
      width: 4px; height: 4px; background: var(--c);
      transform: rotate(45deg); font-weight: normal;
    }
    .widget-concierge .action {
      padding: 14px 18px 12px;
      text-align: center;
      background: #fdfcf8;
    }
    .widget-concierge .call-row {
      display: flex; align-items: center; justify-content: center;
      gap: 12px; min-height: 30px; margin-bottom: 10px;
    }
    .widget-concierge .waves {
      display: none; gap: 3px; height: 30px; align-items: center;
    }
    .widget-concierge.speaking .waves { display: flex; }
    .widget-concierge .wb {
      width: 3px; border-radius: 3px;
      background: linear-gradient(to top, var(--cd), var(--c));
      animation: v10wave 0.7s ease-in-out infinite;
    }
    .widget-concierge .wb:nth-child(1) { height: 6px; animation-delay: 0s; }
    .widget-concierge .wb:nth-child(2) { height: 10px; animation-delay: 0.06s; }
    .widget-concierge .wb:nth-child(3) { height: 16px; animation-delay: 0.12s; }
    .widget-concierge .wb:nth-child(4) { height: 22px; animation-delay: 0.18s; }
    .widget-concierge .wb:nth-child(5) { height: 28px; animation-delay: 0.24s; }
    .widget-concierge .wb:nth-child(6) { height: 34px; animation-delay: 0.30s; }
    .widget-concierge .wb:nth-child(7) { height: 38px; animation-delay: 0.36s; }
    .widget-concierge .wb:nth-child(8) { height: 34px; animation-delay: 0.42s; }
    .widget-concierge .wb:nth-child(9) { height: 28px; animation-delay: 0.48s; }
    .widget-concierge .wb:nth-child(10) { height: 22px; animation-delay: 0.54s; }
    .widget-concierge .wb:nth-child(11) { height: 16px; animation-delay: 0.60s; }
    .widget-concierge .wb:nth-child(12) { height: 10px; animation-delay: 0.66s; }
    .widget-concierge .wb:nth-child(13) { height: 6px; animation-delay: 0.72s; }
    @keyframes v10wave { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1.5); } }

    .widget-concierge .v10-call-btn {
      width: 52px; height: 52px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--c) 0%, var(--cd) 60%, var(--cdd) 100%);
      border: 3px solid #fff;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 20px var(--glow);
      transition: all 0.3s;
      position: relative;
      overflow: hidden;
    }
    .widget-concierge .v10-call-btn::before {
      content: '';
      position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(transparent 0deg, rgba(255,255,255,0.2) 90deg, transparent 180deg);
      animation: shimmer 3.5s linear infinite;
    }
    @keyframes shimmer { to { transform: rotate(360deg); } }
    .widget-concierge .v10-call-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 28px var(--glow);
    }
    .widget-concierge .v10-call-btn svg { width: 22px; height: 22px; fill: #fff; position: relative; z-index: 1; }
    .widget-concierge .v10-call-btn .icon-hangup { display: none; }
    .widget-concierge.speaking .v10-call-btn .icon-call { display: none; }
    .widget-concierge.speaking .v10-call-btn .icon-hangup { display: block; }

    .widget-concierge .pulse-ring {
      position: absolute; inset: -8px;
      border-radius: 50%;
      border: 1.5px solid var(--glow);
      animation: pulse 3s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.4; } 50% { transform: scale(1.15); opacity: 0.1; } }

    .widget-concierge .call-label {
      font-size: 10px; font-weight: 500;
      color: var(--cd);
      margin-top: 10px;
    }
    .widget-concierge .svc {
      list-style: none; padding: 10px 18px 2px;
      display: flex; flex-direction: column; gap: 0;
    }
    .widget-concierge .svc li {
      display: flex; align-items: center; gap: 10px;
      padding: 5px 6px; border-radius: 8px;
      font-size: 11px; color: #5a6a5a;
    }
    .widget-concierge .ck {
      width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
    }
    .widget-concierge .ck svg {
      width: 16px; height: 16px;
      fill: none; stroke: var(--c);
      stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
    }
    .widget-concierge .sep {
      display: flex; align-items: center; gap: 12px; padding: 4px 28px;
    }
    .widget-concierge .sep-l { flex: 1; height: 1px; background: linear-gradient(90deg, transparent, #ddd, transparent); }
    .widget-concierge .sep-t {
      font-family: 'Cormorant Garamond', serif;
      font-size: 11px; font-style: italic; color: #b8a890;
    }
    .widget-concierge .chat-toggle {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      margin: 2px auto 10px; width: calc(100% - 36px);
      padding: 9px 16px; border: 1.5px solid #e8e0d2; border-radius: 28px;
      cursor: pointer;
      background: linear-gradient(135deg, rgba(124,154,124,0.05), rgba(124,154,124,0.01));
      font-family: 'Inter', sans-serif; font-size: 12.5px; font-weight: 500;
      color: var(--cd);
      transition: all 0.25s;
    }
    .widget-concierge .chat-toggle:hover {
      background: linear-gradient(135deg, rgba(124,154,124,0.12), rgba(124,154,124,0.04));
      border-color: var(--c);
    }
    .widget-concierge .chat-toggle svg { width: 15px; height: 15px; fill: var(--cd); }
    .widget-concierge .v10-foot {
      background: #f5f1ea;
      padding: 8px 14px;
      text-align: center;
    }
    .widget-concierge .v10-foot p {
      font-family: 'Cormorant Garamond', serif;
      font-size: 10px; font-style: italic; color: #8a7d68;
    }

    /* Chat Panel */
    .widget-concierge .chat-panel { display: none; flex-direction: column; }
    .widget-concierge.chat-open .body-area { display: none; }
    .widget-concierge.chat-open .chat-panel { display: flex; }
    .widget-concierge .ch-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px;
      background: linear-gradient(135deg, var(--c) 0%, var(--cd) 50%, var(--cdd) 100%);
    }
    .widget-concierge .ch-left { display: flex; align-items: center; gap: 10px; }
    .widget-concierge .ch-av {
      width: 32px; height: 32px; border-radius: 50%;
      background: rgba(255,255,255,0.15);
      display: flex; align-items: center; justify-content: center;
    }
    .widget-concierge .ch-av svg { width: 14px; height: 14px; fill: #fff; }
    .widget-concierge .ch-nm { font-size: 13px; font-weight: 600; color: #fff; }
    .widget-concierge .ch-st { font-size: 10px; color: rgba(255,255,255,0.6); display: flex; align-items: center; gap: 4px; }
    .widget-concierge .dot-on { width: 6px; height: 6px; border-radius: 50%; background: #7df28e; }
    .widget-concierge .ch-x {
      width: 28px; height: 28px; border-radius: 50%; border: none;
      background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8);
      font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .widget-concierge .msgs {
      flex: 1; padding: 14px;
      display: flex; flex-direction: column; gap: 8px;
      min-height: 180px; max-height: 220px;
      overflow-y: auto; background: #faf8f3;
    }
    .widget-concierge .msg {
      max-width: 82%; padding: 10px 14px;
      border-radius: 18px; font-size: 12.5px; line-height: 1.55;
    }
    .widget-concierge .msg.a {
      align-self: flex-start;
      background: #f3efe5; color: #352e24;
      border-bottom-left-radius: 4px;
    }
    .widget-concierge .msg.u {
      align-self: flex-end;
      background: linear-gradient(135deg, var(--c), var(--cd));
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .widget-concierge .typing {
      align-self: flex-start; display: none; gap: 4px;
      padding: 12px 16px; background: #f3efe5;
      border-radius: 18px; border-bottom-left-radius: 4px;
    }
    .widget-concierge .typing.active { display: flex; }
    .widget-concierge .td {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--c); opacity: 0.3;
      animation: bounce 1.2s ease-in-out infinite;
    }
    .widget-concierge .td:nth-child(2) { animation-delay: 0.15s; }
    .widget-concierge .td:nth-child(3) { animation-delay: 0.3s; }
    @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.3; } 30% { transform: translateY(-6px); opacity: 1; } }
    .widget-concierge .chips {
      display: flex; gap: 6px; flex-wrap: wrap;
      padding: 6px 14px 10px; background: #faf8f3;
    }
    .widget-concierge .chip {
      padding: 6px 14px; border-radius: 20px;
      border: 1px solid #e8e0d2;
      background: #fff; color: var(--cd);
      font-size: 11px; font-weight: 500; cursor: pointer;
    }
    .widget-concierge .inp-row {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; border-top: 1px solid #e8e0d2;
      background: #fff;
    }
    .widget-concierge .inp {
      flex: 1; border: 1.5px solid #e8e0d2; border-radius: 22px;
      padding: 9px 16px; font-size: 12px; outline: none;
    }
    .widget-concierge .send-btn {
      width: 34px; height: 34px; min-width: 34px; min-height: 34px;
      border-radius: 50%; border: none;
      background: linear-gradient(135deg, var(--c), var(--cd));
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .widget-concierge .send-btn svg { width: 14px; height: 14px; fill: #fff; }
    .widget-concierge .btn-mic {
      width: 34px; height: 34px; min-width: 34px; min-height: 34px;
      border-radius: 50%; border: none;
      background: transparent; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .widget-concierge .btn-mic svg { width: 18px; height: 18px; fill: #999; }

    /* Language selector */
    .lang-globe-wrapper {
      position: absolute; top: 7px; right: 11px; z-index: 50;
    }
    .lang-globe-btn {
      padding: 0; border: none; background: transparent;
      cursor: pointer; display: flex; align-items: center; gap: 3px;
      color: var(--cd);
    }
    .lang-globe-btn .lang-icon { width: 16px; height: 16px; }
    .lang-globe-btn .lang-arrow-text { font-size: 8px; }
    .lang-dropdown {
      display: none;
      position: absolute; top: calc(100% + 4px); right: 0;
      background: #fff; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      min-width: 130px; z-index: 100;
    }
    .lang-dropdown.open { display: block; }
    .lang-search {
      width: 100%; padding: 6px 10px;
      border: none; border-bottom: 1px solid rgba(0,0,0,0.08);
      font-size: 10px; outline: none;
    }
    .lang-list { max-height: 200px; overflow-y: auto; }
    .lang-dropdown button {
      width: 100%; padding: 8px 12px;
      border: none; background: transparent;
      font-size: 11px; color: #555; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
    }
    .lang-dropdown button:hover { background: rgba(0,0,0,0.04); }
    .lang-dropdown button.selected { font-weight: 600; }
  </style>
</head>
<body>
  <div class="widget-container">
    <div class="widget-concierge" id="widget">
      <div class="glass-shell">
        <div class="frame">
          <div class="hero">
            <div class="lang-globe-wrapper" id="langWrapper">
              <button class="lang-globe-btn" id="langBtn">
                <svg class="lang-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="4" ry="10" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>
                <span class="lang-arrow-text">▼</span>
              </button>
              <div class="lang-dropdown" id="langDropdown">
                <input type="text" class="lang-search" id="langSearch" placeholder="Search...">
                <div class="lang-list" id="langList">${langListHTML}</div>
              </div>
            </div>
            <div class="v10-lotus"></div>
            <h2 class="v10-name">Meet <span id="agentNameEl">${agentName}</span></h2>
            <p class="v10-role">Your AI Spa Concierge</p>
            <div class="orn"><i></i><b></b><i></i></div>
          </div>
          <div class="body-area" id="bodyArea">
            <div class="action">
              <div class="call-row">
                <div class="waves">
                  <div class="wb"></div><div class="wb"></div><div class="wb"></div>
                  <div class="wb"></div><div class="wb"></div><div class="wb"></div>
                  <div class="wb"></div><div class="wb"></div><div class="wb"></div>
                  <div class="wb"></div><div class="wb"></div><div class="wb"></div>
                  <div class="wb"></div>
                </div>
                <div style="position:relative;display:inline-block;">
                  <div class="pulse-ring"></div>
                  <button class="v10-call-btn" id="callBtn">
                    <svg class="icon-call" viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
                    <svg class="icon-hangup" viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
                  </button>
                </div>
              </div>
              <div class="call-label">Tap to speak with <span id="agentNameLabel">${agentName}</span></div>
            </div>
            <ul class="svc">
              <li><span class="ck"><svg viewBox="0 0 24 24"><polyline points="4 12 9 17 20 6"/></svg></span> Scheduling appointments</li>
              <li><span class="ck"><svg viewBox="0 0 24 24"><polyline points="4 12 9 17 20 6"/></svg></span> Spa treatment questions</li>
              <li><span class="ck"><svg viewBox="0 0 24 24"><polyline points="4 12 9 17 20 6"/></svg></span> Pricing & packages</li>
              <li><span class="ck"><svg viewBox="0 0 24 24"><polyline points="4 12 9 17 20 6"/></svg></span> Treatment options</li>
              <li><span class="ck"><svg viewBox="0 0 24 24"><polyline points="4 12 9 17 20 6"/></svg></span> Membership info</li>
              <li><span class="ck"><svg viewBox="0 0 24 24"><polyline points="4 12 9 17 20 6"/></svg></span> Hours & availability</li>
            </ul>
            <div class="sep"><span class="sep-l"></span><span class="sep-t">or</span><span class="sep-l"></span></div>
            <button class="chat-toggle" id="chatToggle">
              <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
              Chat with <span id="agentNameChat">${agentName}</span>
            </button>
          </div>
          <div class="chat-panel" id="chatPanel">
            <div class="ch-head">
              <div class="ch-left">
                <div class="ch-av"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg></div>
                <div>
                  <div class="ch-nm" id="agentNameHeader">${agentName}</div>
                  <div class="ch-st"><span class="dot-on"></span> Online now</div>
                </div>
              </div>
              <button class="ch-x" id="chatClose">×</button>
            </div>
            <div class="msgs" id="msgs">
              <div class="msg a" id="greetingMsg">Hi! I'm ${agentName}, your AI spa concierge. How can I help you today?</div>
              <div class="typing" id="typing"><div class="td"></div><div class="td"></div><div class="td"></div></div>
            </div>
            <div class="chips" id="chips">
              <button class="chip" data-msg="I'd like to book an appointment">Book Appt</button>
              <button class="chip" data-msg="What services do you offer?">Services</button>
              <button class="chip" data-msg="Tell me about your packages">Packages</button>
              <button class="chip" data-msg="What are your prices?">Pricing</button>
            </div>
            <div class="inp-row">
              <input class="inp" id="chatInput" type="text" placeholder="Type a message..." autocomplete="off">
              <button class="btn-mic" id="micBtn"><svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></button>
              <button class="send-btn" id="sendBtn"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
            </div>
          </div>
          <div class="v10-foot"><p>Confidential consultations with licensed providers</p></div>
        </div>
      </div>
    </div>
  </div>

  <script type="module">
    import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@0.15.0/+esm';

    const AGENT_ID = '${elevenLabsId}';
    const GREETING = ${JSON.stringify(greeting)};
    let conversation = null;  // Voice session
    let chatSession = null;   // Text-only chat session (separate from voice)
    let currentLang = 'en';

    const widget = document.getElementById('widget');
    const callBtn = document.getElementById('callBtn');
    const chatToggle = document.getElementById('chatToggle');
    const chatClose = document.getElementById('chatClose');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const msgs = document.getElementById('msgs');
    const chips = document.getElementById('chips');
    const typing = document.getElementById('typing');
    const langBtn = document.getElementById('langBtn');
    const langDropdown = document.getElementById('langDropdown');
    const langSearch = document.getElementById('langSearch');
    const langList = document.getElementById('langList');

    function addMessage(text, isUser) {
      const msg = document.createElement('div');
      msg.className = 'msg ' + (isUser ? 'u' : 'a');
      msg.textContent = text;
      msgs.insertBefore(msg, typing);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function setTyping(show) {
      typing.classList.toggle('active', show);
      if (show) msgs.scrollTop = msgs.scrollHeight;
    }

    async function sendMessage(text) {
      if (!text.trim()) return;
      addMessage(text, true);
      chatInput.value = '';
      chips.style.display = 'none';
      setTyping(true);

      // Use text-only chat session (separate from voice)
      if (!chatSession) {
        try {
          chatSession = await Conversation.startSession({
            agentId: AGENT_ID,
            overrides: {
              conversation: { textOnly: true },
              agent: { firstMessage: GREETING, language: currentLang }
            },
            onMessage: (m) => {
              if (m.source === 'ai') {
                setTyping(false);
                addMessage(m.message, false);
              }
            },
            onError: () => setTyping(false),
            onDisconnect: () => { chatSession = null; }
          });
        } catch (e) {
          console.error('Chat session error:', e);
          setTyping(false);
          return;
        }
      }
      // Send the text message
      if (chatSession && chatSession.sendUserMessage) {
        chatSession.sendUserMessage(text);
      }
    }

    async function startVoice() {
      if (conversation) {
        await conversation.endSession();
        conversation = null;
        widget.classList.remove('speaking');
        window.parent.postMessage({ type: 'bnx-speaking', speaking: false }, '*');
        return;
      }
      try {
        conversation = await Conversation.startSession({
          agentId: AGENT_ID,
          connectionType: 'websocket',
          workletPaths: {
            'rawAudioProcessor': '/elevenlabs/rawAudioProcessor.js',
            'audioConcatProcessor': '/elevenlabs/audioConcatProcessor.js',
          },
          overrides: { agent: { firstMessage: GREETING, language: currentLang } },
          onConnect: () => {
            widget.classList.add('speaking');
            window.parent.postMessage({ type: 'bnx-speaking', speaking: true }, '*');
          },
          onDisconnect: () => {
            widget.classList.remove('speaking');
            window.parent.postMessage({ type: 'bnx-speaking', speaking: false }, '*');
            conversation = null;
          },
          onMessage: (m) => {
            if (m.source === 'ai') { setTyping(false); addMessage(m.message, false); }
            else if (m.source === 'user') { addMessage(m.message, true); setTyping(true); }
          },
          onError: () => { widget.classList.remove('speaking'); }
        });
      } catch (e) { console.error(e); }
    }

    callBtn.addEventListener('click', startVoice);
    chatToggle.addEventListener('click', () => widget.classList.add('chat-open'));
    chatClose.addEventListener('click', () => widget.classList.remove('chat-open'));
    sendBtn.addEventListener('click', () => sendMessage(chatInput.value));
    chatInput.addEventListener('keypress', e => { if (e.key === 'Enter') sendMessage(chatInput.value); });
    chips.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => sendMessage(c.dataset.msg)));

    langBtn.addEventListener('click', e => { e.stopPropagation(); langDropdown.classList.toggle('open'); });
    langSearch.addEventListener('input', e => {
      const f = e.target.value.toLowerCase();
      langList.querySelectorAll('button').forEach(b => b.style.display = b.textContent.toLowerCase().includes(f) ? 'flex' : 'none');
    });
    langList.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) { currentLang = b.dataset.code; langDropdown.classList.remove('open'); }
    });
    document.addEventListener('click', e => { if (!langDropdown.contains(e.target) && e.target !== langBtn) langDropdown.classList.remove('open'); });

    window.addEventListener('message', e => { if (e.data?.type === 'bnx-close' && conversation) conversation.endSession(); });
  </script>
</body>
</html>`;
}

function generateBannerWidget({ t, agentName, elevenLabsId, greeting, langListHTML }: any): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BookNexa AI Widget - Banner</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      font-family: 'Inter', -apple-system, sans-serif;
      background: transparent;
    }
    .widget-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .widget-banner {
      --c: ${t.primary};
      --cd: ${t.dark};
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      background: linear-gradient(135deg, rgba(255,255,255,0.95), rgba(255,255,255,0.85));
      backdrop-filter: blur(10px);
      border-radius: 16px;
      border: 2px solid var(--c);
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      max-width: 500px;
    }
    .banner-icon {
      width: 48px; height: 48px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--c), var(--cd));
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .banner-icon svg { width: 24px; height: 24px; fill: white; }
    .banner-content { flex: 1; }
    .banner-title {
      font-size: 16px; font-weight: 600;
      color: #1a1a1a; margin-bottom: 4px;
    }
    .banner-subtitle {
      font-size: 13px; color: #666;
    }
    .banner-btn {
      padding: 12px 20px;
      background: linear-gradient(135deg, var(--c), var(--cd));
      border: none; border-radius: 25px;
      color: white; font-size: 14px; font-weight: 500;
      cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .banner-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 15px rgba(124,154,124,0.4);
    }
    .banner-btn svg { width: 18px; height: 18px; fill: currentColor; }
    .widget-banner.speaking .banner-btn { background: #dc3545; }
  </style>
</head>
<body>
  <div class="widget-container">
    <div class="widget-banner" id="widget">
      <div class="banner-icon">
        <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg>
      </div>
      <div class="banner-content">
        <h3 class="banner-title">Your AI Spa Concierge</h3>
        <p class="banner-subtitle">Speak with ${agentName} about appointments, treatments & pricing</p>
      </div>
      <button class="banner-btn" id="callBtn">
        <svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
        <span>Start Conversation</span>
      </button>
    </div>
  </div>
  <script type="module">
    import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@0.15.0/+esm';
    const AGENT_ID = '${elevenLabsId}';
    const GREETING = ${JSON.stringify(greeting)};
    let conversation = null;
    const widget = document.getElementById('widget');
    const callBtn = document.getElementById('callBtn');

    async function toggleCall() {
      if (conversation) {
        await conversation.endSession();
        conversation = null;
        widget.classList.remove('speaking');
        callBtn.querySelector('span').textContent = 'Start Conversation';
        return;
      }
      try {
        conversation = await Conversation.startSession({
          agentId: AGENT_ID,
          connectionType: 'websocket',
          workletPaths: {
            'rawAudioProcessor': '/elevenlabs/rawAudioProcessor.js',
            'audioConcatProcessor': '/elevenlabs/audioConcatProcessor.js',
          },
          overrides: { agent: { firstMessage: GREETING } },
          onConnect: () => {
            widget.classList.add('speaking');
            callBtn.querySelector('span').textContent = 'End Call';
          },
          onDisconnect: () => {
            widget.classList.remove('speaking');
            callBtn.querySelector('span').textContent = 'Start Conversation';
            conversation = null;
          }
        });
      } catch (e) { console.error(e); }
    }
    callBtn.addEventListener('click', toggleCall);
  </script>
</body>
</html>`;
}

function generateClassicWidget({ t, agentName, elevenLabsId, greeting, langListHTML }: any): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BookNexa AI Widget - Classic</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      font-family: 'Inter', -apple-system, sans-serif;
      background: transparent;
    }
    .widget-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .widget-classic {
      --c: ${t.primary};
      --cd: ${t.dark};
    }
    .classic-btn {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 28px;
      background: linear-gradient(135deg, var(--c), var(--cd));
      border: none;
      border-radius: 30px;
      color: white;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .classic-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 25px rgba(0,0,0,0.2);
    }
    .classic-btn svg { width: 20px; height: 20px; fill: currentColor; }
    .classic-waves {
      display: none;
      gap: 3px;
      height: 20px;
      align-items: center;
    }
    .widget-classic.speaking .classic-waves { display: flex; }
    .widget-classic.speaking .icon-call { display: none; }
    .wave-bar {
      width: 3px;
      border-radius: 3px;
      background: white;
      animation: wave 0.6s ease-in-out infinite;
    }
    .wave-bar:nth-child(1) { height: 8px; animation-delay: 0s; }
    .wave-bar:nth-child(2) { height: 14px; animation-delay: 0.1s; }
    .wave-bar:nth-child(3) { height: 20px; animation-delay: 0.2s; }
    .wave-bar:nth-child(4) { height: 14px; animation-delay: 0.3s; }
    .wave-bar:nth-child(5) { height: 8px; animation-delay: 0.4s; }
    @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
  </style>
</head>
<body>
  <div class="widget-container">
    <div class="widget-classic" id="widget">
      <button class="classic-btn" id="callBtn">
        <svg class="icon-call" viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>
        <div class="classic-waves">
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
        </div>
        <span>Speak to ${agentName}</span>
      </button>
    </div>
  </div>
  <script type="module">
    import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@0.15.0/+esm';
    const AGENT_ID = '${elevenLabsId}';
    const GREETING = ${JSON.stringify(greeting)};
    let conversation = null;
    const widget = document.getElementById('widget');
    const callBtn = document.getElementById('callBtn');

    async function toggleCall() {
      if (conversation) {
        await conversation.endSession();
        conversation = null;
        widget.classList.remove('speaking');
        return;
      }
      try {
        conversation = await Conversation.startSession({
          agentId: AGENT_ID,
          connectionType: 'websocket',
          workletPaths: {
            'rawAudioProcessor': '/elevenlabs/rawAudioProcessor.js',
            'audioConcatProcessor': '/elevenlabs/audioConcatProcessor.js',
          },
          overrides: { agent: { firstMessage: GREETING } },
          onConnect: () => widget.classList.add('speaking'),
          onDisconnect: () => { widget.classList.remove('speaking'); conversation = null; }
        });
      } catch (e) { console.error(e); }
    }
    callBtn.addEventListener('click', toggleCall);
  </script>
</body>
</html>`;
}

export async function widgetRenderHandler(req: Request, res: Response): Promise<void> {
  const { agentId, theme = 'sage', widget = 'concierge', agent = 'sophia' } = req.query;

  if (!agentId) {
    res.status(400).send('Missing agentId parameter');
    return;
  }

  const html = generateWidgetHTML({
    agentId: agentId as string,
    theme: theme as string,
    widgetType: widget as string,
    agentName: (agent as string).charAt(0).toUpperCase() + (agent as string).slice(1).toLowerCase()
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Permissions-Policy', 'microphone=(*), autoplay=(*)');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(html);
}
