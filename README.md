# AI Newscaster - Voice Server

The voice server component of AI Newscaster, powered by xAI's Grok Realtime Voice API. This server handles phone calls via Twilio, processes voice conversations with Grok, and integrates with the X (Twitter) API for personalized news and social media interactions.

## Overview

AI Newscaster is a voice-powered AI assistant that delivers personalized news briefings and manages your X account hands-free. Users call a phone number and interact with Grok, who acts as a professional news anchor capable of:

- Fetching trending news and topics from X
- Reading posts from specific users
- Checking and sending DMs (authenticated users)
- Posting tweets on your behalf (authenticated users)
- Providing personalized news based on who you follow

## Architecture

```
+----------+     +----------+     +------------------+     +-------------+
|  Phone   |---->|  Twilio  |---->|   Voice Server   |---->| xAI Grok    |
|  Call    |<----|  Media   |<----|   (This Repo)    |<----| Realtime    |
+----------+     +----------+     +--------+---------+     +-------------+
                                           |
              +----------------------------+----------------------------+
              |                            |                            |
       +------v------+              +------v------+              +------v------+
       |   Django    |              |   X API     |              | Transcripts |
       |   Backend   |              |  (Twitter)  |              |   Storage   |
       | (User Auth) |              |             |              |             |
       +-------------+              +-------------+              +-------------+
```

## Voice Agent Capabilities

The Grok voice agent has access to **7 tools** for fetching data and performing actions:

### Public Tools (No Authentication Required)

| Tool | Description | Parameters |
|------|-------------|------------|
| `search_news_topic` | Search X for recent posts about any topic | `topic` (string) |
| `get_trending_news` | Fetch current trending topics with top posts | `country` (US/UK/CA/AU) |
| `get_user_posts` | Get latest posts from a specific X user | `username` (string) |

### Authenticated Tools (Requires X Account Link)

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_my_following` | List X accounts the caller follows | None |
| `get_direct_messages` | View recent DM conversations | `limit` (1-50) |
| `send_dm` | Send a direct message to any user | `recipient_username`, `message` |
| `post_tweet` | Post a tweet on the caller's behalf | `text` (max 280 chars) |

## Voice Persona

The agent uses the **Rex** voice and embodies a CNN/BBC-style news anchor personality:
- Professional, confident, and authoritative
- Conversational without being robotic
- Delivers news in engaging broadcast format (~45-60 second segments)
- Synthesizes posts into coherent narratives (doesn't just list items)

## Authentication Flow

```
1. User calls phone number
2. Twilio forwards call to voice server
3. Server looks up user by phone number via Django API
4. If authenticated (X account linked):
   - Grok greets user by name
   - All 7 tools available
   - Can read DMs, post tweets, etc.
5. If not authenticated:
   - Generic greeting
   - Only public tools available (search, trending, user posts)
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Web Framework**: Express.js
- **Phone Integration**: Twilio Media Streams (WebSocket)
- **AI/Voice**: xAI Grok Realtime API (WebSocket)
- **Social API**: X API v2
- **Backend**: Django REST Framework (separate repo)

## Prerequisites

- Node.js 18+
- Twilio account with a phone number
- xAI API key ([console.x.ai](https://console.x.ai))
- X API Bearer Token ([developer.x.com](https://developer.x.com))
- ngrok or similar tunneling service
- Django backend running ([ai-newscaster](https://github.com/your-username/ai-newscaster) repo)

## Installation

```bash
cd examples/agent/telephony/xai

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

## Configuration

Edit `.env` with your credentials:

```env
# Required - xAI API key for Grok voice
XAI_API_KEY=your-xai-api-key

# Required - Public hostname for Twilio webhooks
HOSTNAME=your-ngrok-domain.ngrok-free.app

# Required - X API Bearer Token (for public endpoints)
X_BEARER_TOKEN=your-x-bearer-token

# Required - Django backend URL (for user auth & transcripts)
BACKEND_URL=http://localhost:8000

# Optional - Server port (default: 3000)
PORT=3000
```

## Running the Server

### 1. Start ngrok tunnel

```bash
ngrok http 3000
```

Copy the ngrok domain (e.g., `abc123.ngrok-free.app`) to your `.env` file.

### 2. Start the voice server

```bash
# Development with hot reload
npm run dev

# Production
npm start
```

### 3. Configure Twilio webhooks

In [Twilio Console](https://console.twilio.com), configure your phone number:

| Setting | Value |
|---------|-------|
| Voice URL | `https://your-domain.ngrok-free.app/twiml` (POST) |
| Status Callback | `https://your-domain.ngrok-free.app/call-status` (POST) |

### 4. Start the Django backend

See the [ai-newscaster](https://github.com/your-username/ai-newscaster) repo for backend setup.

## Project Structure

```
examples/agent/telephony/xai/
|-- src/
|   |-- index.ts         # Express server, WebSocket orchestration, call handling
|   |-- bot.ts           # Grok persona, voice config, system instructions
|   |-- tools.ts         # Tool definitions and execution dispatcher
|   |-- x-api.ts         # X API v2 integration (search, trends, DMs, tweets)
|   |-- user-auth.ts     # Phone-based user lookup via Django backend
|   |-- twilio.ts        # Twilio Media Stream WebSocket wrapper
|   +-- transcoder.ts    # Audio format conversion utilities
|-- .env.example
|-- package.json
+-- tsconfig.json
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/twiml` | POST | Twilio incoming call webhook - returns TwiML |
| `/call-status` | POST | Twilio call status updates |
| `/media-stream/:callId` | WebSocket | Bidirectional audio stream with Twilio |
| `/` | GET | Health check |

## Django Backend Integration

The voice server communicates with the Django backend for:

### User Authentication
```
GET /api/users/token?phone={phoneNumber}
```
Returns user info and OAuth tokens if the phone number is linked to an X account.

### Transcript Storage
```
POST /api/conversations/                    # Create conversation
POST /api/conversations/{id}/messages       # Save transcript message
PATCH /api/conversations/{id}               # Mark conversation ended
POST /api/conversations/{id}/generate-title # Generate title via LLM
```

## Audio Pipeline

```
Twilio (8kHz PCMU) --> Voice Server --> xAI Grok (8kHz PCMU)
                   <--             <--
```

- **Input**: Twilio sends 8kHz mu-law (PCMU) audio
- **Processing**: xAI handles speech recognition and synthesis
- **Output**: xAI returns 8kHz mu-law audio directly
- **VAD**: Server-side voice activity detection by xAI

## Example Voice Commands

### For Everyone
- "What's trending right now?"
- "Search for news about AI"
- "What has @elonmusk been posting?"

### For Authenticated Users
- "Who do I follow?"
- "Check my DMs"
- "Send a DM to @friend saying hello"
- "Tweet: Just tried AI Newscaster and it's amazing!"

## Troubleshooting

### Call connects but no audio
- Verify `HOSTNAME` in `.env` matches your ngrok domain
- Check that ngrok is running and forwarding to port 3000

### "User not authenticated" for all calls
- Ensure Django backend is running at `BACKEND_URL`
- Verify user has linked their X account via the web dashboard

### X API errors
- Check `X_BEARER_TOKEN` is valid
- Verify X Developer App has required permissions

### Tool calls fail
- Check server logs for detailed error messages
- Verify OAuth tokens haven't expired (re-authenticate via web)

## Related Repositories

- **[ai-newscaster](https://github.com/your-username/ai-newscaster)** - Django backend + SvelteKit frontend

## License

MIT
