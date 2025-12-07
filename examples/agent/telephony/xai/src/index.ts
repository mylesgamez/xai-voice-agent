import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import * as crypto from "crypto";
import bot from "./bot";
import log from "./logger";
import type { CallStatus } from "./twilio";
import { TwilioMediaStreamWebsocket } from "./twilio";
import { executeToolCall, ToolName } from "./tools";
import { initUserContext, cleanupCallContext, UserContext } from "./user-auth";

// Store phone numbers by callId (set during /twiml, used during /media-stream)
const callPhoneNumbers = new Map<string, string>();

// Store conversation IDs by callId (for transcript storage)
const callConversationIds = new Map<string, string>();

// Store bot transcript buffer by callId (accumulate deltas)
const botTranscriptBuffers = new Map<string, string>();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

// ========================================
// Conversation/Transcript API Helpers
// ========================================
async function createConversation(phoneNumber: string, callId: string): Promise<string | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/conversations/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number: phoneNumber,
        call_id: callId,
        title: 'Phone Call'
      })
    });
    if (response.ok) {
      const data = await response.json() as { id: string };
      log.app.info(`[${callId}] 📝 Conversation created: ${data.id}`);
      return data.id;
    }
    log.app.warn(`[${callId}] Failed to create conversation: ${response.status}`);
    return null;
  } catch (error) {
    log.app.error(`[${callId}] Error creating conversation:`, error);
    return null;
  }
}

async function sendTranscriptMessage(
  callId: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role,
        content,
        source: 'voice',
        generate_reply: false
      })
    });
    log.app.debug(`[${callId}] 📝 Transcript saved (${role})`);
  } catch (error) {
    log.app.error(`[${callId}] Error saving transcript:`, error);
  }
}

async function endConversation(callId: string, conversationId: string): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/api/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ended_at: new Date().toISOString() })
    });
    log.app.info(`[${callId}] 📝 Conversation ended`);
  } catch (error) {
    log.app.error(`[${callId}] Error ending conversation:`, error);
  }
}

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ========================================
// Configuration
// ========================================
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const API_URL = process.env.API_URL || "wss://api.x.ai/v1/realtime";

// ========================================
// Secure Event Logger (async, structured)
// ========================================
// NOTE: Use Winston or similar logging library in production
// This is a simple structured logger replacement for the insecure file logging
function logWebSocketEvent(callId: string, direction: 'SEND' | 'RECV', event: any) {
  const eventCopy = typeof event === 'string' ? JSON.parse(event) : event;

  // Skip logging raw audio chunks
  if (eventCopy.type === 'input_audio_buffer.append' ||
    eventCopy.type === 'response.output_audio.delta') {
    return;
  }

  // Log to console with structure (in production, use Winston/Bunyan)
  log.app.debug({
    timestamp: new Date().toISOString(),
    callId,
    direction,
    eventType: eventCopy.type,
    // Don't log full event to avoid sensitive data exposure
  });
}

// Helper to generate cryptographically secure IDs
function generateSecureId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

// ========================================
// Health Check Endpoint
// ========================================
app.get("/health", (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  res.json(health);
});

// ========================================
// Twilio Voice Webhook Endpoints
// ========================================
app.post("/twiml", async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  log.twl.info(`twiml from ${from} to ${to}`);

  try {
    // Generate a cryptographically secure call ID
    const callId = generateSecureId('call');
    log.app.info(`[${callId}] Processing incoming call from ${from}`);

    // Store the phone number for this call (will be used to look up user auth)
    callPhoneNumbers.set(callId, from);

    res.status(200);
    res.type("text/xml");

    // Extract domain from HOSTNAME (remove https:// if present)
    const hostname = process.env.HOSTNAME!.replace(/^https?:\/\//, '');
    const streamUrl = `wss://${hostname}/media-stream/${callId}`;
    log.app.info(`[${callId}] Generated WebSocket URL: ${streamUrl}`);
    log.app.info(`[${callId}] Using HOSTNAME: ${process.env.HOSTNAME}`);

    // The <Stream/> TwiML noun tells Twilio to send the call to the websocket endpoint below.
    const twimlResponse = `\
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>
`;
    log.app.info(`[${callId}] Sending TwiML response`);
    res.end(twimlResponse);
    log.app.info(`[${callId}] Incoming call processed successfully`);
  } catch (error) {
    log.app.error(`[${req.body.From}] Incoming call webhook failed:`, error);
    res.status(500).send();
  }
});

