import { execFile } from 'node:child_process';
import { getHermesAgent, loadAgentRoster } from './agents.js';
import { buildAgentCommContext, listScopedAgentComms, markAgentCommsRead } from './agent-comms.js';
import relayAgentSource from './relay-agent-source.js';

const MAX_CONTEXT_MESSAGES = 40;

function summarizeMessageLine(message) {
  const role = message.role === 'assistant' ? 'Assistant' : 'User';
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `${role}: ${text || '(empty)'}`;
}

function buildPrompt(session, latestMessage, attachmentContext = '', backchannelBlock = '') {
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
    backchannelBlock || '',
    'Treat only the conversation shown above as the active session context.',
    'Ignore any unrelated OpenClaw session history, timeout continuation messages, heartbeat chatter, system recovery text, or prior conversations not explicitly shown above.',
    'Do not assume missing prior turns, unfinished phrases, or off-screen history.',
    'If attached files include extracted text, use that extracted text as primary file context.',
    'If attached files include local image or PDF paths, inspect those files directly with your available tools before answering when the user is asking about their contents.',
    'Reply naturally and directly to the latest user message.',
    'If internal backchannel notes were provided, incorporate that context naturally into your response without explicitly mentioning the backchannel system.',
  ].filter(Boolean).join('\n\n');
}

function getOpenClawSessionId(session) {
  const raw = String(session?.id || '').trim();
  if (!raw) return '';
  return `commandcenter_api_${raw}`;
}

function getHermesSessionId(session) {
  return String(session?.metadata?.hermesSessionId || '').trim();
}

function getHermesTarget(session) {
  const explicitProfile = String(session?.metadata?.hermesProfile || '').trim();
  if (explicitProfile) {
    return getHermesAgent(explicitProfile) || getHermesAgent(`hermes:${explicitProfile}`) || getHermesAgent(session?.agent || '');
  }
  return getHermesAgent(session?.agent || '', loadAgentRoster());
}

function isHermesTarget(session) {
  return !!getHermesTarget(session);
}

function getHermesBin() {
  return process.env.HERMES_BIN || 'hermes';
}

function resolveAttachmentImagePath(image) {
  return typeof image === 'string'
    ? image.trim()
    : String(image?.path || '').trim();
}

export function buildHermesArgs(prompt, session, attachmentImages = []) {
  const provider = String(process.env.HERMES_INFERENCE_PROVIDER || '').trim();
  const resolvedAgent = getHermesTarget(session);
  const model = String(process.env.HERMES_INFERENCE_MODEL || resolvedAgent?.model || process.env.HERMES_AGENT_MODEL || '').trim();
  const resumeSessionId = getHermesSessionId(session);
  const profile = String(resolvedAgent?.hermesProfile || '').trim();
  const imagePath = resolveAttachmentImagePath(attachmentImages[0]);
  return [
    ...(profile ? ['--profile', profile] : []),
    'chat',
    '-q', prompt,
    '-Q',
    '--source', 'commandcenter',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...(model ? ['--model', model] : []),
    ...(provider ? ['--provider', provider] : []),
    ...(imagePath ? ['--image', imagePath] : []),
  ];
}

export function buildOpenClawArgs(prompt, session, target, thinkingLevel) {
  const openClawSessionId = getOpenClawSessionId(session);
  return [
    'agent', '--agent', target,
    ...(openClawSessionId ? ['--session-id', openClawSessionId] : []),
    '--thinking', thinkingLevel,
    '--message', prompt,
  ];
}

function parseHermesOutput(stdout = '') {
  const raw = String(stdout || '');
  const lines = raw.split(/\r?\n/);
  let hermesSessionId = '';
  const kept = [];
  for (const line of lines) {
    const match = line.match(/^session_id:\s*(.+?)\s*$/i);
    if (match) {
      hermesSessionId = String(match[1] || '').trim();
      continue;
    }
    if (/^↻\s+Resumed session\b/i.test(line.trim())) continue;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return { text, hermesSessionId };
}

export function runApiChatTurn({ session, latestMessage, attachmentContext = '', attachmentImages = [], onEvent } = {}) {
  return new Promise(async (resolve, reject) => {
    const target = String(session?.agent || '').trim();
    const userText = String(latestMessage || '').trim();
    if (!target) return reject(new Error('Missing session agent'));
    if (!userText) return reject(new Error('Missing latest message'));

    let backchannelBlock = '';
    let injectedBackchannelIds = [];
    if (session?.metadata?.skipBackchannel !== true) {
      try {
        const backchannelMessages = await listScopedAgentComms({
          agentId: target,
          scopeType: 'chat',
          scopeId: String(session?.id || '').trim(),
          limit: 8,
          unreadOnly: true,
        });
        injectedBackchannelIds = backchannelMessages.map((message) => message.id).filter(Boolean);
        backchannelBlock = buildAgentCommContext(backchannelMessages);
      } catch {}
    }

    const prompt = buildPrompt(session, userText, attachmentContext, backchannelBlock);
    const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
    const hermesBin = getHermesBin();
    const thinkingLevel = target === 'orchestrator' || target === 'main' ? 'low' : 'off';
    const useRelay = relayAgentSource.isRelaySession(session);
    const useHermes = !useRelay && isHermesTarget(session);
    const resolvedHermesAgent = useHermes ? getHermesTarget(session) : null;

    try { onEvent?.({ type: 'thinking', data: { agent: target, status: useRelay ? 'Routing to relay...' : (useHermes ? 'Routing to Hermes...' : 'Processing...') } }); } catch {}

    if (useRelay) {
      try {
        const result = await relayAgentSource.runRelayChatTurn({ session, latestMessage: prompt, onEvent });
        if (injectedBackchannelIds.length) {
          markAgentCommsRead({ ids: injectedBackchannelIds, agentId: target }).catch(() => {});
        }
        return resolve({
          text: result.text,
          prompt,
          runtime: result.runtime || 'relay',
          providerSessionId: result.providerSessionId || '',
          sessionId: result.sessionId || '',
        });
      } catch (err) {
        return reject(err instanceof Error ? err : new Error(String(err || 'Relay chat failed')));
      }
    }

    const args = useHermes
      ? buildHermesArgs(prompt, session, attachmentImages)
      : buildOpenClawArgs(prompt, session, target, thinkingLevel);

    execFile(useHermes ? hermesBin : openclawBin, args, {
      timeout: 120000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 8,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || 'Agent run failed').trim()));
      const result = useHermes
        ? parseHermesOutput(`${String(stdout || '')}\n${String(stderr || '')}`)
        : { text: String(stdout || '').trim(), hermesSessionId: '' };
      if (injectedBackchannelIds.length) {
        markAgentCommsRead({ ids: injectedBackchannelIds, agentId: target }).catch(() => {});
      }
      try { onEvent?.({ type: 'response', data: { agent: target, text: result.text } }); } catch {}
      resolve({
        text: result.text,
        prompt,
        hermesSessionId: result.hermesSessionId,
        hermesProfile: resolvedHermesAgent?.hermesProfile || '',
        runtime: useHermes ? 'hermes' : 'openclaw',
      });
    });
  });
}
