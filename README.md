# 🃏 Poker Night — Texas Hold'em

Multiplayer Texas Hold'em for up to 10 players, with optional live webcam video via WebRTC.

## Features
- Full Texas Hold'em rules (preflop → flop → turn → river → showdown)
- Up to 10 players per table
- Configurable buy-in, small blind, big blind, and ante
- Live webcam video for each player (WebRTC, optional)
- In-game chat
- Automatic hand evaluation with hand names (in Russian)
- 7-second showdown display before next hand

## Deploy to Railway

1. Push this folder to a GitHub repository
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. Done! Railway sets `PORT` automatically

No environment variables needed.

## Run Locally

```bash
npm install
npm start
# Open http://localhost:3000
```

## How to Play

1. **Create a table** — Enter your name and configure blinds/buy-in, then share the 6-letter room code
2. **Join** — Other players enter your room code
3. **Host starts** — The creator presses Start Game (minimum 2 players)
4. **Camera** — Click 📷 to share your webcam (requires browser permission)

## Notes

- WebRTC video uses Google's public STUN servers — works for most home networks
- Players behind symmetric NAT may not see each other's video (gameplay still works)
- All state is in-memory; restarting the server ends all games
