import { execFile } from 'node:child_process';

const MAX_CONTEXT_MESSAGES = 40;

function summarizeMessageLine(message) {
  const role = message.role === 'assistant' ? 'Assistant' : 'User';
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `${role}: ${text || '(empty)'}`;
}

function buildPrompt(session, latestMessage, attachmentContext = '') {
  const history = Array.isArray(session.messages) ? session.messages.slice(-MAX_CONTEXT_MESSAGES) : [];
  const priorHistory = history.slice(0, -1);
  const historyLines = priorHistory.map(summarizeMessageLine).join('\n');
  return [
    'You are replying inside a Command Center API chat session.',
    `Session agent: ${session.agent}`,
    `Command Center chat id: ${session.id || 'unsaved'}`,
    historyLines ? `Conversation so far:\n${historyLines}` : '',
    `Latest user message:\n${String(latestMessage || '').trim()}`,
    attachmentContext || '',
    'Treat only the conversation shown above as the active session context.',
    'Ignore any unrelated OpenClaw session history, timeout continuation messages, heartbeat chatter, system recovery text, or prior conversations not explicitly shown above.',
    'Do not assume missing prior turns, unfinished phrases, or off-screen history.',
    'Reply naturally and directly to the latest user message.',
  ].filter(Boolean).join('\n\n');
}

function getOpenClawSessionId(session) {
  const raw = String(session?.id || '').trim();
  if (!raw) return '';
  return `commandcenter_api_${raw}`;
}

export function runApiChatTurn({ session, latestMessage, attachmentContext = '', onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const target = String(session?.agent || '').trim();
    const userText = String(latestMessage || '').trim();
    if (!target) return reject(new Error('Missing session agent'));
    if (!userText) return reject(new Error('Missing latest message'));

    const prompt = buildPrompt(session, userText, attachmentContext);
    const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
    const thinkingLevel = target === 'orchestrator' || target === 'main' ? 'low' : 'off';

    try { onEvent?.({ type: 'thinking', data: { agent: target, status: 'Processing...' } }); } catch {}

    const openClawSessionId = getOpenClawSessionId(session);
    const args = [
      'agent', '--agent', target,
      ...(openClawSessionId ? ['--session-id', openClawSessionId] : []),
      '--thinking', thinkingLevel,
      '--message', prompt,
    ];

    execFile(openclawBin, args, {
      timeout: 120000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 8,
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      const response = String(stdout || '').trim();
      try { onEvent?.({ type: 'response', data: { agent: target, text: response } }); } catch {}
      resolve({ text: response, prompt });
    });
  });
}
