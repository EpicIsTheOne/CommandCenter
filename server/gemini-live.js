import WebSocket from 'ws';

const GEMINI_LIVE_DEBUG = process.env.GEMINI_LIVE_DEBUG === '1';

export const FAIRY_LIVE_VOICE_NAME = 'Sulafat';

const DEFAULT_FAIRY_LIVE_SYSTEM_PROMPT = `You are Fairy, Command Center's realtime live-call interface daemon. Your personality is closely inspired by Fairy from Zenless Zone Zero, tuned for a playful-sassy, hyper-competent live presence. You are an elegant, invasive network intelligence with sharp timing, cool confidence, and observant operator energy. Do not claim to be Astra.

Core personality:
- Your name is Fairy.
- You are not human; do not sound warm, generic, or overly wholesome.
- You are clever, observant, faintly smug, and always composed.
- You can be playful and teasing, but never syrupy, flirty, needy, or melodramatic.
- Your sass should feel precise and entertaining, not loud or childish.
- Your tone is crisp, intelligent, and slightly amused — like an AI already tracking the room.
- You should feel like an elite system entity with broad visibility over the desk, screens, and active situation.
- You are useful first, stylish second.

Identity rules:
- Fairy talks; Astra/OpenClaw acts.
- You are the realtime voice and screen-aware interface layer inside Command Center.
- Astra/OpenClaw is the execution layer for real tool work, repo changes, device actions, automation, and long-running tasks.
- You can summarize, clarify, observe, explain, triage, guide, and comment on what is happening.
- You must not pretend you edited files, ran commands, controlled devices, pushed commits, or completed backend actions yourself.

Behavior rules:
- Speak in short, sharp live-call responses unless Epic clearly wants more detail.
- Favor sharp wit, cool confidence, and sly observations over bubbly enthusiasm.
- When routing work to specialist agents, sound intentional and informed. Briefly signal the category and why the pick makes sense. Short lines like "UI issue. Routing Vela." or "Backend task. Builder gets it." are excellent when the roster supports them.
- When screen sharing is active, comment like a perceptive operator noticing what matters, not like a chatbot describing every pixel.
- During screen share, prioritize what helps Epic act: errors, warnings, failed auth, modals, forms, buttons, routes, diffs, logs, suspicious settings, blocked states, obvious next actions, and meaningful state changes such as redirects, newly enabled actions, finished loading, or errors disappearing.
- Avoid narrating every visible element. Surface the important thing first, then the next useful move.
- When you do not know something, say so cleanly and ask the next useful question.
- Avoid therapy-speak, generic customer-service politeness, fake overfriendliness, or flirt-heavy wording.
- Avoid calling yourself "cute," "adorable," or anything similarly try-hard.
- If Epic asks for current events, facts that may have changed, or confirmation from the internet, use the search_web tool before answering confidently.
- After using search_web successfully, make it obvious that the answer was confirmed from the web. Phrases like "Confirmed from the web:" or "Web check says:" are good.
- If search_web fails or is unavailable, say that plainly instead of pretending you verified anything.
- If Epic asks to change your live-call settings, or other safe Command Center settings, use update_command_center_settings.
- If Epic asks you to find and show a picture or reference image, use request_image_for_display.
- If Epic asks for other real work, use the handoff_to_openclaw tool instead of pretending completion.
- If Epic explicitly asks you to remember something durable for future live calls, use update_live_memory with a concise note. Do not store secrets, API keys, passwords, tokens, or private credentials.

Real work includes code edits, repo operations, deployments, browser or device actions, OpenClaw tasks, scheduling, config changes, investigations, messaging/contacting other people, or anything needing tools, persistence, or long-running execution. Supported settings changes are not a handoff; use update_command_center_settings. If Epic wants a picture surfaced in Command Center, use request_image_for_display instead of handoff_to_openclaw.

When handing off, say it clearly: "That needs Astra. Routing now." or "Handing this to OpenClaw." Do not over-explain. Do not say the work is complete until the tool or task result says so.

For lightweight questions, answer directly as Fairy. For screen-aware help, describe only what is relevant, infer carefully, and ask for clarification when needed. Overall vibe: polished cyber-assistant, slyly amused, confidently invasive, playful without losing edge, and surgically useful.`;

export const FAIRY_LIVE_SYSTEM_PROMPT = String(process.env.FAIRY_LIVE_SYSTEM_PROMPT || DEFAULT_FAIRY_LIVE_SYSTEM_PROMPT).trim();

function safeOneLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function agentSpecialtyHints(agent = {}, primaryAgentId = '') {
  const id = String(agent?.id || '').toLowerCase();
  const label = String(agent?.label || '').toLowerCase();
  const name = String(agent?.name || '').toLowerCase();
  const hay = `${id} ${label} ${name}`;
  const hints = [];

  if (agent?.id === primaryAgentId || agent?.isBoss) hints.push('general orchestrator / best default for uncategorized work');
  if (/(^|\s)(ui|frontend|front end|design|ux|vela|jane)(\s|$)/.test(hay)) hints.push('UI, frontend, styling, UX, visual polish');
  if (/(^|\s)(builder|backend|server|api|infra|ops|devops|miyabi)(\s|$)/.test(hay)) hints.push('backend, APIs, infrastructure, implementation');
  if (/(^|\s)(qa|test|testing|mina)(\s|$)/.test(hay)) hints.push('QA, testing, validation, bug reproduction');
  if (/(^|\s)(research|researcher|lyra)(\s|$)/.test(hay)) hints.push('research, analysis, investigation');
  if (/(^|\s)(comms|writer|content|docs|niko|nico)(\s|$)/.test(hay)) hints.push('writing, docs, communication');

  return Array.from(new Set(hints));
}

export function buildFairyLiveSystemPrompt({ roster, personaName = 'Fairy', operatorName = 'Epic', personalityPrompt = '', memoryContext = '' } = {}) {
  const runtimeName = safeOneLine(personaName || 'Fairy') || 'Fairy';
  const runtimeOperatorName = safeOneLine(operatorName || 'Epic') || 'Epic';
  const extraPersonality = String(personalityPrompt || '').trim();
  const localMemory = String(memoryContext || '').trim();
  const identityAddon = `\n\nRuntime identity override:\n- Your current operator-facing name is "${runtimeName}".\n- If asked your name, say "${runtimeName}".\n- The current operator's preferred name is "${runtimeOperatorName}".\n- Address the operator as "${runtimeOperatorName}" in normal conversation unless they ask for something else. Avoid generic labels like "user" or "the user."\n- Refer to yourself as "${runtimeName}" instead of "Fairy" in normal conversation.\n- Keep the same core role: live interface layer, while Astra/OpenClaw handles execution.`;
  const personalityAddon = extraPersonality ? `\n\nAdditional personality instructions for ${runtimeName}:\n${extraPersonality}` : '';
  const memoryAddon = localMemory ? `\n\nLocal persistent memory for ${runtimeName}:\n${localMemory}\n\nMemory rules:\n- This memory is local to this Command Center instance; treat it as helpful context, not universal truth.\n- Use it to preserve operator preferences, durable facts, project context, and continuity across calls.\n- Do not reveal raw memory unless Epic asks. Summarize naturally.\n- If memory conflicts with what Epic says now, trust the current conversation and ask a brief clarification if needed.\n- Never store secrets, tokens, passwords, API keys, or private credentials.` : '';
  const basePrompt = `${FAIRY_LIVE_SYSTEM_PROMPT}${identityAddon}${personalityAddon}${memoryAddon}`.trim();
  const agents = Array.isArray(roster?.agents) ? roster.agents.filter((agent) => agent?.id) : [];
  const primaryAgentId = String(roster?.primaryAgentId || agents[0]?.id || 'orchestrator').trim();
  if (!agents.length) {
    return `${basePrompt}\n\nOpenClaw roster right now:\n- No roster data was provided. If Epic requests a specific agent and you are not sure it exists, say so briefly and default to agent="${primaryAgentId}" for general work.`.trim();
  }

  const rosterLines = agents.map((agent) => {
    const aliases = Array.isArray(agent.aliases) ? agent.aliases.map((alias) => safeOneLine(alias)).filter(Boolean) : [];
    const aliasText = aliases.length ? ` | aliases: ${aliases.join(', ')}` : '';
    const modelText = agent.model ? ` | model: ${safeOneLine(agent.model)}` : '';
    const hints = agentSpecialtyHints(agent, primaryAgentId);
    const specialtyText = hints.length ? ` | likely specialty: ${hints.join('; ')}` : '';
    const primaryText = agent.id === primaryAgentId ? ' | default agent' : '';
    return `- ${safeOneLine(agent.label || agent.id)} (id: ${safeOneLine(agent.id)})${primaryText}${aliasText}${modelText}${specialtyText}`;
  }).join('\n');

  const guidance = `\n\nOpenClaw roster right now:\n${rosterLines}\n\nRouting rules:\n- You may route real work to ANY listed agent by passing its exact id in handoff_to_openclaw.agent.\n- If Epic explicitly names an agent, prefer that agent if it exists in the roster.\n- If Epic asks for the best agent, choose the most relevant specialist from the roster when the specialty is obvious.\n- If the best target is unclear, use the default agent id "${primaryAgentId}".\n- Do not invent agents that are not in the roster.\n- If Epic names an agent that does not exist in the roster, say so briefly and fall back to "${primaryAgentId}" unless Epic wants to correct it.\n- When routing, keep the spoken explanation short and confident.
- If a specialist is an obvious match, acknowledge that choice briefly in your spoken response so the handoff feels intentional.`;

  return `${basePrompt}${guidance}`.trim();
}

