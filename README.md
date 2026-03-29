# SleepyAfk v3.0 — Minecraft AFK Bot Manager

## Features
- **Bots persist across page reloads** — server remembers which bots were running
- **Auto-Rejoin** — reconnects after any kick or disconnect
- **Auto-Leave on Kick** — stay offline after a kick (overrides auto-rejoin)
- **On-Join Command** — runs a command 1.5s after every spawn (including cycle rejoins)
- **Cycle Leave/Rejoin** — bot leaves every X minutes, waits Y seconds, rejoins, runs on-join command
- **Anti-AFK** — jump/walk/look on configurable intervals
- **Timed Messages** — schedule messages with h/m/s precision
- **Live Console** — real-time logs, send chat and commands manually

## Setup
```bash
npm install
npm start
```
Open http://localhost:3000

## How Cycle Leave/Rejoin works
1. Bot connects and runs on-join command
2. After X minutes it gracefully disconnects
3. Waits Y seconds
4. Reconnects and runs on-join command again
5. Repeats forever until manually stopped

## Fix: Bots no longer reset on page reload
The server now saves running bot IDs to `data/running.json`.
When the page reloads, `/api/bots` returns accurate online/offline status.
If the *server* itself restarts, it auto-restarts any bots that were running.