app.post("/call-status", async (req, res) => {
  const status = req.body.CallStatus as CallStatus;
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  if (status === "error") {
    log.twl.error(`[${callSid}] call-status ERROR from ${from} to ${to}`);
  } else {
    log.twl.info(`[${callSid}] call-status ${status} from ${from} to ${to}`);
  }

  res.status(200).send();
});

// ========================================
// Twilio Media Stream Websocket Endpoint
// ========================================
app.ws("/media-stream/:callId", async (ws, req) => {
  const callId = req.params.callId;
  log.twl.info(`[${callId}] WebSocket initializing`);

  // CRITICAL: Set up Twilio wrapper and start handler IMMEDIATELY
  // The 'start' event arrives as soon as WebSocket connects - BEFORE any async ops complete
  const tw = new TwilioMediaStreamWebsocket(ws);
  let twilioReady = false;

  // Deferred greeting check - called when Twilio is ready (after trySendGreeting is defined)
  let pendingTwilioReady = false;

  tw.on("start", (msg) => {
    tw.streamSid = msg.start.streamSid;
    twilioReady = true;
    pendingTwilioReady = true; // Signal that we should try greeting
    log.app.info(`[${callId}] Twilio WebSocket ready - streamSid: ${tw.streamSid}`);
  });

  // Now do async operations (user lookup, conversation creation)
  const phoneNumber = callPhoneNumbers.get(callId);
  let userContext: UserContext | undefined;

  if (phoneNumber) {
    log.app.info(`[${callId}] Looking up user auth for ${phoneNumber}`);
    userContext = await initUserContext(callId, phoneNumber);

    if (userContext.auth.authenticated) {
      log.app.info(`[${callId}] 🔐 User authenticated as @${userContext.auth.x_username}`);
    } else {
      log.app.info(`[${callId}] 👤 User not authenticated (no X account linked)`);
    }

    // Create conversation in Django for transcript storage
    const conversationId = await createConversation(phoneNumber, callId);
    if (conversationId) {
      callConversationIds.set(callId, conversationId);
    }
  }

  // Create raw WebSocket connection to x.ai (since RealtimeClient doesn't work)
  log.app.info(`[${callId}] Connecting to XAI API...`);

  const WebSocket = require('ws');
  const xaiWs = new WebSocket(API_URL, {
    headers: {
      'Authorization': `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  // Wait for x.ai WebSocket to be ready
  await new Promise((resolve, reject) => {
    const wsTimeout = setTimeout(() => {
      xaiWs.close();
      reject(new Error("x.ai WebSocket connection timeout"));
    }, 10000);

    xaiWs.on('open', () => {
      clearTimeout(wsTimeout);
      log.app.info(`[${callId}] x.ai WebSocket connected successfully`);
      log.app.info(`[${callId}] x.ai WebSocket readyState: ${xaiWs.readyState}`);
      resolve(null);
    });

    xaiWs.on('error', (error: any) => {
      clearTimeout(wsTimeout);
      log.app.error(`[${callId}] ❌ x.ai WebSocket error:`, error);
      reject(error);
    });
  });

  // ========================================
  // Audio Orchestration
  // ========================================
  log.app.info(`[${callId}] Setting up audio event handlers`);
  log.app.info(`[${callId}] 🎙️  Server-side VAD enabled`);

  // Track ongoing function calls
  const functionCallState: {
    callId: string | null;
    name: string | null;
    arguments: string;
  } = {
    callId: null,
    name: null,
    arguments: '',
  };

  // Track if session is ready to receive audio (after session.updated)
  // XAI defaults to 24kHz, we configure 8kHz PCMU - must wait for session.updated
  let sessionReady = false;

  // Track if greeting has been sent (to avoid duplicate greetings)
  let greetingSent = false;

  // Function to send greeting when both XAI session and Twilio are ready
  const trySendGreeting = () => {
    if (greetingSent || !sessionReady || !tw.streamSid) {
      return; // Not ready yet or already sent
    }
    greetingSent = true;

    log.app.info(`[${callId}] 🚀 Both XAI session and Twilio ready - sending greeting`);

    // Determine time of day for greeting
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

    // Build greeting prompt based on user auth status
    let greetingPrompt: string;
    if (userContext?.auth.authenticated) {
      // Extract unique authors from liked tweets for personalization
      let circleContext = '';
      if (userContext.auth.liked_tweets?.length) {
        const likedAuthors = [...new Set(
          userContext.auth.liked_tweets
            .map(t => {
              const name = t.author_name || t.author_username;
              const username = t.author_username;
              if (name && username && name !== username) {
                return `${name} (@${username})`;
              }
              return username || name;
            })
            .filter(Boolean)
        )].slice(0, 3);

        if (likedAuthors.length > 0) {
          circleContext = `, or on what your circle's been talking about – like ${likedAuthors.join(', ')} from accounts you've been liking`;
        }
      }

      greetingPrompt = `Greet ${userContext.auth.x_name} with "Good ${timeOfDay}, ${userContext.auth.x_name}." Then say you can brief them on global trends${circleContext}. End with "What sounds good?" Keep it concise and natural.`;
    } else {
      greetingPrompt = `Greet the caller with "Good ${timeOfDay}." Introduce yourself briefly as their AI news anchor and ask if they'd like to hear about global trends or a specific topic. Keep it concise.`;
    }

    const conversationItem = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: greetingPrompt
          }
        ]
      }
    };
    logWebSocketEvent(callId, 'SEND', conversationItem);
    xaiWs.send(JSON.stringify(conversationItem));

    const responseCreate = { type: 'response.create' };
    logWebSocketEvent(callId, 'SEND', responseCreate);
    xaiWs.send(JSON.stringify(responseCreate));

    log.app.info(`[${callId}] 📰 AI Newscaster greeting requested (${timeOfDay})`);
  };

  // Check if Twilio was ready before trySendGreeting was defined
  if (pendingTwilioReady) {
    log.app.info(`[${callId}] Twilio was already ready, checking if we can send greeting...`);
    trySendGreeting();
  }

  // Handle messages from x.ai WebSocket
  xaiWs.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      // Log to debug file (will filter out audio chunks)
      logWebSocketEvent(callId, 'RECV', message);

      // Log all events to console except raw audio chunks
      if (message.type !== 'response.output_audio.delta' && message.type !== 'input_audio_buffer.append') {
        log.app.info(`[${callId}] 📩 ${message.type}`);
      }

      if (message.type === 'response.output_audio.delta' && message.delta) {
        // Bot is speaking - sending audio to Twilio (PCMU format)
        // Only send if Twilio streamSid is set (start event received)
        if (!tw.streamSid) {
          log.app.warn(`[${callId}] ⚠️ Cannot send audio to Twilio - streamSid not set yet`);
          return;
        }
        // XAI sends μ-law directly (native PCMU support), pass through without conversion
        tw.send({
          event: "media",
          media: { payload: message.delta },  // Pass through base64 μ-law directly
          streamSid: tw.streamSid,
        });
      } else if (message.type === 'response.output_audio_transcript.delta') {
        // Log bot's speech transcript and accumulate for storage
        log.app.info(`[${callId}] 🤖 Bot: "${message.delta}"`);

        // Accumulate bot transcript chunks
        const currentBuffer = botTranscriptBuffers.get(callId) || '';
        botTranscriptBuffers.set(callId, currentBuffer + (message.delta || ''));
      } else if (message.type === 'response.created') {
        log.app.info(`[${callId}] 🤖 BOT STARTED SPEAKING`);
      } else if (message.type === 'response.function_call_arguments.delta') {
        // Accumulate function call arguments as they stream in
        functionCallState.arguments += message.delta || '';
      } else if (message.type === 'response.function_call_arguments.done') {
        // Function call request is complete - store the details
        functionCallState.callId = message.call_id;
        functionCallState.name = message.name;
        log.app.info(`[${callId}] 🔧 Function call requested: ${message.name}`);
        log.app.info(`[${callId}]    Arguments: ${functionCallState.arguments}`);
      } else if (message.type === 'response.done') {
        // Check if there's a pending function call to execute
        if (functionCallState.name && functionCallState.callId) {
          const toolName = functionCallState.name as ToolName;
          let args = {};

          try {
            args = JSON.parse(functionCallState.arguments || '{}');
          } catch (e) {
            log.app.error(`[${callId}] Failed to parse function args: ${functionCallState.arguments}`);
            args = {};
          }

          log.app.info(`[${callId}] 🔧 Executing tool: ${toolName}`);

          // Execute the tool (async)
          executeToolCall(callId, toolName, args).then((result) => {
            log.app.info(`[${callId}] 📨 Sending tool result back to XAI`);

            // Send result back to XAI
            const functionResult = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: functionCallState.callId,
                output: result
              }
            };
            logWebSocketEvent(callId, 'SEND', functionResult);
            xaiWs.send(JSON.stringify(functionResult));

            // Request model to continue with the result
            const responseCreate = { type: 'response.create' };
            logWebSocketEvent(callId, 'SEND', responseCreate);
            xaiWs.send(JSON.stringify(responseCreate));

            // Reset state
            functionCallState.callId = null;
            functionCallState.name = null;
            functionCallState.arguments = '';
          }).catch((error) => {
            log.app.error(`[${callId}] ❌ Tool execution failed:`, error);

            // Send error result back
            const errorResult = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: functionCallState.callId,
                output: JSON.stringify({ error: `Tool failed: ${error}` })
              }
            };
            xaiWs.send(JSON.stringify(errorResult));
            xaiWs.send(JSON.stringify({ type: 'response.create' }));

            // Reset state
            functionCallState.callId = null;
            functionCallState.name = null;
            functionCallState.arguments = '';
          });
        } else {
          log.app.info(`[${callId}] 🤖 BOT FINISHED SPEAKING - Listening for user...`);
        }
      } else if (message.type === 'session.updated') {
        sessionReady = true;  // Now safe to send 8kHz audio
        log.app.info(`[${callId}] ⚙️ Session updated - PCMU format confirmed, audio streaming enabled`);

        // Try to send greeting (will only work if Twilio streamSid is also ready)
        trySendGreeting();

        // If Twilio isn't ready yet, poll briefly to catch it
        if (!greetingSent) {
          log.app.info(`[${callId}] ⏳ Waiting for Twilio streamSid before sending greeting...`);
          const pollInterval = setInterval(() => {
            if (tw.streamSid) {
              clearInterval(pollInterval);
              trySendGreeting();
            }
          }, 50);
          // Timeout after 3 seconds
          setTimeout(() => clearInterval(pollInterval), 3000);
        }
      } else if (message.type === 'conversation.created') {
        log.app.info(`[${callId}] 📞 Call connected - Using SERVER-SIDE VAD`);
        log.app.info(`[${callId}] 🆔 x.ai conversation_id: ${message.conversation?.id || 'unknown'}`);

        // Send session configuration with tools
        const sessionConfig = {
          type: 'session.update',
          session: {
            instructions: bot.instructions,
            voice: bot.voice || 'rex',
            audio: {
              input: {
                format: {
                  type: 'audio/pcmu',  // Native μ-law (PCMU) support
                },
              },
              output: {
                format: {
                  type: 'audio/pcmu',  // Native μ-law (PCMU) support
                },
              },
            },
            turn_detection: {
              type: 'server_vad',
            },
            // Add tools for news fetching
            tools: bot.tools || [],
            tool_choice: 'auto',
          }
        };
        logWebSocketEvent(callId, 'SEND', sessionConfig);
        xaiWs.send(JSON.stringify(sessionConfig));

        log.app.info(`[${callId}] Server-side VAD configured with ${bot.tools?.length || 0} tools, waiting for session.updated...`);
      } else if (message.type === 'input_audio_buffer.speech_started') {
        log.app.info(`[${callId}] 🎤 USER STARTED SPEAKING (server VAD)`);
        log.app.info(`[${callId}]    VAD triggered at audio_start_ms: ${message.audio_start_ms}`);

        // Clear Twilio's audio buffer (interrupt bot if speaking)
        tw.send({ event: "clear", streamSid: tw.streamSid! });

      } else if (message.type === 'input_audio_buffer.speech_stopped') {
        log.app.info(`[${callId}] 🛑 USER STOPPED SPEAKING (server VAD detected ${message.audio_end_ms || message.audio_start_ms}ms of audio)`);
        log.app.info(`[${callId}] 🔄 Server will automatically process speech...`);

      } else if (message.type === 'input_audio_buffer.committed') {
        log.app.info(`[${callId}] Audio buffer committed (${message.item_id || 'no item_id'})`);
      } else if (message.type === 'conversation.item.input_audio_transcription.completed') {
        // Log what the user said (transcribed speech)
        const transcript = message.transcript || '';
        log.app.info(`[${callId}] 👤 User said: "${transcript}"`);

        // Send user transcript to Django
        const conversationId = callConversationIds.get(callId);
        if (conversationId && transcript.trim()) {
          sendTranscriptMessage(callId, conversationId, 'user', transcript);
        }
      } if (message.type === 'ping') {
        // Silently handle pings
      } else if (message.type === 'error') {
        log.app.error(`[${callId}] ❌ x.ai API ERROR:`);
        log.app.error(`[${callId}]    Type: ${message.error?.type || 'unknown'}`);
        log.app.error(`[${callId}]    Code: ${message.error?.code || 'unknown'}`);
        log.app.error(`[${callId}]    Message: ${message.error?.message || JSON.stringify(message)}`);
        log.app.error(`[${callId}]    Event ID: ${message.event_id || 'none'}`);
      } else if (message.type === 'conversation.item.added') {
        // Silently handle - conversation item added (same as created)
      } else if (message.type === 'response.output_item.added') {
        // Silently handle - output item added to response
      } else if (message.type === 'response.output_item.done') {
        // Silently handle - output item completed
      } else if (message.type === 'response.content_part.added') {
        // Silently handle - content part added
      } else if (message.type === 'response.content_part.done') {
        // Silently handle - content part completed
      } else if (message.type === 'response.output_audio.done') {
        // Silently handle - audio generation completed
      } else if (message.type === 'response.output_audio_transcript.done') {
        // Bot finished speaking - send accumulated transcript to Django
        const conversationId = callConversationIds.get(callId);
        const fullTranscript = botTranscriptBuffers.get(callId) || '';

        if (conversationId && fullTranscript.trim()) {
          sendTranscriptMessage(callId, conversationId, 'assistant', fullTranscript);
        }

        // Clear the buffer for next response
        botTranscriptBuffers.delete(callId);
      } else {
        // Log unknown events for debugging
        log.app.debug(`[${callId}] ❓ Unknown: ${message.type}`);
      }
    } catch (error) {
      log.app.error(`[${callId}] Error processing message from x.ai:`, error);
    }
  });

  // Send human speech to x.ai
  let audioPacketCount = 0;
  tw.on("media", (msg) => {
    try {
      audioPacketCount++;

      if (msg.media.track === 'inbound') {
        // Don't send audio until session is configured for 8kHz PCMU
        // XAI defaults to 24kHz - sending 8kHz before session.updated causes frame rate error
        if (!sessionReady) {
          if (audioPacketCount === 1) {
            log.app.info(`[${callId}] ⏳ Waiting for session.updated before streaming audio...`);
          }
          return;
        }

        // XAI accepts μ-law (PCMU) natively - pass through without conversion
        const mulawBase64 = msg.media.payload;

        // Log periodically
        if (audioPacketCount === 1 || audioPacketCount % 100 === 0) {
          log.app.info(`[${callId}] 🎚️  Audio packet #${audioPacketCount} (server-side VAD active)`);
        }

        // Send μ-law audio directly to XAI (no conversion or buffering needed)
        const audioMessage = {
          type: "input_audio_buffer.append",
          audio: mulawBase64
        };

        // Check WebSocket state before sending
        if (xaiWs.readyState !== 1) {
          log.app.error(`[${callId}] ❌ Cannot send audio! x.ai WebSocket not connected (state: ${xaiWs.readyState})`);
          return;
        }

        // Note: Audio chunks are not logged to debug file (filtered in logWebSocketEvent)
        xaiWs.send(JSON.stringify(audioMessage));
      }
    } catch (error) {
      log.app.error(`[${callId}] Error processing audio from Twilio:`, error);
    }
  });

  // Handle x.ai WebSocket errors
  xaiWs.on('error', (error: any) => {
    log.app.error(`[${callId}] ❌ x.ai WebSocket ERROR:`, error);
  });

  xaiWs.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason.toString() || 'No reason provided';
    log.app.error(`[${callId}] ❌ x.ai WebSocket CLOSED - Code: ${code}, Reason: ${reasonStr}`);
  });

  // Handle Twilio WebSocket errors
  ws.on("error", (error) => {
    log.app.error(`[${callId}] Twilio WebSocket error:`, error);
  });

  // Handle Twilio WebSocket close
  ws.on("close", async () => {
    log.app.info(`[${callId}] Twilio WebSocket closed, disconnecting x.ai`);
    xaiWs.close();

    // End conversation in Django
    const conversationId = callConversationIds.get(callId);
    if (conversationId) {
      await endConversation(callId, conversationId);
    }

    // Clean up call context and all mappings
    cleanupCallContext(callId);
    callPhoneNumbers.delete(callId);
    callConversationIds.delete(callId);
    botTranscriptBuffers.delete(callId);
    log.app.info(`[${callId}] Call context cleaned up`);
  });
});

/****************************************************
 Start Server
****************************************************/
const port = process.env.PORT || "3000";
app.listen(port, () => {
  log.app.info(`server running on http://localhost:${port}`);
});