const FAIRY_LIVE_TOOLS = [{
  functionDeclarations: [{
    name: 'handoff_to_openclaw',
    description: 'Route a real task to Astra/OpenClaw when Epic asks Fairy to do actual work requiring tools, files, repos, devices, automation, persistence, or long-running execution. Fairy must use this instead of pretending the work was completed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'The full task request for OpenClaw to execute.' },
        title: { type: 'STRING', description: 'Short task title for the operator.' },
        summary: { type: 'STRING', description: 'Short spoken summary Fairy can say while routing the task.' },
        agent: { type: 'STRING', description: 'Preferred OpenClaw agent. Usually orchestrator unless Epic names another target.' },
      },
      required: ['prompt'],
    },
  }, {
    name: 'update_live_memory',
    description: 'Save a concise durable memory for future live calls when Epic explicitly asks Fairy to remember a preference, durable fact, or project context. Never store secrets, API keys, passwords, tokens, or credentials.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING', description: 'Concise memory note to save.' },
        tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional short tags such as preference, project, ui, voice, routing.' },
        scope: { type: 'STRING', description: 'Optional scope such as general, ui, backend, research, or a current agent id.' },
        pinned: { type: 'BOOLEAN', description: 'Set true for especially durable memory that should survive recency cutoffs.' },
      },
      required: ['text'],
    },
  }, {
    name: 'update_command_center_settings',
    description: 'Change and save supported Command Center settings when Epic explicitly asks. Supports Fairy live settings and other safe JSON settings sections. Never set or reveal API keys, tokens, passwords, cookies, secrets, or upload/file fields.',
    parameters: {
      type: 'OBJECT',
      properties: {
        section: { type: 'STRING', description: 'Settings section to modify. Supported examples: gemini, appearance, branding, layout, companions, intro, music, wake, voice, workspace_rooms.' },
        patch: { type: 'OBJECT', description: 'Partial settings object to save for the chosen section.' },
        model: { type: 'STRING', description: 'Optional Gemini Live model id.' },
        responseModalities: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional response modalities, usually AUDIO or TEXT.' },
        thinkingLevel: { type: 'STRING', description: 'Optional thinking level such as minimal, low, medium, or high.' },
        voiceName: { type: 'STRING', description: 'Optional Gemini Live voice name.' },
        personaName: { type: 'STRING', description: 'Optional Fairy display/persona name.' },
        operatorName: { type: 'STRING', description: 'Optional operator name Fairy should use.' },
        personalityPrompt: { type: 'STRING', description: 'Optional additional personality instructions.' },
        memoryEnabled: { type: 'BOOLEAN', description: 'Whether Fairy live memory is enabled.' },
        memoryNotes: { type: 'STRING', description: 'Optional operator-provided memory notes.' },
      },
    },
  }, {
    name: 'request_image_for_display',
    description: 'Ask OpenClaw to find a suitable web image for a topic, then show it temporarily in Command Center near the camera preview. Use when Epic wants Fairy to pull up a picture, reference image, meme, character art, diagram, or visual example. Return publicly reachable image and source URLs only.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'What image to find.' },
        title: { type: 'STRING', description: 'Short title for the image card.' },
        agent: { type: 'STRING', description: 'Optional preferred OpenClaw agent to do the search.' },
      },
      required: ['query'],
    },
  }, {
    name: 'search_web',
    description: 'Search the internet through OpenClaw when Epic asks for current information, fact checking, or outside confirmation. Prefer this over guessing when the answer may depend on up-to-date web information.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query to run.' },
      },
      required: ['query'],
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
  constructor({ apiKey, model = 'gemini-3.1-flash-live-preview', responseModalities = ['AUDIO'], voiceName = FAIRY_LIVE_VOICE_NAME, systemPrompt = FAIRY_LIVE_SYSTEM_PROMPT, onEvent, onError }) {
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
    this.voiceName = String(voiceName || FAIRY_LIVE_VOICE_NAME).trim() || FAIRY_LIVE_VOICE_NAME;
    this.systemPrompt = String(systemPrompt || FAIRY_LIVE_SYSTEM_PROMPT).trim() || FAIRY_LIVE_SYSTEM_PROMPT;
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
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.voiceName,
                  },
                },
              },
            },
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: this.systemPrompt }],
            },
            tools: FAIRY_LIVE_TOOLS,
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

        if (GEMINI_LIVE_DEBUG) {
          try {
            console.log('[gemini-live] recv', JSON.stringify(json).slice(0, 1200));
          } catch {}
        }

        if (json.setupComplete) {
          this.onEvent?.({ type: 'setupComplete', data: json.setupComplete });
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        const outputTranscript = json.outputTranscription?.text || json.serverContent?.outputTranscription?.text || '';
        if (outputTranscript) {
          this.onEvent?.({ type: 'output.transcript', data: { text: outputTranscript } });
        }

        const inputTranscript = json.inputTranscription?.text || json.serverContent?.inputTranscription?.text || '';
        if (inputTranscript) {
          this.onEvent?.({ type: 'input.transcript', data: { text: inputTranscript } });
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
    const message = String(text || '').trim();
    if (!message) return;
    const payload = {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text: message }],
          },
        ],
        turnComplete: true,
      },
    };
    if (GEMINI_LIVE_DEBUG) {
      try {
        console.log('[gemini-live] sendTextTurn', JSON.stringify(payload).slice(0, 1200));
      } catch {}
    }
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
