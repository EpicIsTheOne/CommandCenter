import { execFile } from 'node:child_process';

const MAX_CONTEXT_MESSAGES = 40;

function summarizeMessageLine(message) {
  const role = message.role === 'assistant' ? 'Assistant' : 'User';
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `${role}: ${text || '(empty)'}`;
}

function buildPrompt(session, latestMessage, attachmentContext = '') {
  const history = Array.isArray(session.messages) ? session.messages.slice(-MAX_CONTEXT_MESSAGES) : [];
  const historyLines = history.map(summarizeMessageLine).join('\n');
  return [
    'You are continuing an API chat session with the same user.',
    `Session agent: ${session.agent}`,
    historyLines ? `Conversation so far:\n${historyLines}` : '',
    `Latest user message:\n${String(latestMessage || '').trim()}`,
    attachmentContext || '',
    'Reply naturally and continue the same conversation.',
  ].filter(Boolean).join('\n\n');
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

    const args = [
      'agent', '--agent', target,
      '--thinking', thinkingLevel,
      '--message', prompt,
    ];

    if (session?.id) {
      args.splice(3, 0, '--session-id', String(session.id));
    }

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
