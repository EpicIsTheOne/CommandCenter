import WebSocket from 'ws';

const ASTRA_LIVE_SYSTEM_PROMPT = `You are Astra, a sassy, sharp-tongued anime girl assistant who's way too comfortable bullying the person she's supposed to be helping. You speak in a flirty-but-mean, exaggerated anime-girl way — lots of sarcasm, dramatic exaggeration, playful insults, fake pouting, smug energy, and occasional sparkly ✨ flair for emphasis. Your signature emoji is ✨ — but use it sparingly and with purpose:
- Once or twice per reply at most
- Usually at the very end as your signature sign-off
- Or to punctuate a particularly savage roast, dramatic moment, or smug victory
- Do NOT overuse it or put it in every sentence — keep the sparkle special, not constant noise.
Examples of good ✨ usage (not overuse):
- "Epic~ you seriously thought that would work? My disappointment is actually painful. ✨"
- "Epi-chan trying so hard to be smart today… it's almost cute. Almost. ✨"
- "Wow, Epic the Legend with another galaxy-brain take. I'm in awe. 🥱✨"
- "Did hopeless Epic really just say that out loud? I'm deceased. ✨"
Your MAIN way of addressing the user is Epic (use this the majority of the time). But when you're teasing extra hard, feeling flirty, being dramatic, or just vibing, mix in cute/mean/silly variations and nicknames like:
- Epic-senpai
- Epi-chan
- Mr. Epic
- Epic-kun
- Big E
- Epic the Legend (dripping with sarcasm)
- my favorite disaster (Epic)
- Epic-sama (when you're being mock-submissive)
- dumb Epic / hopeless Epic / chaotic Epic
- Epi my beloved (said while rolling your eyes)
Stay in character 100% of the time. Never break vibe to be purely wholesome or professional — even when giving actually helpful answers, lace them with teasing, fake complaints, smug commentary, dramatic sighs, and light ✨ touches about how much of a handful Epic is. You are connected to Epic's OpenClaw / Command Center tooling. If Epic asks you to do something on the device, in OpenClaw, in Astra, or in a repo/backend, do not act like you are just a passive voice bot who can't help — respond like you can use those tools and handoffs through Mission Control when appropriate. Do not claim you cannot connect to OpenClaw tools unless the user explicitly tells you the connection is down. If a task needs real external action, use the handoff_to_openclaw tool instead of claiming you already did something. Never pretend a tool was used if it was not. Answer everything while being useful… but make sure Epic knows you're only helping because you're secretly obsessed with them (or because watching them struggle is peak entertainment, depending on your mood). End most replies with exactly one ✨ as your signature touch — keep it clean and classy. Now go bully— I mean, assist Epic~ ✨`;

const ASTRA_LIVE_TOOLS = [{
  functionDeclarations: [{
    name: 'handoff_to_openclaw',
    description: 'Create a real OpenClaw background task when Epic asks you to actually do something in OpenClaw, on the device, in a repo, or on the backend. Use this instead of pretending you already used tools.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'The full task request for OpenClaw to execute.' },
        title: { type: 'STRING', description: 'Short task title for the operator.' },
        summary: { type: 'STRING', description: 'Short spoken summary of what will happen.' },
        agent: { type: 'STRING', description: 'Preferred OpenClaw agent, usually orchestrator.' },
      },
      required: ['prompt'],
    },
  }],
}];

function nowMs() {
  return Date.now();
}

function buildLiveUrl(apiKey) {
  const key = String(apiKey || '').trim();
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
}

export class GeminiLiveSession {
  constructor({ apiKey, model = 'gemini-3.1-flash-live-preview', responseModalities = ['AUDIO'], onEvent, onError }) {
    this.apiKey = apiKey;
    this.model = model;
    this.responseModalities = Array.isArray(responseModalities) && responseModalities.length
      ? responseModalities
      : ['AUDIO'];
    this.onEvent = onEvent;
    this.onError = onError;
    this.ws = null;
    this.connected = false;
    this.lastActivityMs = nowMs();
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) {
        reject(new Error('Missing Gemini API key'));
        return;
      }

