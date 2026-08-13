export const VOICE_RUNTIME_EVENTS = Object.freeze([
  'session.started',
  'session.stopped',
  'transcript.partial',
  'transcript.final',
  'assistant.text.delta',
  'assistant.audio.delta',
  'assistant.interrupted',
  'tool.requested',
  'runtime.error',
]);

export const TASK_RUNTIME_EVENTS = Object.freeze([
  'task.started',
  'task.progress',
  'approval.requested',
  'task.blocked',
  'task.completed',
  'task.failed',
  'task.cancelled',
]);

export class VoiceRuntime {
  constructor({ provider = '', sessionId = '' } = {}) {
    this.provider = String(provider || '').trim();
    this.sessionId = String(sessionId || '').trim();
  }

  async start() { throw new Error('VoiceRuntime.start() must be implemented by a provider adapter.'); }
  async stop() { throw new Error('VoiceRuntime.stop() must be implemented by a provider adapter.'); }
  sendAudio() { throw new Error('VoiceRuntime.sendAudio() must be implemented by a provider adapter.'); }
  sendText() { throw new Error('VoiceRuntime.sendText() must be implemented by a provider adapter.'); }
  sendVisualContext() { throw new Error('VoiceRuntime.sendVisualContext() must be implemented by a provider adapter.'); }
  interrupt() { throw new Error('VoiceRuntime.interrupt() must be implemented by a provider adapter.'); }
}

export class TaskRuntimeAdapter {
  constructor({ provider = '', runtime = '' } = {}) {
    this.provider = String(provider || '').trim();
    this.runtime = String(runtime || '').trim();
  }

  async discoverCapabilities() { return []; }
  async createAttempt() { throw new Error('TaskRuntimeAdapter.createAttempt() must be implemented by a runtime adapter.'); }
  async steer() { throw new Error('TaskRuntimeAdapter.steer() is not supported by this runtime.'); }
  async cancel() { throw new Error('TaskRuntimeAdapter.cancel() must be implemented by a runtime adapter.'); }
  async retry() { throw new Error('TaskRuntimeAdapter.retry() must be implemented by a runtime adapter.'); }
}

export function describeRuntimeArchitecture() {
  return {
    voiceMediaRuntime: 'provider-neutral VoiceRuntime adapters; Gemini Live is the first implementation.',
    durableControlPlane: 'snapshot plus event journal for threads, goals, tasks, approvals, review, notifications, and recovery.',
    taskExecutionRuntime: 'normalized TaskRuntimeAdapter implementations for local OpenClaw, Hermes, and bounded relay agents.',
  };
}