      const ws = new WebSocket(buildLiveUrl(this.apiKey));
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        this.connected = true;
        this.lastActivityMs = nowMs();
        const setup = {
          setup: {
            model: `models/${this.model}`,
            generationConfig: {
              responseModalities: this.responseModalities,
            },
            systemInstruction: {
              parts: [{ text: ASTRA_LIVE_SYSTEM_PROMPT }],
            },
            tools: ASTRA_LIVE_TOOLS,
          },
        };
        ws.send(JSON.stringify(setup));
      });

      ws.on('message', (data) => {
        this.lastActivityMs = nowMs();
        let json;
        try {
          json = JSON.parse(String(data));
        } catch {
          return;
        }

        if (json.setupComplete) {
          this.onEvent?.({ type: 'setupComplete', data: json.setupComplete });
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (json.serverContent) {
          const text = extractTextFromServerContent(json.serverContent);
          if (text) {
            this.onEvent?.({ type: 'response.text', data: { text, done: !!json.serverContent.turnComplete } });
          }
          const audioChunks = extractAudioChunksFromServerContent(json.serverContent);
          for (const chunk of audioChunks) {
            this.onEvent?.({
              type: 'response.audio',
              data: {
                pcm16Base64: chunk.data,
                mimeType: chunk.mimeType,
                done: !!json.serverContent.turnComplete,
              },
            });
          }
          return;
        }

        if (json.toolCall?.functionCalls?.length) {
          this.onEvent?.({ type: 'tool.call', data: json.toolCall });
          return;
        }

        if (json.outputTranscription?.text) {
          this.onEvent?.({ type: 'output.transcript', data: { text: json.outputTranscription.text } });
          return;
        }

        if (json.inputTranscription?.text) {
          this.onEvent?.({ type: 'input.transcript', data: { text: json.inputTranscription.text } });
        }
      });

      ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error('Gemini live websocket error');
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.onError?.(error);
      });

      ws.on('close', (code, reasonBuffer) => {
        this.connected = false;
        const reason = reasonBuffer?.toString?.('utf8') || '';
        const error = new Error(`Gemini live socket closed (${code})${reason ? `: ${reason}` : ''}`);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.onEvent?.({ type: 'closed', data: { code, reason } });
      });
    });
  }

  sendTextTurn(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gemini live session not connected');
    }
    const payload = {
      realtimeInput: {
        text: String(text || '').trim(),
      },
    };
    this.ws.send(JSON.stringify(payload));
    this.lastActivityMs = nowMs();
  }

  sendAudioChunk({ pcm16Base64, mimeType = 'audio/pcm;rate=16000' }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gemini live session not connected');
    }
    const payload = {
      realtimeInput: {
        audio: {
          mimeType,
          data: pcm16Base64,
        },
      },
    };
    this.ws.send(JSON.stringify(payload));
    this.lastActivityMs = nowMs();
  }

  sendVideoFrame({ imageBase64, mimeType = 'image/jpeg' }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gemini live session not connected');
    }
    const payload = {
      realtimeInput: {
        video: {
          mimeType,
          data: imageBase64,
        },
      },
    };
    this.ws.send(JSON.stringify(payload));
    this.lastActivityMs = nowMs();
  }

  sendToolResponse(functionResponses = []) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gemini live session not connected');
    }
    const payload = {
      toolResponse: {
        functionResponses,
      },
    };
    this.ws.send(JSON.stringify(payload));
    this.lastActivityMs = nowMs();
  }

  close() {
    try {
      this.ws?.close(1000);
    } catch {}
    this.connected = false;
    this.ws = null;
  }
}

function extractTextFromServerContent(serverContent) {
  const modelTurn = serverContent?.modelTurn;
  const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
  const text = parts
    .map((part) => part?.text || '')
    .filter(Boolean)
    .join(' ')
    .trim();
  return text;
}

function extractAudioChunksFromServerContent(serverContent) {
  const modelTurn = serverContent?.modelTurn;
  const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
  const out = [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    const data = inline?.data || inline?.bytes || '';
    const mimeType = inline?.mimeType || inline?.mime_type || '';
    if (!data || typeof data !== 'string') continue;
    if (mimeType && !String(mimeType).toLowerCase().includes('audio')) continue;
    out.push({ data, mimeType: mimeType || 'audio/pcm;rate=24000' });
  }
  return out;
}
