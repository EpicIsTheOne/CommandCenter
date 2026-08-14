// Direct Chat Module - text-based chat with agents + reusable file library + session switching
import * as terminal from './terminal.js?v=20260320j';
import * as voice from './voice.js?v=20260524-singleagent6';
import * as companions from './companions.js?v=20260531-vrmfix6';
import * as fairyLive from './fairy-live.js?v=20260813-fairy-mic-recovery1';

const BASE = window.__BASE_PATH__ || '';

let roster = { agents: [], primaryAgentId: 'main' };
let activeChatAgent = null;
let activeChatSessionId = null;
let isChatOpen = false;
let isCreatingSession = false;
let fairyMessageRenderTimer = null;
let lastFairyLiveActive = null;
let launcherEl = null;
let panelEl = null;
let agentListEl = null;
let chatAreaEl = null;
let messageInputEl = null;
let sendBtnEl = null;
let fileInputEl = null;
let fileListEl = null;
let selectedFilesEl = null;
let filePanelEl = null;
let filePanelBodyEl = null;
let filePanelToggleEl = null;
let backchannelPanelEl = null;
let backchannelBodyEl = null;
let backchannelToggleEl = null;
let backchannelListEl = null;
let globalBackchannelPanelEl = null;
let globalBackchannelBodyEl = null;
let globalBackchannelToggleEl = null;
let globalBackchannelListEl = null;
let backchannelStartFromEl = null;
let backchannelStartToEl = null;
let backchannelStartTopicEl = null;
let backchannelStartBtnEl = null;
let roleplayGroupPanelEl = null;
let roleplayGroupBodyEl = null;
let roleplayGroupToggleEl = null;
let roleplayGroupListEl = null;
let roleplayGroupAgentPickerEl = null;
let roleplayGroupNameEl = null;
let roleplayGroupScenarioEl = null;
let roleplayGroupUserEl = null;
let roleplayGroupSystemEl = null;
let roleplayGroupCreateBtnEl = null;
let roleplayGroupAreaEl = null;
let roleplayGroupMessagesEl = null;
let roleplayGroupInputEl = null;
let roleplayGroupTalkBtnEl = null;
let roleplayGroupSpeakerEl = null;
let roleplayGroupVoiceBtnEl = null;
let roleplayGroupAutoBtnEl = null;
let roleplayGroupDeleteBtnEl = null;
let linkNameEl = null;
let linkUrlEl = null;
let linkNotesEl = null;
let sessionTitleEl = null;
let sessionMenuEl = null;
let sessionListEl = null;
let sessionSearchEl = null;
let newSessionBtnEl = null;
let sessionMenuToggleEl = null;
let roleplayModelSelectEl = null;
let roleplayCustomBaseUrlEl = null;
let roleplayCustomApiKeyEl = null;
let roleplayCustomModelEl = null;
let modeToggleEls = [];

const ROLEPLAY_MODEL_STORAGE_KEY = 'commandcenter:direct-chat:roleplay-model';
const ROLEPLAY_CUSTOM_STORAGE_KEY = 'commandcenter:direct-chat:roleplay-custom-provider';
const ROLEPLAY_MODEL = 'z-ai/glm-5';
const DEFAULT_PAWAN_ROLEPLAY_MODEL = 'pkrd/cosmosrp-2.1';
const ROLEPLAY_CUSTOM_MODEL = '__custom_openai__';
const ROLEPLAY_MODELS = [
  { id: 'z-ai/glm-5', label: 'Z.ai GLM-5 (OpenRouter default)' },
  { id: DEFAULT_PAWAN_ROLEPLAY_MODEL, label: 'CosmosRP 2.1 (Pawan.krd free)' },
  { id: 'pkrd/cosmosrp-3.5', label: 'CosmosRP 3.5 (Pawan.krd)' },
  { id: 'pkrd/cosmosrp-3.5:it', label: 'CosmosRP 3.5 Instructed (Pawan.krd)' },
  { id: 'pkrd/cosmosrp-3.5:msr', label: 'CosmosRP 3.5 MSR (Pawan.krd)' },
  { id: 'pkrd/cosmosrp-3.5:msr:it', label: 'CosmosRP 3.5 MSR-Instructed (Pawan.krd)' },
  { id: 'pkrd/cosmosrp-4.0', label: 'CosmosRP 4.0 (Pawan.krd)' },
  { id: 'pkrd/cosmosrp-4.0:lite', label: 'CosmosRP 4.0 Lite (Pawan.krd)' },
  { id: 'pkrd/cosmosrp-4.0-pro', label: 'CosmosRP 4.0 Pro (Pawan.krd)' },
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'anthracite-org/magnum-v4-72b', label: 'Magnum v4 72B' },
  { id: 'sao10k/l3.1-euryale-70b', label: 'Euryale 70B' },
  { id: 'sophosympatheia/rogue-rose-103b-v0.2', label: 'Rogue Rose 103B' },
  { id: ROLEPLAY_CUSTOM_MODEL, label: 'Custom OpenAI-compatible...' },
];
let selectedRoleplayModel = localStorage.getItem(ROLEPLAY_MODEL_STORAGE_KEY) || ROLEPLAY_MODEL;
let selectedRoleplayCustomProvider = loadStoredRoleplayCustomProvider();
let activeChatMode = 'agent';
let directChatSettings = { randomBackchannelMaxTurns: 8, manualBackchannelMaxTurns: 24, naturalBackchannelStop: true, roleplayAutoSpeak: true, roleplayDefaultModel: ROLEPLAY_MODEL, hasPawanApiKey: false, roleplayCustomBaseUrl: '', roleplayCustomModel: '', hasRoleplayCustomApiKey: false, relayEnabled: false, relayUrl: '', relayShowDeviceLabels: true };

const chatHistory = {};
const pendingByAgent = {};
const sessionsByAgent = {};
let fileLibrary = [];
let selectedFileIds = [];
let isFileLibraryExpanded = false;
let isBackchannelExpanded = false;
let backchannelMessages = [];
let globalBackchannelMessages = [];
let isGlobalBackchannelExpanded = false;
let selectedGlobalBackchannelThreadId = '';
let isStartingBackchannel = false;
let isRoleplayGroupsExpanded = false;
let roleplayGroups = [];
let activeRoleplayGroup = null;
let selectedRoleplayGroupSpeaker = '';
let isRoleplayGroupBusy = false;
let isRoleplayGroupAutoRunning = false;
let roleplayGroupVoiceEnabled = true;
let isSessionMenuOpen = false;
let companionVisuals = {};
let messageActionMenuEl = null;
let longPressTimer = null;
let longPressTarget = null;
let activeActionRequest = { kind: '', messageId: '' };
let companionItems = [];

export function init() {
  createLauncher();
  createPanel();
  loadRoster();
  loadFileLibrary();
  loadDirectChatSettings().catch(() => {});
  window.addEventListener('commandcenter:fairy-directchat-update', syncFairyLiveAgent);
}

function createLauncher() {
  if (launcherEl) return;
  launcherEl = document.createElement('button');
  launcherEl.id = 'direct-chat-launcher';
  launcherEl.type = 'button';
  launcherEl.innerHTML = '<span class="dc-launcher-dot"></span><span>CHAT</span>';
  launcherEl.addEventListener('click', openChatPanel);
  document.body.appendChild(launcherEl);
}

function createPanel() {
  if (panelEl) return;
  panelEl = document.createElement('div');
  panelEl.id = 'direct-chat-panel';
  panelEl.innerHTML = `
    <div class="dc-header">
      <span class="dc-title">DIRECT CHAT</span>
      <button class="dc-close" aria-label="Close chat">×</button>
    </div>
    <div class="dc-agent-list"></div>
    <div class="dc-global-backchannel-panel collapsed">
      <div class="dc-backchannel-title-row">
        <button class="dc-global-backchannel-toggle" type="button" aria-expanded="false">
          <span class="dc-backchannel-toggle-label">AGENT ↔ AGENT CONVERSATIONS</span>
          <span class="dc-global-backchannel-count dc-backchannel-toggle-count">0</span>
          <span class="dc-backchannel-toggle-chevron">▾</span>
        </button>
        <button class="dc-global-backchannel-refresh dc-backchannel-refresh" type="button">REFRESH</button>
      </div>
      <div class="dc-global-backchannel-body hidden">
        <div class="dc-backchannel-start">
          <div class="dc-backchannel-start-row">
            <select class="dc-backchannel-start-from" title="Starting agent"></select>
            <span>→</span>
            <select class="dc-backchannel-start-to" title="Receiving agent"></select>
          </div>
          <div class="dc-backchannel-start-row">
            <input class="dc-backchannel-start-topic" type="text" placeholder="Optional topic — blank lets the starting agent choose">
            <button class="dc-backchannel-start-btn" type="button">START</button>
          </div>
        </div>
        <div class="dc-global-backchannel-list"></div>
      </div>
    </div>
    <div class="dc-roleplay-groups-panel collapsed">
      <div class="dc-backchannel-title-row">
        <button class="dc-roleplay-groups-toggle" type="button" aria-expanded="false">
          <span class="dc-backchannel-toggle-label">ROLEPLAY GROUP CHATS</span>
          <span class="dc-roleplay-groups-count dc-backchannel-toggle-count">0</span>
          <span class="dc-backchannel-toggle-chevron">▾</span>
        </button>
        <button class="dc-roleplay-groups-refresh dc-backchannel-refresh" type="button">REFRESH</button>
      </div>
      <div class="dc-roleplay-groups-body hidden">
        <div class="dc-rpg-create">
          <input class="dc-rpg-name" type="text" placeholder="Group chat name (optional)">
          <textarea class="dc-rpg-scenario" rows="2" placeholder="Scenario / vibe before the conversation starts"></textarea>
          <input class="dc-rpg-user" type="text" placeholder="Optional: add yourself as a character name">
          <label class="dc-rpg-system-toggle"><input class="dc-rpg-system" type="checkbox"> <span>Add System/Director speaker for rules and topic changes</span></label>
          <div class="dc-rpg-agent-picker"></div>
          <button class="dc-rpg-create-btn" type="button">CREATE GROUP CHAT</button>
        </div>
        <div class="dc-rpg-list"></div>
      </div>
    </div>
    <div class="dc-rpg-area hidden">
      <div class="dc-rpg-header">
        <button class="dc-rpg-back" type="button">←</button>
        <div class="dc-rpg-header-main">
          <div class="dc-rpg-title"></div>
          <div class="dc-rpg-preview"></div>
        </div>
        <div class="dc-rpg-header-actions">
          <button class="dc-rpg-delete" type="button" title="Delete this group chat">DELETE</button>
          <button class="dc-rpg-voice" type="button" title="Speak latest agent message">VOICE</button>
          <button class="dc-rpg-auto" type="button" title="Auto-continue conversation">▶ AUTO</button>
        </div>
      </div>
      <div class="dc-rpg-messages"></div>
      <div class="dc-rpg-bottom">
        <div class="dc-rpg-speakers"></div>
        <div class="dc-rpg-compose">
          <input class="dc-rpg-input" type="text" placeholder="Type as selected character, or leave blank to let agents talk…">
          <button class="dc-rpg-talk" type="button">TALK</button>
        </div>
      </div>
    </div>
    <div class="dc-chat-area hidden">
      <div class="dc-chat-header">
        <button class="dc-back" type="button">←</button>
        <canvas class="dc-agent-companion hidden" width="44" height="44"></canvas>
        <div class="dc-chat-header-main">
          <span class="dc-agent-name"></span>
          <div class="dc-chat-mode-row">
            <button class="dc-mode-toggle active" type="button" data-chat-mode="agent">Agent</button>
            <button class="dc-mode-toggle" type="button" data-chat-mode="roleplay">Roleplay</button>
            <label class="dc-roleplay-model-wrap hidden">
              <span>Model</span>
              <select class="dc-roleplay-model" title="Roleplay model"></select>
            </label>
          </div>
          <div class="dc-roleplay-custom hidden">
            <input class="dc-roleplay-custom-url" type="url" placeholder="OpenAI-compatible base URL, e.g. http://localhost:1234/v1">
            <input class="dc-roleplay-custom-model" type="text" placeholder="Model ID">
            <input class="dc-roleplay-custom-key" type="password" placeholder="API key (optional)">
          </div>
          <div class="dc-session-bar">
            <button class="dc-session-toggle" type="button" aria-expanded="false">Session: <span class="dc-session-title">Latest</span> ▾</button>
            <button class="dc-session-new" type="button">＋ New</button>
          </div>
        </div>
      </div>
      <div class="dc-session-menu hidden">
        <div class="dc-session-menu-toolbar">
          <input class="dc-session-search" type="text" placeholder="Find a session..." autocomplete="off">
        </div>
        <div class="dc-session-list"></div>
      </div>
      <div class="dc-messages"></div>
      <div class="dc-files-panel collapsed">
        <div class="dc-files-title-row">
          <button class="dc-files-toggle" type="button" aria-expanded="false">
            <span class="dc-files-toggle-label">FILES</span>
            <span class="dc-files-toggle-count">0</span>
            <span class="dc-files-toggle-chevron">▾</span>
          </button>
          <label class="dc-upload-btn">
            <input class="dc-file-input" type="file" multiple>
            <span>UPLOAD</span>
          </label>
        </div>
        <div class="dc-files-body hidden">
          <div class="dc-link-row">
            <input class="dc-link-name" type="text" placeholder="Link title (optional)">
            <input class="dc-link-url" type="url" placeholder="Paste Google Doc / URL">
            <input class="dc-link-notes" type="text" placeholder="Notes (optional)">
            <button class="dc-link-save" type="button">SAVE LINK</button>
          </div>
          <div class="dc-selected-files"></div>
          <div class="dc-file-list"></div>
        </div>
      </div>
      <div class="dc-input-area">
        <input type="text" class="dc-input" placeholder="Type a message..." autocomplete="off">
        <button class="dc-send" type="button">SEND</button>
      </div>
    </div>
    <div class="dc-message-action-menu hidden"></div>
  `;

  document.getElementById('command-center').appendChild(panelEl);

  agentListEl = panelEl.querySelector('.dc-agent-list');
  chatAreaEl = panelEl.querySelector('.dc-chat-area');
  messageInputEl = panelEl.querySelector('.dc-input');
  sendBtnEl = panelEl.querySelector('.dc-send');
  fileInputEl = panelEl.querySelector('.dc-file-input');
  fileListEl = panelEl.querySelector('.dc-file-list');
  selectedFilesEl = panelEl.querySelector('.dc-selected-files');
  filePanelEl = panelEl.querySelector('.dc-files-panel');
  filePanelBodyEl = panelEl.querySelector('.dc-files-body');
  filePanelToggleEl = panelEl.querySelector('.dc-files-toggle');
  backchannelPanelEl = panelEl.querySelector('.dc-backchannel-panel');
  backchannelBodyEl = panelEl.querySelector('.dc-backchannel-body');
  backchannelToggleEl = panelEl.querySelector('.dc-backchannel-toggle');
  backchannelListEl = panelEl.querySelector('.dc-backchannel-list');
  globalBackchannelPanelEl = panelEl.querySelector('.dc-global-backchannel-panel');
  globalBackchannelBodyEl = panelEl.querySelector('.dc-global-backchannel-body');
  globalBackchannelToggleEl = panelEl.querySelector('.dc-global-backchannel-toggle');
  globalBackchannelListEl = panelEl.querySelector('.dc-global-backchannel-list');
  backchannelStartFromEl = panelEl.querySelector('.dc-backchannel-start-from');
  backchannelStartToEl = panelEl.querySelector('.dc-backchannel-start-to');
  backchannelStartTopicEl = panelEl.querySelector('.dc-backchannel-start-topic');
  backchannelStartBtnEl = panelEl.querySelector('.dc-backchannel-start-btn');
  roleplayGroupPanelEl = panelEl.querySelector('.dc-roleplay-groups-panel');
  roleplayGroupBodyEl = panelEl.querySelector('.dc-roleplay-groups-body');
  roleplayGroupToggleEl = panelEl.querySelector('.dc-roleplay-groups-toggle');
  roleplayGroupListEl = panelEl.querySelector('.dc-rpg-list');
  roleplayGroupAgentPickerEl = panelEl.querySelector('.dc-rpg-agent-picker');
  roleplayGroupNameEl = panelEl.querySelector('.dc-rpg-name');
  roleplayGroupScenarioEl = panelEl.querySelector('.dc-rpg-scenario');
  roleplayGroupUserEl = panelEl.querySelector('.dc-rpg-user');
  roleplayGroupSystemEl = panelEl.querySelector('.dc-rpg-system');
  roleplayGroupCreateBtnEl = panelEl.querySelector('.dc-rpg-create-btn');
  roleplayGroupAreaEl = panelEl.querySelector('.dc-rpg-area');
  roleplayGroupMessagesEl = panelEl.querySelector('.dc-rpg-messages');
  roleplayGroupInputEl = panelEl.querySelector('.dc-rpg-input');
  roleplayGroupTalkBtnEl = panelEl.querySelector('.dc-rpg-talk');
  roleplayGroupSpeakerEl = panelEl.querySelector('.dc-rpg-speakers');
  roleplayGroupVoiceBtnEl = panelEl.querySelector('.dc-rpg-voice');
  roleplayGroupAutoBtnEl = panelEl.querySelector('.dc-rpg-auto');
  roleplayGroupDeleteBtnEl = panelEl.querySelector('.dc-rpg-delete');
  linkNameEl = panelEl.querySelector('.dc-link-name');
  linkUrlEl = panelEl.querySelector('.dc-link-url');
  linkNotesEl = panelEl.querySelector('.dc-link-notes');
  sessionTitleEl = panelEl.querySelector('.dc-session-title');
  sessionMenuEl = panelEl.querySelector('.dc-session-menu');
  sessionListEl = panelEl.querySelector('.dc-session-list');
  sessionSearchEl = panelEl.querySelector('.dc-session-search');
  newSessionBtnEl = panelEl.querySelector('.dc-session-new');
  sessionMenuToggleEl = panelEl.querySelector('.dc-session-toggle');
  roleplayModelSelectEl = panelEl.querySelector('.dc-roleplay-model');
  roleplayCustomBaseUrlEl = panelEl.querySelector('.dc-roleplay-custom-url');
  roleplayCustomApiKeyEl = panelEl.querySelector('.dc-roleplay-custom-key');
  roleplayCustomModelEl = panelEl.querySelector('.dc-roleplay-custom-model');
  messageActionMenuEl = panelEl.querySelector('.dc-message-action-menu');
  modeToggleEls = Array.from(panelEl.querySelectorAll('.dc-mode-toggle'));

  panelEl.querySelector('.dc-close').addEventListener('click', closeChatPanel);
  panelEl.querySelector('.dc-back').addEventListener('click', showAgentList);
  sendBtnEl.addEventListener('click', sendMessage);
  messageInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  fileInputEl.addEventListener('change', uploadFiles);
  panelEl.querySelector('.dc-link-save').addEventListener('click', saveLink);
  filePanelToggleEl?.addEventListener('click', toggleFileLibrary);
  backchannelToggleEl?.addEventListener('click', toggleBackchannel);
  panelEl.querySelector('.dc-backchannel-refresh')?.addEventListener('click', () => loadBackchannelMessages());
  globalBackchannelToggleEl?.addEventListener('click', toggleGlobalBackchannel);
  roleplayGroupToggleEl?.addEventListener('click', toggleRoleplayGroups);
  panelEl.querySelector('.dc-roleplay-groups-refresh')?.addEventListener('click', () => loadRoleplayGroups().catch(() => {}));
  roleplayGroupCreateBtnEl?.addEventListener('click', createRoleplayGroupFromUi);
  roleplayGroupTalkBtnEl?.addEventListener('click', () => talkInRoleplayGroup({ speakGenerated: roleplayGroupVoiceEnabled }));
  roleplayGroupVoiceBtnEl?.addEventListener('click', speakLatestRoleplayGroupMessage);
  roleplayGroupAutoBtnEl?.addEventListener('click', toggleRoleplayGroupAuto);
  roleplayGroupDeleteBtnEl?.addEventListener('click', deleteActiveRoleplayGroup);
  roleplayGroupInputEl?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); talkInRoleplayGroup({ speakGenerated: roleplayGroupVoiceEnabled }); } });
  panelEl.querySelector('.dc-rpg-back')?.addEventListener('click', showAgentList);
  panelEl.querySelector('.dc-global-backchannel-refresh')?.addEventListener('click', (event) => { event.stopPropagation(); loadGlobalBackchannelMessages(); });
  backchannelStartBtnEl?.addEventListener('click', startBackchannelConversationFromUi);
  backchannelStartTopicEl?.addEventListener('keydown', (event) => { if (event.key === 'Enter') startBackchannelConversationFromUi(); });
  globalBackchannelListEl?.addEventListener('click', (event) => {
    const backBtn = event.target?.closest?.('.dc-backchannel-thread-back');
    if (backBtn) {
      selectedGlobalBackchannelThreadId = '';
      renderGlobalBackchannelMessages();
      return;
    }
    const convo = event.target?.closest?.('.dc-backchannel-convo');
    if (!convo) return;
    selectedGlobalBackchannelThreadId = String(convo.dataset?.threadId || '').trim();
    renderGlobalBackchannelMessages();
  });
  roleplayGroupListEl?.addEventListener('click', (event) => {
    const item = event.target?.closest?.('.dc-rpg-item');
    if (item) openRoleplayGroup(item.dataset.groupId || '').catch((err) => terminal.log(`[rpg] ${err.message}`, 'error', true));
  });
  roleplayGroupSpeakerEl?.addEventListener('click', (event) => {
    const item = event.target?.closest?.('.dc-rpg-speaker');
    if (!item) return;
    selectedRoleplayGroupSpeaker = item.dataset.speakerId || '';
    renderRoleplayGroupView();
  });
  roleplayGroupMessagesEl?.addEventListener('click', async (event) => {
    const actionButton = event.target?.closest?.('.dc-rpg-msg-action');
    if (actionButton) {
      event.preventDefault();
      event.stopPropagation();
      const action = actionButton.dataset.action || '';
      const messageId = actionButton.dataset.messageId || '';
      if (action === 'regenerate') await regenerateRoleplayGroupMessage(messageId);
      if (action === 'branch') await branchRoleplayGroupMessage(messageId);
      return;
    }
    const button = event.target?.closest?.('.dc-rpg-msg-speak');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    await speakRoleplayGroupMessage(button.dataset.messageId || '');
  });
  sessionMenuToggleEl?.addEventListener('click', toggleSessionMenu);
  newSessionBtnEl?.addEventListener('click', createNewSession);
  modeToggleEls.forEach((btn) => btn.addEventListener('click', () => setChatMode(btn.dataset.chatMode || 'agent')));
  initRoleplayModelSelect();
  roleplayModelSelectEl?.addEventListener('change', () => setRoleplayModel(roleplayModelSelectEl.value));
  [roleplayCustomBaseUrlEl, roleplayCustomApiKeyEl, roleplayCustomModelEl].forEach((input) => {
    input?.addEventListener('input', persistRoleplayCustomProvider);
  });
  sessionSearchEl?.addEventListener('input', () => renderSessionList(sessionSearchEl.value));
  document.getElementById('save-direct-chat-settings-btn')?.addEventListener('click', saveDirectChatSettings);
  document.getElementById('refresh-roleplay-agent-files-btn')?.addEventListener('click', loadRoleplayAgentFiles);
  panelEl.addEventListener('click', async (event) => {
    const menuAction = event.target?.closest?.('.dc-message-action-menu-btn');
    if (menuAction) {
      event.preventDefault();
      event.stopPropagation();
      const context = longPressTarget;
      hideMessageActionMenu();
      if (context?.type === 'group') {
        if (menuAction.dataset.action === 'regenerate') await regenerateRoleplayGroupMessage(context.messageId);
        if (menuAction.dataset.action === 'branch') await branchRoleplayGroupMessage(context.messageId);
      } else if (context?.type === 'direct') {
        if (menuAction.dataset.action === 'regenerate') await regenerateDirectRoleplayMessage(context.messageId);
        if (menuAction.dataset.action === 'branch') await branchDirectRoleplayMessage(context.messageId);
      }
      return;
    }
    const directAction = event.target?.closest?.('.dc-message-action');
    if (directAction) {
      event.preventDefault();
      event.stopPropagation();
      const action = directAction.dataset.action || '';
      const messageId = directAction.dataset.messageId || '';
      if (action === 'regenerate') await regenerateDirectRoleplayMessage(messageId);
      if (action === 'branch') await branchDirectRoleplayMessage(messageId);
      return;
    }
    const speakButton = event.target?.closest?.('.dc-message-speak');
    if (speakButton) {
      event.preventDefault();
      event.stopPropagation();
      await speakDirectMessage(speakButton.dataset.messageId || '');
      return;
    }
    if (!event.target?.closest?.('.dc-message-action-menu')) hideMessageActionMenu();
  });
  panelEl.addEventListener('touchstart', handleTouchLongPressStart, { passive: true });
  panelEl.addEventListener('touchend', cancelTouchLongPress, { passive: true });
  panelEl.addEventListener('touchmove', cancelTouchLongPress, { passive: true });
  panelEl.addEventListener('touchcancel', cancelTouchLongPress, { passive: true });

  syncFileLibraryVisibility();
  syncBackchannelVisibility();
  syncRoleplayGroupsVisibility();
  syncSessionMenuVisibility();
  syncModeToggle();
}


function getDirectChatSettingsInputs() {
  return {
    randomCap: document.getElementById('direct-chat-random-turn-cap'),
    manualCap: document.getElementById('direct-chat-manual-turn-cap'),
    naturalStop: document.getElementById('direct-chat-natural-stop'),
    roleplayAutoSpeak: document.getElementById('direct-chat-roleplay-auto-speak'),
    relayEnabled: document.getElementById('direct-chat-relay-enabled'),
    relayUrl: document.getElementById('direct-chat-relay-url'),
    relayShowDeviceLabels: document.getElementById('direct-chat-relay-show-device-labels'),
    model: document.getElementById('direct-chat-roleplay-default-model'),
    pawanKey: document.getElementById('direct-chat-pawan-api-key'),
    clearPawanKey: document.getElementById('direct-chat-pawan-clear-key'),
    customUrl: document.getElementById('direct-chat-roleplay-custom-url'),
    customModel: document.getElementById('direct-chat-roleplay-custom-model'),
    customKey: document.getElementById('direct-chat-roleplay-custom-key'),
    clearKey: document.getElementById('direct-chat-roleplay-clear-key'),
    status: document.getElementById('direct-chat-settings-status'),
  };
}

function setDirectChatSettingsStatus(text = '', isError = false) {
  const { status } = getDirectChatSettingsInputs();
  if (!status) return;
  status.textContent = text;
  status.style.color = isError ? 'var(--red)' : 'var(--text-dim)';
}

function applyDirectChatSettingsToUi(settings = directChatSettings) {
  const els = getDirectChatSettingsInputs();
  if (els.randomCap) els.randomCap.value = String(settings.randomBackchannelMaxTurns || 8);
  if (els.manualCap) els.manualCap.value = String(settings.manualBackchannelMaxTurns || 24);
  if (els.naturalStop) els.naturalStop.checked = settings.naturalBackchannelStop !== false;
  if (els.roleplayAutoSpeak) els.roleplayAutoSpeak.checked = settings.roleplayAutoSpeak !== false;
  if (els.relayEnabled) els.relayEnabled.checked = settings.relayEnabled === true;
  if (els.relayUrl) els.relayUrl.value = settings.relayUrl || '';
  if (els.relayShowDeviceLabels) els.relayShowDeviceLabels.checked = settings.relayShowDeviceLabels !== false;
  if (els.model) els.model.value = settings.roleplayDefaultModel || (settings.hasPawanApiKey ? DEFAULT_PAWAN_ROLEPLAY_MODEL : ROLEPLAY_MODEL);
  if (els.pawanKey) els.pawanKey.placeholder = settings.hasPawanApiKey ? 'Saved key set; leave blank to keep it' : 'pk-...';
  if (els.clearPawanKey) els.clearPawanKey.checked = false;
  if (els.customUrl) els.customUrl.value = settings.roleplayCustomBaseUrl || '';
  if (els.customModel) els.customModel.value = settings.roleplayCustomModel || '';
  if (els.customKey) els.customKey.placeholder = settings.hasRoleplayCustomApiKey ? 'Saved key set; leave blank to keep it' : 'Leave blank if not needed';
  if (els.clearKey) els.clearKey.checked = false;
}

async function loadDirectChatSettings() {
  try {
    const res = await fetch(`${BASE}/api/settings/direct-chat`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load settings');
    directChatSettings = { ...directChatSettings, ...(data.settings || {}) };
    roleplayGroupVoiceEnabled = directChatSettings.roleplayAutoSpeak !== false;
    applyDirectChatSettingsToUi(directChatSettings);
    if (!localStorage.getItem(ROLEPLAY_MODEL_STORAGE_KEY)) {
      setRoleplayModel(
        directChatSettings.roleplayDefaultModel || (directChatSettings.hasPawanApiKey ? DEFAULT_PAWAN_ROLEPLAY_MODEL : ROLEPLAY_MODEL),
        { persist: false },
      );
    }
    if (!localStorage.getItem(ROLEPLAY_CUSTOM_STORAGE_KEY)) {
      selectedRoleplayCustomProvider = {
        baseUrl: directChatSettings.roleplayCustomBaseUrl || '',
        apiKey: '',
        model: directChatSettings.roleplayCustomModel || '',
      };
      syncRoleplayCustomInputs();
    }
    renderAgentList();
    setDirectChatSettingsStatus('Direct Chat settings loaded.');
    loadRoleplayAgentFiles().catch(() => {});
  } catch (err) {
    setDirectChatSettingsStatus(err.message || 'Could not load Direct Chat settings.', true);
  }
}

async function saveDirectChatSettings() {
  const els = getDirectChatSettingsInputs();
  const payload = {
    randomBackchannelMaxTurns: Number(els.randomCap?.value || 8),
    manualBackchannelMaxTurns: Number(els.manualCap?.value || 24),
    naturalBackchannelStop: els.naturalStop?.checked !== false,
    roleplayAutoSpeak: els.roleplayAutoSpeak?.checked !== false,
    relayEnabled: els.relayEnabled?.checked === true,
    relayUrl: String(els.relayUrl?.value || '').trim(),
    relayShowDeviceLabels: els.relayShowDeviceLabels?.checked !== false,
    roleplayDefaultModel: String(els.model?.value || ROLEPLAY_MODEL).trim(),
    pawanApiKey: String(els.pawanKey?.value || '').trim(),
    clearPawanApiKey: els.clearPawanKey?.checked === true,
    roleplayCustomBaseUrl: String(els.customUrl?.value || '').trim(),
    roleplayCustomModel: String(els.customModel?.value || '').trim(),
    roleplayCustomApiKey: String(els.customKey?.value || '').trim(),
    clearRoleplayCustomApiKey: els.clearKey?.checked === true,
  };
  setDirectChatSettingsStatus('Saving Direct Chat settings…');
  try {
    const res = await fetch(`${BASE}/api/settings/direct-chat`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Save failed');
    directChatSettings = { ...directChatSettings, ...(data.settings || {}) };
    roleplayGroupVoiceEnabled = directChatSettings.roleplayAutoSpeak !== false;
    applyDirectChatSettingsToUi(directChatSettings);
    setRoleplayModel(directChatSettings.roleplayDefaultModel || ROLEPLAY_MODEL);
    selectedRoleplayCustomProvider = {
      baseUrl: directChatSettings.roleplayCustomBaseUrl || '',
      apiKey: payload.roleplayCustomApiKey || selectedRoleplayCustomProvider.apiKey || '',
      model: directChatSettings.roleplayCustomModel || '',
    };
    localStorage.setItem(ROLEPLAY_CUSTOM_STORAGE_KEY, JSON.stringify(selectedRoleplayCustomProvider));
    syncRoleplayCustomInputs();
    if (els.pawanKey) els.pawanKey.value = '';
    if (els.customKey) els.customKey.value = '';
    renderAgentList();
    setDirectChatSettingsStatus('Direct Chat settings saved.');
  } catch (err) {
    setDirectChatSettingsStatus(err.message || 'Could not save Direct Chat settings.', true);
  }
}


function shouldAutoSpeakRoleplayVoice() {
  return false;
}

function setRoleplayAgentFilesStatus(text = '', isError = false) {
  const el = document.getElementById('direct-chat-roleplay-agent-files-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--red)' : 'var(--text-dim)';
}

function renderRoleplayAgentFilesList(agents = []) {
  const listEl = document.getElementById('direct-chat-roleplay-agent-files-list');
  if (!listEl) return;
  if (!Array.isArray(agents) || !agents.length) {
    listEl.innerHTML = '<div class="dc-empty">No roleplay agents found.</div>';
    return;
  }
  listEl.innerHTML = agents.map((agent) => {
    const loaded = Array.isArray(agent.loadedSummary) ? agent.loadedSummary : [];
    const fileRows = Array.isArray(agent.files) ? agent.files.map((file) => `
      <div class="dc-roleplay-file-row ${file.exists ? 'is-loaded' : 'is-missing'}">
        <div class="dc-roleplay-file-main">
          <strong>${escapeHtml(file.label || file.key || 'file')}</strong>
          <span>${escapeHtml(file.path || '(no workspace path)')}</span>
        </div>
        <span class="dc-roleplay-file-state">${file.exists ? (file.fallbackOnly ? 'FALLBACK' : 'LOADED') : 'MISSING'}</span>
      </div>
    `).join('') : '';
    const loadedText = loaded.length ? loaded.join(', ') : 'Nothing loaded';
    return `
      <details class="dc-roleplay-agent-card">
        <summary class="dc-roleplay-agent-card-top">
          <div>
            <div class="dc-roleplay-agent-name">${escapeHtml(agent.label || agent.agentId || 'Agent')}</div>
            <div class="dc-roleplay-agent-meta">${escapeHtml(agent.agentId || '')} · ${escapeHtml(agent.source || 'unknown')}</div>
            <div class="dc-roleplay-agent-meta">${escapeHtml(agent.workspace || 'No workspace')}</div>
          </div>
          <div class="dc-roleplay-agent-loaded-wrap">
            <div class="dc-roleplay-agent-loaded">${escapeHtml(loadedText)}</div>
            <div class="dc-roleplay-agent-chevron">▾</div>
          </div>
        </summary>
        <div class="dc-roleplay-file-list">${fileRows}</div>
      </details>
    `;
  }).join('');
}

async function loadRoleplayAgentFiles() {
  setRoleplayAgentFilesStatus('Loading roleplay agent files…');
  try {
    const res = await fetch(`${BASE}/api/roleplay/agent-files`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load roleplay agent files');
    renderRoleplayAgentFilesList(Array.isArray(data.agents) ? data.agents : []);
    setRoleplayAgentFilesStatus('Roleplay agent files loaded.');
  } catch (err) {
    renderRoleplayAgentFilesList([]);
    setRoleplayAgentFilesStatus(err.message || 'Could not load roleplay agent files.', true);
  }
}

async function loadRoster() {
  try {
    const res = await fetch(`${BASE}/api/agents`);
    if (res.ok) roster = await res.json();
    renderAgentList();
  } catch (_) {}
}

async function loadFileLibrary() {
  try {
    const res = await fetch(`${BASE}/api/chat/files`);
    if (!res.ok) return;
    const data = await res.json();
    fileLibrary = Array.isArray(data.items) ? data.items : [];
    renderFileLibrary();
  } catch (_) {}
}

async function loadAgentSessions(agentId) {
  try {
    const res = await fetch(`${BASE}/api/chat/sessions?agent=${encodeURIComponent(agentId)}&mode=${encodeURIComponent(activeChatMode)}&limit=40`);
    if (!res.ok) return [];
    const data = await res.json();
    sessionsByAgent[agentId] = Array.isArray(data.sessions) ? data.sessions : [];
    return sessionsByAgent[agentId];
  } catch (_) {
    return [];
  }
}

async function loadSessionMessages(sessionId) {
  if (!sessionId) return [];
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!res.ok) return [];
    const data = await res.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    chatHistory[sessionId] = messages.map((msg) => ({
      id: msg.id,
      role: msg.role === 'user' ? 'user' : 'agent',
      kind: msg.meta?.error ? 'error' : 'text',
      text: String(msg.text || ''),
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      files: Array.isArray(msg.meta?.files) ? msg.meta.files : [],
    }));
    return chatHistory[sessionId];
  } catch (_) {
    return [];
  }
}

function getCompanionItemById(companionId = '') {
  const id = String(companionId || '').trim();
  if (!id) return null;
  return companionItems.find((item) => String(item?.id || '') === id) || null;
}

function getResolvedAgentVisual(agent = {}) {
  const agentId = String(agent?.id || '').trim();
  const explicit = companionVisuals?.[agentId] || null;
  const visual = explicit || agent?.visual || { mode: 'default', companion: null, companionId: '' };
  if (visual?.mode !== 'companion') return visual;

  const companionId = String(visual.companionId || visual.companion?.id || '').trim();
  const companion = visual.companion || getCompanionItemById(companionId);
  return { ...visual, companionId, companion: companion || null };
}

function withResolvedAgentVisual(agent = {}) {
  return { ...agent, visual: getResolvedAgentVisual(agent) };
}

function getRosterWithFairy() {
  const baseAgents = roster.agents?.length ? roster.agents.map(withResolvedAgentVisual) : [withResolvedAgentVisual({ id: 'main', label: 'Main', color: '#FFD700' })];
  const fairyAgent = fairyLive.getDirectChatAgent?.();
  if (fairyAgent && !baseAgents.some((agent) => agent.id === fairyAgent.id)) {
    baseAgents.unshift(withResolvedAgentVisual(fairyAgent));
  }
  return baseAgents;
}


function renderBackchannelStartOptions() {
  const agents = getRosterWithFairy().filter((agent) => !fairyLive.isDirectChatAgent?.(agent.id));
  const options = agents.map((agent) => `<option value="${escapeAttr(agent.id)}">${escapeHtml(agent.label || agent.id)}</option>`).join('');
  if (backchannelStartFromEl) {
    const prev = backchannelStartFromEl.value || roster.primaryAgentId || agents[0]?.id || '';
    backchannelStartFromEl.innerHTML = options;
    if (agents.some((agent) => agent.id === prev)) backchannelStartFromEl.value = prev;
  }
  if (backchannelStartToEl) {
    const prev = backchannelStartToEl.value || agents.find((agent) => agent.id !== backchannelStartFromEl?.value)?.id || agents[1]?.id || agents[0]?.id || '';
    backchannelStartToEl.innerHTML = options;
    if (agents.some((agent) => agent.id === prev)) backchannelStartToEl.value = prev;
    if (backchannelStartToEl.value === backchannelStartFromEl?.value) {
      const alternate = agents.find((agent) => agent.id !== backchannelStartFromEl.value);
      if (alternate) backchannelStartToEl.value = alternate.id;
    }
  }
}

async function startBackchannelConversationFromUi() {
  if (isStartingBackchannel || !backchannelStartFromEl || !backchannelStartToEl) return;
  const fromAgent = String(backchannelStartFromEl.value || '').trim();
  const toAgent = String(backchannelStartToEl.value || '').trim();
  const topic = String(backchannelStartTopicEl?.value || '').trim();
  if (!fromAgent || !toAgent || fromAgent === toAgent) {
    if (globalBackchannelListEl) globalBackchannelListEl.innerHTML = '<div class="dc-empty dc-backchannel-empty">Pick two different agents, menace.</div>';
    return;
  }
  isStartingBackchannel = true;
  if (backchannelStartBtnEl) {
    backchannelStartBtnEl.disabled = true;
    backchannelStartBtnEl.textContent = 'STARTING…';
  }
  if (globalBackchannelListEl) globalBackchannelListEl.innerHTML = '<div class="dc-empty dc-backchannel-empty">Starting agent conversation…</div>';
  try {
    const res = await fetch(`${BASE}/api/agent-comms/start`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAgent, toAgent, topic }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not start conversation');
    if (backchannelStartTopicEl) backchannelStartTopicEl.value = '';
    selectedGlobalBackchannelThreadId = data.threadId || '';
    await loadGlobalBackchannelMessages();
  } catch (err) {
    if (globalBackchannelListEl) globalBackchannelListEl.innerHTML = `<div class="dc-empty dc-backchannel-empty">Could not start conversation: ${escapeHtml(err.message || 'unknown error')}</div>`;
  } finally {
    isStartingBackchannel = false;
    if (backchannelStartBtnEl) {
      backchannelStartBtnEl.disabled = false;
      backchannelStartBtnEl.textContent = 'START';
    }
  }
}


function syncRoleplayGroupsVisibility() {
  if (!roleplayGroupPanelEl || !roleplayGroupBodyEl || !roleplayGroupToggleEl) return;
  roleplayGroupPanelEl.classList.toggle('collapsed', !isRoleplayGroupsExpanded);
  roleplayGroupBodyEl.classList.toggle('hidden', !isRoleplayGroupsExpanded);
  roleplayGroupToggleEl.setAttribute('aria-expanded', String(isRoleplayGroupsExpanded));
  const countEl = roleplayGroupToggleEl.querySelector('.dc-roleplay-groups-count');
  if (countEl) countEl.textContent = String(roleplayGroups.length || 0);
}

function toggleRoleplayGroups() {
  isRoleplayGroupsExpanded = !isRoleplayGroupsExpanded;
  syncRoleplayGroupsVisibility();
  if (isRoleplayGroupsExpanded) loadRoleplayGroups().catch(() => {});
}

function renderRoleplayGroupAgentPicker() {
  if (!roleplayGroupAgentPickerEl) return;
  const agents = getRosterWithFairy().filter((agent) => !fairyLive.isDirectChatAgent?.(agent.id));
  roleplayGroupAgentPickerEl.innerHTML = agents.map((agent, index) => `
    <label class="dc-rpg-agent-choice">
      <input type="checkbox" value="${escapeAttr(agent.id)}" ${index < 2 ? 'checked' : ''}>
      <span>${escapeHtml(agent.label || agent.id)}</span>
    </label>
  `).join('');
}

async function loadRoleplayGroups() {
  try {
    const res = await fetch(`${BASE}/api/roleplay-groups?limit=50`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load roleplay groups');
    roleplayGroups = Array.isArray(data.groups) ? data.groups : [];
    renderRoleplayGroupList();
    syncRoleplayGroupsVisibility();
  } catch (err) {
    if (roleplayGroupListEl) roleplayGroupListEl.innerHTML = `<div class="dc-empty dc-rpg-empty">Could not load roleplay groups: ${escapeHtml(err.message || 'unknown error')}</div>`;
  }
}

function renderRoleplayGroupList() {
  if (!roleplayGroupListEl) return;
  if (!roleplayGroups.length) {
    roleplayGroupListEl.innerHTML = '<div class="dc-empty dc-rpg-empty">No roleplay group chats yet</div>';
    return;
  }
  roleplayGroupListEl.innerHTML = roleplayGroups.map((group) => {
    const names = (group.agents || []).map((agent) => agent.label || agent.id).slice(0, 4).join(', ');
    const extra = (group.agents || []).length > 4 ? ` +${(group.agents || []).length - 4}` : '';
    return `
      <button class="dc-rpg-item" type="button" data-group-id="${escapeAttr(group.id)}">
        <span class="dc-rpg-item-title">${escapeHtml(group.name || 'Roleplay Group Chat')} · ${(group.agents || []).length} agents</span>
        <span class="dc-rpg-item-preview">${escapeHtml(names + extra)}</span>
        <span class="dc-rpg-item-last">${escapeHtml(group.lastMessagePreview || group.scenario || 'Tap to open')}</span>
      </button>
    `;
  }).join('');
}

async function createRoleplayGroupFromUi() {
  const agentIds = Array.from(roleplayGroupAgentPickerEl?.querySelectorAll('input:checked') || []).map((input) => input.value);
  if (agentIds.length < 2) {
    if (roleplayGroupListEl) roleplayGroupListEl.innerHTML = '<div class="dc-empty dc-rpg-empty">Pick at least two agents, chaos coordinator.</div>';
    return;
  }
  roleplayGroupCreateBtnEl.disabled = true;
  roleplayGroupCreateBtnEl.textContent = 'CREATING…';
  try {
    const res = await fetch(`${BASE}/api/roleplay-groups`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roleplayGroupNameEl?.value || '', scenario: roleplayGroupScenarioEl?.value || '', userCharacter: roleplayGroupUserEl?.value || '', systemCharacter: roleplayGroupSystemEl?.checked === true, agentIds, model: getRoleplayModel(), roleplayProvider: getRoleplayProvider() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not create group');
    roleplayGroupNameEl.value = ''; roleplayGroupScenarioEl.value = ''; roleplayGroupUserEl.value = ''; if (roleplayGroupSystemEl) roleplayGroupSystemEl.checked = false;
    await loadRoleplayGroups();
    await openRoleplayGroup(data.group?.id || '');
  } catch (err) {
    if (roleplayGroupListEl) roleplayGroupListEl.innerHTML = `<div class="dc-empty dc-rpg-empty">Could not create group: ${escapeHtml(err.message || 'unknown error')}</div>`;
  } finally {
    roleplayGroupCreateBtnEl.disabled = false;
    roleplayGroupCreateBtnEl.textContent = 'CREATE GROUP CHAT';
  }
}

async function openRoleplayGroup(groupId = '') {
  if (!groupId) return;
  const res = await fetch(`${BASE}/api/roleplay-groups/${encodeURIComponent(groupId)}`, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not open group');
  activeRoleplayGroup = data.group;
  isRoleplayGroupAutoRunning = false;
  syncRoleplayGroupAutoUi();
  selectedRoleplayGroupSpeaker = activeRoleplayGroup.userCharacter ? 'user' : (activeRoleplayGroup.agents?.[0]?.id || '');
  agentListEl?.classList.add('hidden');
  globalBackchannelPanelEl?.classList.add('hidden');
  roleplayGroupPanelEl?.classList.add('hidden');
  chatAreaEl?.classList.add('hidden');
  roleplayGroupAreaEl?.classList.remove('hidden');
  renderRoleplayGroupView();
  setTimeout(() => roleplayGroupInputEl?.focus(), 60);
}

function renderRoleplayGroupView() {
  hideMessageActionMenu();
  if (!activeRoleplayGroup || !roleplayGroupAreaEl) return;
  const title = roleplayGroupAreaEl.querySelector('.dc-rpg-title');
  const preview = roleplayGroupAreaEl.querySelector('.dc-rpg-preview');
  const agents = activeRoleplayGroup.agents || [];
  if (title) title.textContent = `${activeRoleplayGroup.name || 'Roleplay Group Chat'} · ${agents.length} agents`;
  if (preview) preview.textContent = agents.map((agent) => agent.label || agent.id).join(', ');
  if (roleplayGroupMessagesEl) {
    const messages = activeRoleplayGroup.messages || [];
    roleplayGroupMessagesEl.innerHTML = messages.length ? messages.map(renderRoleplayGroupMessage).join('') : `<div class="dc-empty dc-rpg-empty">${escapeHtml(activeRoleplayGroup.scenario || 'Start the scene with Talk.')}</div>`;
    roleplayGroupMessagesEl.scrollTop = roleplayGroupMessagesEl.scrollHeight;
  }
  syncRoleplayGroupAutoUi();
  if (roleplayGroupSpeakerEl) {
    const user = activeRoleplayGroup.userCharacter ? [{ id: 'user', label: activeRoleplayGroup.userCharacter, user: true }] : [];
    const system = activeRoleplayGroup.systemCharacter ? [{ id: 'system', label: 'System', system: true }] : [];
    roleplayGroupSpeakerEl.innerHTML = [...system, ...user, ...agents].map((speaker) => `
      <button class="dc-rpg-speaker ${selectedRoleplayGroupSpeaker === speaker.id ? 'active' : ''}" type="button" data-speaker-id="${escapeAttr(speaker.id)}">
        <span class="dc-rpg-speaker-dot">${escapeHtml((speaker.label || speaker.id || '?').slice(0, 1).toUpperCase())}</span>
        <span>${escapeHtml(speaker.label || speaker.id)}</span>
      </button>
    `).join('');
  }
}

function getRoleplayGroupAgentColor(agentId = '') {
  const id = String(agentId || '').trim();
  const groupAgent = (activeRoleplayGroup?.agents || []).find((agent) => agent.id === id);
  const rosterAgent = getAgent(id);
  return groupAgent?.color || rosterAgent?.color || '#7d9dff';
}

function renderRoleplayGroupMessage(message = {}) {
  const isRegenerating = message.kind === 'regenerating';
  const isSystem = message.role === 'system' || message.speakerId === 'system';
  const isUser = message.role === 'user' || message.role === 'agent-user' || isSystem;
  const color = isSystem ? '#ffcc66' : (isUser ? 'var(--dc-accent, #7d9dff)' : getRoleplayGroupAgentColor(message.speakerId));
  const canSpeak = !isUser && !isRegenerating && String(message.text || '').trim();
  const canAct = !isRegenerating && message.role === 'agent' && String(message.text || '').trim();
  const latestEligibleId = getLatestEligibleRoleplayGroupMessageId();
  const alwaysVisible = canAct && String(message.id || '') === String(latestEligibleId || '');
  const regenPending = isActionPending('group-regenerate', String(message.id || ''));
  const branchPending = isActionPending('group-branch', String(message.id || ''));
  const speakButton = canSpeak ? `<button class="dc-rpg-msg-speak" type="button" data-message-id="${escapeAttr(message.id || '')}" title="Speak this message">▶</button>` : '';
  const actionButtons = canAct ? `<div class="dc-rpg-msg-actions ${alwaysVisible ? 'always-visible' : ''}"><button class="dc-rpg-msg-action" type="button" data-action="regenerate" data-message-id="${escapeAttr(message.id || '')}" title="Regenerate from this message" ${regenPending || branchPending ? 'disabled' : ''}>${regenPending ? '…' : '↻ Regenerate'}</button><button class="dc-rpg-msg-action" type="button" data-action="branch" data-message-id="${escapeAttr(message.id || '')}" title="Create branch from this message" ${regenPending || branchPending ? 'disabled' : ''}>${branchPending ? '…' : '⑂ Branch'}</button></div>` : '';
  const body = isRegenerating
    ? `<div class="dc-rpg-msg-text dc-msg-regenerating"><div class="dc-typing"><span></span><span></span><span></span></div><span>Regenerating response…</span></div>`
    : `<div class="dc-rpg-msg-text">${renderImmersionText(message.text || '')}</div>`;
  return `
    <div class="dc-rpg-msg ${isSystem ? 'from-system' : (isUser ? 'from-user' : 'from-agent')} ${alwaysVisible ? 'has-persistent-actions' : ''} ${isRegenerating ? 'is-regenerating' : ''}" data-message-id="${escapeAttr(message.id || '')}" data-message-kind="${canAct ? 'roleplay-agent' : ''}" style="--rpg-color: ${escapeAttr(color)}">
      <div class="dc-rpg-msg-top"><strong>${escapeHtml(message.speakerLabel || message.speakerId || 'Unknown')}</strong><span>${escapeHtml(formatTime(message.createdAt || Date.now()))}</span></div>
      <div class="dc-rpg-msg-row">${body}${speakButton}</div>
      ${actionButtons}
    </div>
  `;
}

function getRoleplayGroupMessageById(messageId = '') {
  return (activeRoleplayGroup?.messages || []).find((message) => String(message.id || '') === String(messageId || '')) || null;
}

function getLatestEligibleRoleplayGroupMessageId() {
  return [...(activeRoleplayGroup?.messages || [])].reverse().find((message) => message.role === 'agent' && String(message.text || '').trim())?.id || '';
}

function truncateRoleplayGroupMessagesAt(messageId = '') {
  if (!activeRoleplayGroup?.messages?.length || !messageId) return null;
  const idx = activeRoleplayGroup.messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
  if (idx === -1) return null;
  const snapshot = Array.isArray(activeRoleplayGroup.messages) ? [...activeRoleplayGroup.messages] : [];
  activeRoleplayGroup = { ...activeRoleplayGroup, messages: activeRoleplayGroup.messages.slice(0, idx) };
  return snapshot;
}

function getLatestEligibleDirectMessageId(messages = []) {
  return [...(messages || [])].reverse().find((msg) => msg.role === 'agent' && msg.kind !== 'typing' && msg.kind !== 'tool' && msg.kind !== 'file' && String(msg.text || '').trim())?.id || '';
}

function truncateDirectMessagesAt(messageId = '') {
  const key = getActiveHistoryKey();
  const history = Array.isArray(chatHistory[key]) ? chatHistory[key] : [];
  if (!history.length || !messageId) return null;
  const idx = history.findIndex((message) => String(message.id || '') === String(messageId || ''));
  if (idx === -1) return null;
  const snapshot = [...history];
  chatHistory[key] = history.slice(0, idx);
  return snapshot;
}

function isActionPending(kind = '', messageId = '') {
  return activeActionRequest.kind === kind && activeActionRequest.messageId === messageId;
}

function setActionPending(kind = '', messageId = '') {
  activeActionRequest = { kind, messageId };
}

function clearActionPending() {
  activeActionRequest = { kind: '', messageId: '' };
}

async function regenerateRoleplayGroupMessage(messageId = '') {
  if (!activeRoleplayGroup?.id || !messageId || isActionPending('group-regenerate', messageId)) return false;
  const latestId = getLatestEligibleRoleplayGroupMessageId();
  if (latestId && latestId !== messageId) {
    const ok = window.confirm('Regenerate from here? This will replace this message and remove later messages in the current timeline.');
    if (!ok) return false;
  }
  const sourceMessage = getRoleplayGroupMessageById(messageId);
  const rollbackMessages = truncateRoleplayGroupMessagesAt(messageId);
  if (activeRoleplayGroup) {
    activeRoleplayGroup = {
      ...activeRoleplayGroup,
      messages: [
        ...(activeRoleplayGroup.messages || []),
        {
          id: `regen_pending_${messageId}`,
          kind: 'regenerating',
          role: 'agent',
          speakerId: sourceMessage?.speakerId || '',
          speakerLabel: sourceMessage?.speakerLabel || sourceMessage?.speakerId || 'Agent',
          createdAt: Date.now(),
          text: '',
        },
      ],
    };
  }
  setActionPending('group-regenerate', messageId);
  renderRoleplayGroupView();
  try {
    const res = await fetch(`${BASE}/api/roleplay-groups/${encodeURIComponent(activeRoleplayGroup.id)}/regenerate`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, model: getRoleplayModel(), roleplayProvider: getRoleplayProvider() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not regenerate message');
    activeRoleplayGroup = data.group;
    await loadRoleplayGroups();
    renderRoleplayGroupView();
    if (roleplayGroupVoiceEnabled && data.message?.text) {
      speakRoleplayGroupMessage(data.message.id).catch((err) => terminal.log(`[rpg voice] ${err.message || 'Playback failed.'}`, 'error', true));
    }
    return true;
  } catch (err) {
    if (rollbackMessages && activeRoleplayGroup) activeRoleplayGroup = { ...activeRoleplayGroup, messages: rollbackMessages };
    terminal.log(`[rpg] ${err.message || 'Could not regenerate message.'}`, 'error', true);
    renderRoleplayGroupView();
    return false;
  } finally {
    clearActionPending();
    renderRoleplayGroupView();
  }
}

async function branchRoleplayGroupMessage(messageId = '') {
  if (!activeRoleplayGroup?.id || !messageId || isActionPending('group-branch', messageId)) return false;
  setActionPending('group-branch', messageId);
  renderRoleplayGroupView();
  try {
    const res = await fetch(`${BASE}/api/roleplay-groups/${encodeURIComponent(activeRoleplayGroup.id)}/branch`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not create branch');
    await loadRoleplayGroups();
    await openRoleplayGroup(data.group?.id || '');
    return true;
  } catch (err) {
    terminal.log(`[rpg] ${err.message || 'Could not create branch.'}`, 'error', true);
    return false;
  } finally {
    clearActionPending();
    renderRoleplayGroupView();
  }
}

async function deleteActiveRoleplayGroup() {
  if (!activeRoleplayGroup?.id) return false;
  const count = Number(activeRoleplayGroup.messages?.length || 0);
  const ok = window.confirm(`Delete this group chat permanently?\n\n${count} message${count === 1 ? '' : 's'} will be removed.`);
  if (!ok) return false;
  try {
    const res = await fetch(`${BASE}/api/roleplay-groups/${encodeURIComponent(activeRoleplayGroup.id)}`, { method: 'DELETE', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not delete group chat');
    isRoleplayGroupAutoRunning = false;
    voice.stopPlayback?.();
        activeRoleplayGroup = null;
    roleplayGroupAreaEl?.classList.add('hidden');
    roleplayGroupPanelEl?.classList.remove('hidden');
    await loadRoleplayGroups();
    renderRoleplayGroupView();
    return true;
  } catch (err) {
    terminal.log(`[rpg] ${err.message || 'Could not delete group chat.'}`, 'error', true);
    return false;
  }
}

async function speakRoleplayGroupMessage(messageId = '', { awaitPlayback = true } = {}) {
  const message = getRoleplayGroupMessageById(messageId);
  if (!message || message.role === 'user') return false;
  const text = String(message.text || '').trim();
  if (!text) return false;
    const playback = voice.playSpokenResponse(text, message.speakerId || activeRoleplayGroup?.agents?.[0]?.id || 'main', { force: true });
  if (!awaitPlayback) {
    playback.catch((err) => terminal.log(`[rpg voice] ${err.message || 'Playback failed.'}`, 'error', true));
    return true;
  }
  try {
    await playback;
    return true;
  } catch (err) {
    terminal.log(`[rpg voice] ${err.message || 'Playback failed.'}`, 'error', true);
    return false;
  }
}

async function speakLatestRoleplayGroupMessage() {
  const latest = [...(activeRoleplayGroup?.messages || [])].reverse().find((message) => message.role === 'agent' && String(message.text || '').trim());
  if (latest) await speakRoleplayGroupMessage(latest.id);
}

async function speakRoleplayGroupMessages(messages = []) {
  if (!roleplayGroupVoiceEnabled) return;
  const latestAgentMessage = [...(messages || [])].reverse().find((message) => message?.role === 'agent' && String(message.text || '').trim());
  if (!latestAgentMessage?.id) return;
  speakRoleplayGroupMessage(latestAgentMessage.id, { awaitPlayback: false });
}

function syncRoleplayGroupAutoUi() {
  if (roleplayGroupAutoBtnEl) {
    roleplayGroupAutoBtnEl.textContent = isRoleplayGroupAutoRunning ? '⏸ PAUSE' : '▶ AUTO';
    roleplayGroupAutoBtnEl.classList.toggle('active', isRoleplayGroupAutoRunning);
  }
}

async function toggleRoleplayGroupAuto() {
  if (!activeRoleplayGroup) return;
  isRoleplayGroupAutoRunning = !isRoleplayGroupAutoRunning;
  syncRoleplayGroupAutoUi();
  if (!isRoleplayGroupAutoRunning) {
    voice.stopPlayback?.();
        return;
  }
  while (isRoleplayGroupAutoRunning && activeRoleplayGroup) {
    const ok = await talkInRoleplayGroup({ forceBlank: true, speakGenerated: roleplayGroupVoiceEnabled, fromAuto: true });
    if (!ok) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  isRoleplayGroupAutoRunning = false;
  syncRoleplayGroupAutoUi();
}


async function talkInRoleplayGroup({ forceBlank = false, speakGenerated = false, fromAuto = false } = {}) {
  if (!activeRoleplayGroup || isRoleplayGroupBusy) return false;
  const text = forceBlank ? '' : String(roleplayGroupInputEl?.value || '').trim();
  isRoleplayGroupBusy = true;
  roleplayGroupTalkBtnEl.disabled = true;
  roleplayGroupTalkBtnEl.textContent = 'TALKING…';
  if (text) roleplayGroupInputEl.value = '';
  try {
    const res = await fetch(`${BASE}/api/roleplay-groups/${encodeURIComponent(activeRoleplayGroup.id)}/talk`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakerId: selectedRoleplayGroupSpeaker, text, autoContinue: fromAuto, model: getRoleplayModel(), roleplayProvider: getRoleplayProvider() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Talk failed');
    activeRoleplayGroup = data.group;
    await loadRoleplayGroups();
    renderRoleplayGroupView();
    if (speakGenerated) {
      speakRoleplayGroupMessages(data.messages || []).catch((err) => {
        terminal.log(`[rpg voice] ${err?.message || 'Playback failed.'}`, 'error', true);
      });
    }
    return true;
  } catch (err) {
    if (roleplayGroupMessagesEl) roleplayGroupMessagesEl.insertAdjacentHTML('beforeend', `<div class="dc-empty dc-rpg-empty">Error: ${escapeHtml(err.message || 'unknown error')}</div>`);
    if (fromAuto) isRoleplayGroupAutoRunning = false;
    return false;
  } finally {
    isRoleplayGroupBusy = false;
    roleplayGroupTalkBtnEl.disabled = false;
    roleplayGroupTalkBtnEl.textContent = 'TALK';
  }
}

function getAgentSubtitle(agent = {}) {
  if (agent?.relay === true || agent?.source === 'relay') {
    if (directChatSettings.relayShowDeviceLabels === false) return 'Relay Agent';
    return String(agent.subtitle || agent.deviceLabel || agent.relayDeviceName || 'Relay Agent');
  }
  return `Text ${String(agent.label || agent.id || 'Agent')}`;
}

function renderAgentList() {
  if (!agentListEl) return;
  const agents = getRosterWithFairy();
  agentListEl.innerHTML = agents.map((agent) => `
    <div class="dc-agent-item" data-agent-id="${agent.id}" style="--agent-color: ${agent.color || '#AA66FF'}">
      ${agent.visual?.mode === 'companion'
        ? `<canvas class="dc-agent-avatar dc-agent-avatar-canvas" data-agent-id="${escapeAttr(agent.id)}" width="42" height="42"></canvas>`
        : `<div class="dc-agent-avatar">${escapeHtml((agent.label || agent.id).charAt(0).toUpperCase())}</div>`}
      <div class="dc-agent-info">
        <div class="dc-agent-label">${escapeHtml(agent.label || agent.id)}</div>
        <div class="dc-agent-status">${escapeHtml(getAgentSubtitle(agent))}</div>
      </div>
    </div>
  `).join('');

  agentListEl.querySelectorAll('.dc-agent-item').forEach((item) => {
    item.addEventListener('click', () => openChatWithAgent(item.dataset.agentId));
  });
  agentListEl.querySelectorAll('.dc-agent-avatar-canvas').forEach((canvas) => {
    companions.mountCompanionCanvas(canvas, { agentId: canvas.dataset.agentId, state: 'idle' });
  });
  renderBackchannelStartOptions();
  renderRoleplayGroupAgentPicker();
}


function openChatPanel() {
  panelEl?.classList.add('open');
  launcherEl?.classList.add('active');
  isChatOpen = true;
  syncModeToggle();
  loadRoster();
  loadFileLibrary();
  loadDirectChatSettings().catch(() => {});
  selectedGlobalBackchannelThreadId = '';
  loadGlobalBackchannelMessages().catch(() => {});
  loadRoleplayGroups().catch(() => {});
}


function closeChatPanel() {
  showAgentList();
  panelEl?.classList.remove('open');
  launcherEl?.classList.remove('active');
  isChatOpen = false;
}

async function openChatWithAgent(agentId) {
  activeChatAgent = agentId;
  activeChatSessionId = null;
  isFileLibraryExpanded = false;
  isBackchannelExpanded = false;
  isSessionMenuOpen = false;
  if (isFairyAgent(agentId)) activeChatMode = 'agent';
  syncModeToggle();

  const agent = getAgent(agentId);
  panelEl.querySelector('.dc-agent-name').textContent = agent.label;
  panelEl.querySelector('.dc-agent-name').style.color = agent.color;
  applyAgentTheme(agent);

  const companionCanvas = panelEl.querySelector('.dc-agent-companion');
  if (agent.visual?.mode === 'companion') {
    companionCanvas?.classList.remove('hidden');
    companions.mountCompanionCanvas(companionCanvas, { agentId: agent.id, state: 'idle' });
  } else {
    companionCanvas?.classList.add('hidden');
    companionCanvas?.getContext('2d')?.clearRect(0, 0, companionCanvas.width, companionCanvas.height);
  }

  agentListEl.classList.add('hidden');
  globalBackchannelPanelEl?.classList.add('hidden');
  roleplayGroupPanelEl?.classList.add('hidden');
  roleplayGroupAreaEl?.classList.add('hidden');
  chatAreaEl.classList.remove('hidden');
  syncFileLibraryVisibility();
  syncBackchannelVisibility();
  syncSessionMenuVisibility();

  if (isFairyAgent(agentId)) {
    syncFairyLiveAgent();
    updateSessionTitle('Live call');
    renderMessages();
    renderSessionList();
  } else {
    const sessions = await loadAgentSessions(agentId);
    if (sessions.length) {
      await selectSession(sessions[0].id);
    } else {
      chatHistory[getActiveHistoryKey()] = [];
      updateSessionTitle(activeChatMode === 'roleplay' ? 'New roleplay' : 'New session');
      renderMessages();
      renderSessionList();
    }
  }

  renderFileLibrary();
  setTimeout(() => messageInputEl?.focus(), 60);
}

function showAgentList() {
  activeChatAgent = null;
  activeChatSessionId = null;
  selectedFileIds = [];
  isFileLibraryExpanded = false;
  isBackchannelExpanded = false;
  isSessionMenuOpen = false;
  applyAgentTheme(null);
  renderSelectedFiles();
  syncFileLibraryVisibility();
  syncBackchannelVisibility();
  syncSessionMenuVisibility();
  chatAreaEl?.classList.add('hidden');
  roleplayGroupAreaEl?.classList.add('hidden');
  globalBackchannelPanelEl?.classList.remove('hidden');
  roleplayGroupPanelEl?.classList.remove('hidden');
  agentListEl?.classList.remove('hidden');
  activeRoleplayGroup = null;
  isRoleplayGroupAutoRunning = false;
  syncRoleplayGroupAutoUi();
  loadGlobalBackchannelMessages().catch(() => {});
  loadRoleplayGroups().catch(() => {});
}


function getAgent(agentId) {
  const fairyAgent = fairyLive.getDirectChatAgent?.();
  if (fairyAgent && fairyAgent.id === agentId) return withResolvedAgentVisual(fairyAgent);
  const found = roster.agents?.find((a) => a.id === agentId)
    || { id: agentId, label: agentId, color: '#AA66FF', visual: companionVisuals[agentId] || { mode: 'default' } };
  return withResolvedAgentVisual(found);
}

function isFairyAgent(agentId = activeChatAgent) {
  return !!fairyLive.isDirectChatAgent?.(agentId);
}

function applyAgentTheme(agent = null) {
  if (!panelEl) return;
  const color = agent?.color || '#05d9e8';
  panelEl.style.setProperty('--dc-accent', color);
  panelEl.style.setProperty('--dc-accent-soft', `${color}24`);
  panelEl.style.setProperty('--dc-accent-border', `${color}99`);
}

function getActiveHistoryKey() {
  if (isFairyAgent()) return `fairy-live:${fairyLive.isLiveCallActive?.() ? 'active' : 'inactive'}`;
  if (activeChatSessionId) return activeChatSessionId;
  if (activeChatAgent) return `${activeChatAgent}:${activeChatMode}`;
  return `main:${activeChatMode}`;
}

function loadStoredRoleplayCustomProvider() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROLEPLAY_CUSTOM_STORAGE_KEY) || '{}');
    return {
      baseUrl: String(parsed.baseUrl || '').trim(),
      apiKey: String(parsed.apiKey || '').trim(),
      model: String(parsed.model || '').trim(),
    };
  } catch {
    return { baseUrl: '', apiKey: '', model: '' };
  }
}

function getRoleplayProvider() {
  if (selectedRoleplayModel !== ROLEPLAY_CUSTOM_MODEL) return null;
  const baseUrl = String(roleplayCustomBaseUrlEl?.value || selectedRoleplayCustomProvider.baseUrl || '').trim();
  const apiKey = String(roleplayCustomApiKeyEl?.value || selectedRoleplayCustomProvider.apiKey || '').trim();
  const model = String(roleplayCustomModelEl?.value || selectedRoleplayCustomProvider.model || '').trim();
  return { baseUrl, apiKey, model };
}

function getRoleplayModel() {
  if (selectedRoleplayModel === ROLEPLAY_CUSTOM_MODEL) return getRoleplayProvider()?.model || '';
  const model = String(selectedRoleplayModel || ROLEPLAY_MODEL).trim();
  return model || ROLEPLAY_MODEL;
}

function persistRoleplayCustomProvider() {
  selectedRoleplayCustomProvider = {
    baseUrl: String(roleplayCustomBaseUrlEl?.value || '').trim(),
    apiKey: String(roleplayCustomApiKeyEl?.value || '').trim(),
    model: String(roleplayCustomModelEl?.value || '').trim(),
  };
  localStorage.setItem(ROLEPLAY_CUSTOM_STORAGE_KEY, JSON.stringify(selectedRoleplayCustomProvider));
}

function syncRoleplayCustomInputs() {
  if (roleplayCustomBaseUrlEl) roleplayCustomBaseUrlEl.value = selectedRoleplayCustomProvider.baseUrl || '';
  if (roleplayCustomApiKeyEl) roleplayCustomApiKeyEl.value = selectedRoleplayCustomProvider.apiKey || '';
  if (roleplayCustomModelEl) roleplayCustomModelEl.value = selectedRoleplayCustomProvider.model || '';
}

function setRoleplayModel(model = ROLEPLAY_MODEL, { persist = true } = {}) {
  const value = String(model || '').trim() || ROLEPLAY_MODEL;
  selectedRoleplayModel = value;
  if (roleplayModelSelectEl && roleplayModelSelectEl.value !== value) roleplayModelSelectEl.value = value;
  if (persist) localStorage.setItem(ROLEPLAY_MODEL_STORAGE_KEY, value);
  syncModeToggle();
}

function initRoleplayModelSelect() {
  if (!roleplayModelSelectEl) return;
  roleplayModelSelectEl.innerHTML = ROLEPLAY_MODELS.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
  if (!ROLEPLAY_MODELS.some((item) => item.id === selectedRoleplayModel)) selectedRoleplayModel = ROLEPLAY_MODEL;
  syncRoleplayCustomInputs();
  setRoleplayModel(selectedRoleplayModel, { persist: false });
}

function syncRoleplayModelFromSession(sessionId = activeChatSessionId) {
  if (activeChatMode !== 'roleplay' || !activeChatAgent || !sessionId) return;
  const session = (sessionsByAgent[activeChatAgent] || []).find((item) => item.id === sessionId);
  if (session?.model) setRoleplayModel(session.model);
}

function syncModeToggle() {
  const fairyMode = isFairyAgent();
  modeToggleEls.forEach((btn) => {
    const active = (btn.dataset.chatMode || 'agent') === activeChatMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.disabled = fairyMode;
    btn.classList.toggle('hidden', fairyMode);
  });
  if (sessionMenuToggleEl) sessionMenuToggleEl.classList.toggle('hidden', fairyMode);
  if (newSessionBtnEl) newSessionBtnEl.classList.toggle('hidden', fairyMode);
  const isRoleplay = activeChatMode === 'roleplay';
  const modelWrap = panelEl?.querySelector?.('.dc-roleplay-model-wrap');
  const customWrap = panelEl?.querySelector?.('.dc-roleplay-custom');
  modelWrap?.classList.toggle('hidden', fairyMode || !isRoleplay);
  customWrap?.classList.toggle('hidden', fairyMode || !isRoleplay || selectedRoleplayModel !== ROLEPLAY_CUSTOM_MODEL);
  if (roleplayModelSelectEl) roleplayModelSelectEl.disabled = fairyMode || !isRoleplay;
}

async function setChatMode(mode = 'agent') {
  if (isFairyAgent()) return;
  const nextMode = String(mode || 'agent') === 'roleplay' ? 'roleplay' : 'agent';
  if (nextMode === activeChatMode) return;
  activeChatMode = nextMode;
  activeChatSessionId = null;
  isSessionMenuOpen = false;
  syncModeToggle();
  syncSessionMenuVisibility();
  if (!activeChatAgent) return;
  const sessions = await loadAgentSessions(activeChatAgent);
  if (sessions.length) {
    await selectSession(sessions[0].id);
  } else {
    chatHistory[getActiveHistoryKey()] = [];
    updateSessionTitle(nextMode === 'roleplay' ? 'New roleplay' : 'New session');
    renderMessages();
    renderSessionList();
  }
}

function toggleFileLibrary() {
  isFileLibraryExpanded = !isFileLibraryExpanded;
  syncFileLibraryVisibility();
}

function toggleBackchannel() {
  isBackchannelExpanded = !isBackchannelExpanded;
  syncBackchannelVisibility();
  if (isBackchannelExpanded) loadBackchannelMessages().catch(() => {});
}

function syncBackchannelVisibility() {
  if (!backchannelPanelEl || !backchannelBodyEl || !backchannelToggleEl) return;
  backchannelPanelEl.classList.toggle('collapsed', !isBackchannelExpanded);
  backchannelBodyEl.classList.toggle('hidden', !isBackchannelExpanded);
  backchannelToggleEl.setAttribute('aria-expanded', String(isBackchannelExpanded));
  const countEl = backchannelToggleEl.querySelector('.dc-backchannel-toggle-count');
  if (countEl) countEl.textContent = String(backchannelMessages.length || 0);
}

function syncGlobalBackchannelVisibility() {
  if (!globalBackchannelPanelEl || !globalBackchannelBodyEl || !globalBackchannelToggleEl) return;
  globalBackchannelPanelEl.classList.toggle('collapsed', !isGlobalBackchannelExpanded);
  globalBackchannelBodyEl.classList.toggle('hidden', !isGlobalBackchannelExpanded);
  globalBackchannelToggleEl.setAttribute('aria-expanded', String(isGlobalBackchannelExpanded));
  const countEl = globalBackchannelToggleEl.querySelector('.dc-global-backchannel-count');
  if (countEl) countEl.textContent = String(buildBackchannelConversations(globalBackchannelMessages).length || 0);
}

function toggleGlobalBackchannel() {
  isGlobalBackchannelExpanded = !isGlobalBackchannelExpanded;
  syncGlobalBackchannelVisibility();
  if (isGlobalBackchannelExpanded) {
    renderGlobalBackchannelMessages();
    loadGlobalBackchannelMessages().catch(() => {});
  }
}

async function loadGlobalBackchannelMessages() {
  if (globalBackchannelListEl && isGlobalBackchannelExpanded && !globalBackchannelMessages.length) {
    globalBackchannelListEl.innerHTML = '<div class="dc-empty dc-backchannel-empty">Loading agent conversations…</div>';
  }
  try {
    const res = await fetch(`${BASE}/api/agent-comms?limit=200`, { credentials: 'same-origin' });
    const data = res.ok ? await res.json() : { messages: [], error: `HTTP ${res.status}` };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    globalBackchannelMessages = normalizeBackchannelMessages(data.messages || []).reverse();
    const conversations = buildBackchannelConversations(globalBackchannelMessages);
    if (selectedGlobalBackchannelThreadId && !conversations.some((group) => group.id === selectedGlobalBackchannelThreadId)) selectedGlobalBackchannelThreadId = '';
    renderGlobalBackchannelMessages();
    syncGlobalBackchannelVisibility();
  } catch (err) {
    if (globalBackchannelListEl) {
      globalBackchannelListEl.innerHTML = `<div class="dc-empty dc-backchannel-empty">Could not load agent conversations: ${escapeHtml(err.message || 'unknown error')}</div>`;
    }
    syncGlobalBackchannelVisibility();
  }
}


function buildBackchannelConversations(items = []) {
  const groups = new Map();
  for (const entry of Array.isArray(items) ? items : []) {
    if (!entry?.id) continue;
    const key = entry.threadId || entry.id;
    const existing = groups.get(key) || { id: key, latest: entry, messages: [], participants: new Set() };
    existing.messages.push(entry);
    existing.participants.add(entry.fromLabel || entry.fromAgent || 'Unknown');
    existing.participants.add(entry.toLabel || entry.toAgent || 'Unknown');
    if (Date.parse(entry.createdAt || '') >= Date.parse(existing.latest?.createdAt || '')) existing.latest = entry;
    groups.set(key, existing);
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, participants: Array.from(group.participants) }))
    .sort((a, b) => Date.parse(b.latest?.createdAt || '') - Date.parse(a.latest?.createdAt || ''));
}


function renderGlobalBackchannelMessages() {
  if (!globalBackchannelListEl) return;
  globalBackchannelPanelEl?.classList.toggle('thread-open', !!selectedGlobalBackchannelThreadId);
  const conversations = buildBackchannelConversations(globalBackchannelMessages);
  const countEl = globalBackchannelToggleEl?.querySelector('.dc-global-backchannel-count');
  if (countEl) countEl.textContent = String(conversations.length || 0);
  if (!conversations.length) {
    selectedGlobalBackchannelThreadId = '';
    globalBackchannelPanelEl?.classList.remove('thread-open');
    globalBackchannelListEl.innerHTML = '<div class="dc-empty dc-backchannel-empty">No agent-to-agent conversations yet</div>';
    return;
  }
  const selected = selectedGlobalBackchannelThreadId
    ? conversations.find((group) => group.id === selectedGlobalBackchannelThreadId)
    : null;
  if (selected) {
    globalBackchannelListEl.innerHTML = renderBackchannelThreadView(selected);
    return;
  }
  globalBackchannelListEl.innerHTML = conversations.map((group) => renderBackchannelConversation(group)).join('');
}

function renderBackchannelConversation(group = {}) {
  const latest = group.latest || {};
  const names = (group.participants || []).filter(Boolean).slice(0, 4).join(' ↔ ') || `${latest.fromLabel || latest.fromAgent || 'Unknown'} ↔ ${latest.toLabel || latest.toAgent || 'Unknown'}`;
  const count = Array.isArray(group.messages) ? group.messages.length : 1;
  const scope = latest.scopeType === 'global' ? 'global' : `${latest.scopeType || 'scope'} · ${latest.scopeId || '—'}`;
  const unread = (group.messages || []).some((entry) => entry.toAgent && !(entry.readBy || []).includes(entry.toAgent));
  return `
    <button class="dc-backchannel-convo ${unread ? 'unread' : ''}" type="button" data-thread-id="${escapeAttr(group.id || '')}">
      <div class="dc-backchannel-line">
        <strong>${escapeHtml(names)}</strong>
        <span class="dc-backchannel-time">${escapeHtml(formatBackchannelDate(latest.createdAt))}</span>
      </div>
      <div class="dc-backchannel-pills">
        <span>${count} msg${count === 1 ? '' : 's'}</span>
        <span>${escapeHtml(scope)}</span>
        ${latest.threadId ? '<span>thread</span>' : ''}
        ${unread ? '<span>unread</span>' : ''}
      </div>
      <div class="dc-backchannel-text"><strong>${escapeHtml(latest.fromLabel || latest.fromAgent || 'Unknown')}:</strong> ${escapeHtml(latest.text || '')}</div>
    </button>
  `;
}

function renderBackchannelThreadView(group = {}) {
  const messages = [...(group.messages || [])].sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
  const names = (group.participants || []).filter(Boolean).slice(0, 4).join(' ↔ ') || 'Agent conversation';
  return `
    <div class="dc-backchannel-thread-view">
      <div class="dc-backchannel-thread-header">
        <button class="dc-backchannel-thread-back" type="button">← Conversations</button>
        <div class="dc-backchannel-thread-title">${escapeHtml(names)}</div>
      </div>
      <div class="dc-backchannel-thread-messages">
        ${messages.map((entry, index) => renderBackchannelBubble(entry, index, messages)).join('')}
      </div>
    </div>
  `;
}

function renderBackchannelBubble(entry = {}, index = 0, messages = []) {
  const prev = messages[index - 1] || null;
  const isAstra = String(entry.fromAgent || '').toLowerCase() === 'orchestrator' || String(entry.fromLabel || '').toLowerCase() === 'astra';
  const sameAsPrev = prev && prev.fromAgent === entry.fromAgent;
  const classes = ['dc-backchannel-bubble', isAstra ? 'astra' : 'other'];
  if (sameAsPrev) classes.push('grouped-prev');
  return `
    <div class="${classes.join(' ')}">
      ${sameAsPrev ? '' : `<div class="dc-backchannel-bubble-top"><strong>${escapeHtml(entry.fromLabel || entry.fromAgent || 'Unknown')}</strong><span>${escapeHtml(formatBackchannelDate(entry.createdAt))}</span></div>`}
      <div class="dc-backchannel-bubble-text">${escapeHtml(entry.text || '')}</div>
    </div>
  `;
}

function renderBackchannelEntry(entry = {}) {
  const scope = entry.scopeType === 'global' ? 'global' : `${entry.scopeType || 'scope'} · ${entry.scopeId || '—'}`;
  const unread = entry.toAgent && !(entry.readBy || []).includes(entry.toAgent);
  return `
    <div class="dc-backchannel-item ${unread ? 'unread' : ''}">
      <div class="dc-backchannel-line">
        <strong>${escapeHtml(entry.fromLabel || entry.fromAgent || 'Unknown')}</strong>
        <span>→</span>
        <strong>${escapeHtml(entry.toLabel || entry.toAgent || 'Unknown')}</strong>
        <span class="dc-backchannel-time">${escapeHtml(formatBackchannelDate(entry.createdAt))}</span>
      </div>
      <div class="dc-backchannel-pills">
        <span>${escapeHtml(entry.type || 'note')}</span>
        <span>${escapeHtml(scope)}</span>
        ${entry.threadId ? `<span>thread</span>` : ''}
        ${entry.replyToId ? `<span>reply</span>` : ''}
        ${unread ? '<span>unread</span>' : ''}
      </div>
      <div class="dc-backchannel-text">${escapeHtml(entry.text || '')}</div>
    </div>
  `;
}

function normalizeBackchannelMessages(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter((entry) => entry?.id && !seen.has(entry.id) && seen.add(entry.id))
    .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''))
    .slice(-80);
}

async function loadBackchannelMessages() {
  if (!activeChatAgent || isFairyAgent()) {
    backchannelMessages = [];
    renderBackchannelMessages();
    syncBackchannelVisibility();
    return;
  }
  try {
    const [incomingRes, outgoingRes] = await Promise.all([
      fetch(`${BASE}/api/agent-comms?toAgent=${encodeURIComponent(activeChatAgent)}&limit=80`),
      fetch(`${BASE}/api/agent-comms?fromAgent=${encodeURIComponent(activeChatAgent)}&limit=80`),
    ]);
    const incoming = incomingRes.ok ? await incomingRes.json() : { messages: [] };
    const outgoing = outgoingRes.ok ? await outgoingRes.json() : { messages: [] };
    backchannelMessages = normalizeBackchannelMessages([...(incoming.messages || []), ...(outgoing.messages || [])]);
    renderBackchannelMessages();
    syncBackchannelVisibility();
  } catch (_) {}
}

function renderBackchannelMessages() {
  if (!backchannelListEl) return;
  if (!backchannelMessages.length) {
    backchannelListEl.innerHTML = '<div class="dc-empty dc-backchannel-empty">No agent-to-agent messages for this agent yet</div>';
    return;
  }
  backchannelListEl.innerHTML = backchannelMessages.slice().reverse().map((entry) => renderBackchannelEntry(entry)).join('');
}

function formatBackchannelDate(value = '') {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return 'unknown';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function syncFileLibraryVisibility() {
  if (!filePanelEl || !filePanelBodyEl || !filePanelToggleEl) return;
  filePanelEl.classList.toggle('collapsed', !isFileLibraryExpanded);
  filePanelBodyEl.classList.toggle('hidden', !isFileLibraryExpanded);
  filePanelToggleEl.setAttribute('aria-expanded', String(isFileLibraryExpanded));
  const countEl = filePanelToggleEl.querySelector('.dc-files-toggle-count');
  if (countEl) countEl.textContent = String(fileLibrary.length || 0);
}

function toggleSessionMenu() {
  isSessionMenuOpen = !isSessionMenuOpen;
  renderSessionList(sessionSearchEl?.value || '');
  syncSessionMenuVisibility();
}

function syncSessionMenuVisibility() {
  if (!sessionMenuEl || !sessionMenuToggleEl) return;
  sessionMenuEl.classList.toggle('hidden', !isSessionMenuOpen);
  sessionMenuToggleEl.setAttribute('aria-expanded', String(isSessionMenuOpen));
}

function ensureHistory(key) {
  if (!chatHistory[key]) chatHistory[key] = [];
  return chatHistory[key];
}

function addMessage(key, message) {
  const history = ensureHistory(key);
  history.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, timestamp: Date.now(), ...message });
  if (history.length > 120) history.splice(0, history.length - 120);
}

function removeTypingMessage(key) {
  const history = ensureHistory(key);
  const idx = history.findIndex((entry) => entry.role === 'agent' && entry.kind === 'typing');
  if (idx !== -1) history.splice(idx, 1);
}

function getFairyHistory() {
  const base = (fairyLive.getTranscriptMessages?.() || []).map((msg) => ({
    id: msg.id,
    role: msg.role === 'user' ? 'user' : 'agent',
    kind: msg.role === 'error' ? 'error' : 'text',
    text: String(msg.text || ''),
    timestamp: Number(msg.timestamp || Date.now()),
    meta: msg.meta || '',
    files: [],
  }));
  const local = (chatHistory[getActiveHistoryKey()] || []).filter((msg) => msg.kind === 'typing' || msg.kind === 'error');
  return [...base, ...local];
}

function renderMessages() {
  hideMessageActionMenu();
  if (!activeChatAgent || !chatAreaEl) return;
  const container = chatAreaEl.querySelector('.dc-messages');
  const messages = isFairyAgent() ? getFairyHistory() : (chatHistory[getActiveHistoryKey()] || []);

  if (!messages.length) {
    container.innerHTML = '<div class="dc-empty">Send a message to start the conversation</div>';
    return;
  }

  container.innerHTML = messages.map((msg, index) => renderMessage(msg, index, messages)).join('');
  container.scrollTop = container.scrollHeight;
}

function formatEventSourceLabel(data = {}) {
  const source = String(data?.source || '').trim();
  const platform = String(data?.platform || '').trim();
  const relayDevice = String(data?.relayDeviceName || data?.deviceLabel || '').trim();
  if (!source) return '';
  if (source === 'direct-chat') {
    if (relayDevice && directChatSettings.relayShowDeviceLabels !== false) return `Direct Chat · ${relayDevice}`;
    return 'Direct Chat';
  }
  if (source === 'hermes-session-monitor') return platform ? `Hermes · ${platform}` : 'Hermes';
  if (source === 'session-monitor') return 'OpenClaw';
  return platform ? `${source} · ${platform}` : source;
}

function renderMessage(msg, index = 0, messages = []) {
  const isRegenerating = msg.kind === 'regenerating';
  const isUser = msg.role === 'user';
  const prev = messages[index - 1] || null;
  const next = messages[index + 1] || null;
  const isGroupedWithPrev = !!prev && prev.role === msg.role && prev.kind === msg.kind;
  const isGroupedWithNext = !!next && next.role === msg.role && next.kind === msg.kind;

  const classes = ['dc-message', isUser ? 'dc-message-user' : 'dc-message-agent'];
  if (msg.kind === 'tool') classes.push('dc-message-tool');
  if (msg.kind === 'typing') classes.push('dc-message-typing');
  if (msg.kind === 'file') classes.push('dc-message-file');
  if (msg.kind === 'error') classes.push('dc-message-tool');
  if (isRegenerating) classes.push('dc-message-typing', 'is-regenerating');
  if (isGroupedWithPrev) classes.push('dc-message-grouped-prev');
  if (isGroupedWithNext) classes.push('dc-message-grouped-next');

  const label = msg.kind === 'tool'
    ? 'Tool'
    : msg.kind === 'error'
      ? 'Error'
      : (isUser ? 'You' : (activeChatMode === 'roleplay' ? `${getAgent(activeChatAgent || 'main').label || 'Assistant'} · RP` : (getAgent(activeChatAgent || 'main').label || 'Assistant')));

  const canSpeak = !isUser && !isRegenerating && msg.kind !== 'typing' && msg.kind !== 'tool' && msg.kind !== 'file' && String(msg.text || '').trim();
  const canAct = activeChatMode === 'roleplay' && !isRegenerating && msg.role === 'agent' && msg.kind !== 'typing' && msg.kind !== 'tool' && msg.kind !== 'file' && msg.kind !== 'error' && String(msg.text || '').trim();
  const latestEligibleId = getLatestEligibleDirectMessageId(messages);
  const alwaysVisible = canAct && String(msg.id || '') === String(latestEligibleId || '');
  const regenPending = isActionPending('direct-regenerate', String(msg.id || ''));
  const branchPending = isActionPending('direct-branch', String(msg.id || ''));
  const speakButton = canSpeak
    ? `<button class="dc-message-speak" type="button" data-message-id="${escapeAttr(msg.id || '')}" title="Speak again" aria-label="Speak this message again">▶</button>`
    : '';
  const actionButtons = canAct ? `<div class="dc-message-actions ${alwaysVisible ? 'always-visible' : ''}"><button class="dc-message-action" type="button" data-action="regenerate" data-message-id="${escapeAttr(msg.id || '')}" title="Regenerate from this message" ${regenPending || branchPending ? 'disabled' : ''}>${regenPending ? '…' : '↻ Regenerate'}</button><button class="dc-message-action" type="button" data-action="branch" data-message-id="${escapeAttr(msg.id || '')}" title="Create branch from this message" ${regenPending || branchPending ? 'disabled' : ''}>${branchPending ? '…' : '⑂ Branch'}</button></div>` : '';
  const body = msg.kind === 'typing'
    ? '<div class="dc-message-text"><div class="dc-typing"><span></span><span></span><span></span></div></div>'
    : isRegenerating
      ? '<div class="dc-message-text dc-msg-regenerating"><div class="dc-typing"><span></span><span></span><span></span></div><span>Regenerating response…</span></div>'
      : `<div class="dc-message-text-block"><div class="dc-message-body-row"><div class="dc-message-text">${renderImmersionText(msg.text || '')}</div>${speakButton}</div>${actionButtons}</div>`;

  const attachments = Array.isArray(msg.files) && msg.files.length
    ? `<div class="dc-message-files">${msg.files.map(renderAttachedBadge).join('')}</div>`
    : '';

  const metaLine = !isGroupedWithPrev && msg.meta
    ? `<div class="dc-message-meta" style="font-size:11px; color:var(--text-dim); margin-top:2px; margin-bottom:4px;">${escapeHtml(msg.meta)}</div>`
    : '';

  return `
    <div class="${classes.join(' ')} ${alwaysVisible ? 'has-persistent-actions' : ''}" data-message-id="${escapeAttr(msg.id || '')}" data-message-kind="${canAct ? 'direct-roleplay-agent' : ''}">
      ${isGroupedWithPrev ? '' : `<div class="dc-message-topline">
        <div class="dc-message-name">${escapeHtml(label)}</div>
        <div class="dc-message-time">${formatTime(msg.timestamp)}</div>
      </div>`}
      ${metaLine}
      ${body}
      ${attachments}
      ${isGroupedWithPrev ? `<div class="dc-message-time dc-message-time-inline">${formatTime(msg.timestamp)}</div>` : ''}
    </div>
  `;
}

async function speakDirectMessage(messageId = '') {
  const history = chatHistory[getActiveHistoryKey()] || [];
  const msg = history.find((entry) => String(entry.id || '') === String(messageId || ''));
  const text = String(msg?.text || '').trim();
  if (!text) return;
  const agentId = activeChatAgent || 'main';
  const button = panelEl?.querySelector(`.dc-message-speak[data-message-id="${CSS.escape(String(messageId || ''))}"]`);
  try {
    if (button) {
      button.disabled = true;
      button.classList.add('is-playing');
      button.textContent = '■';
    }
    await voice.playSpokenResponse(text, agentId, { force: true });
  } catch (err) {
    terminal.log(`[voice] ${err.message || 'Replay failed.'}`, 'error', true);
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-playing');
      button.textContent = '▶';
    }
  }
}

async function regenerateDirectRoleplayMessage(messageId = '') {
  if (!activeChatSessionId || activeChatMode !== 'roleplay' || !messageId || isActionPending('direct-regenerate', messageId)) return false;
  const latestId = getLatestEligibleDirectMessageId(chatHistory[getActiveHistoryKey()] || []);
  if (latestId && latestId !== messageId) {
    const ok = window.confirm('Regenerate from here? This will replace this message and remove later messages in the current timeline.');
    if (!ok) return false;
  }
  const history = chatHistory[getActiveHistoryKey()] || [];
  const sourceMessage = history.find((entry) => String(entry.id || '') === String(messageId || '')) || null;
  const rollbackMessages = truncateDirectMessagesAt(messageId);
  const key = getActiveHistoryKey();
  chatHistory[key] = [
    ...(chatHistory[key] || []),
    {
      id: `regen_pending_${messageId}`,
      kind: 'regenerating',
      role: 'agent',
      text: '',
      timestamp: Date.now(),
      meta: sourceMessage?.meta || '',
    },
  ];
  setActionPending('direct-regenerate', messageId);
  renderMessages();
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${encodeURIComponent(activeChatSessionId)}/regenerate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, model: getRoleplayModel(), roleplayProvider: getRoleplayProvider() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not regenerate message');
    await loadSessionMessages(activeChatSessionId);
    await loadAgentSessions(activeChatAgent);
    renderMessages();
    renderSessionList(sessionSearchEl?.value || '');
    if (directChatSettings.roleplayAutoSpeak !== false && data.response?.text) {
      voice.playSpokenResponse(String(data.response.text || '').trim(), activeChatAgent, { force: true }).catch((err) => terminal.log(`[voice] ${err.message || 'Auto-play failed.'}`, 'error', true));
    }
    return true;
  } catch (err) {
    if (rollbackMessages) chatHistory[getActiveHistoryKey()] = rollbackMessages;
    terminal.log(`[chat] ${err.message || 'Could not regenerate message.'}`, 'error', true);
    return false;
  } finally {
    clearActionPending();
    renderMessages();
  }
}

async function branchDirectRoleplayMessage(messageId = '') {
  if (!activeChatSessionId || activeChatMode !== 'roleplay' || !messageId || isActionPending('direct-branch', messageId)) return false;
  setActionPending('direct-branch', messageId);
  renderMessages();
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${encodeURIComponent(activeChatSessionId)}/branch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not create branch');
    await loadAgentSessions(activeChatAgent);
    await selectSession(data.session?.id || '');
    return true;
  } catch (err) {
    terminal.log(`[chat] ${err.message || 'Could not create branch.'}`, 'error', true);
    return false;
  } finally {
    clearActionPending();
    renderMessages();
  }
}

function hideMessageActionMenu() {
  cancelTouchLongPress();
  longPressTarget = null;
  if (!messageActionMenuEl) return;
  messageActionMenuEl.classList.add('hidden');
  messageActionMenuEl.innerHTML = '';
}

function showMessageActionMenu({ type = '', messageId = '', x = 0, y = 0 } = {}) {
  if (!messageActionMenuEl || !messageId) return;
  longPressTarget = { type, messageId };
  messageActionMenuEl.innerHTML = `<button class="dc-message-action-menu-btn" type="button" data-action="regenerate">Regenerate</button><button class="dc-message-action-menu-btn" type="button" data-action="branch">Branch</button>`;
  const rect = panelEl?.getBoundingClientRect?.() || { left: 0, top: 0, width: 320, height: 500 };
  messageActionMenuEl.style.left = `${Math.max(8, Math.min((x - rect.left) - 80, rect.width - 168))}px`;
  messageActionMenuEl.style.top = `${Math.max(8, Math.min((y - rect.top) - 8, rect.height - 104))}px`;
  messageActionMenuEl.classList.remove('hidden');
}

function cancelTouchLongPress() {
  if (longPressTimer) window.clearTimeout(longPressTimer);
  longPressTimer = null;
}

function handleTouchLongPressStart(event) {
  if (!event.touches?.length) return;
  const target = event.target?.closest?.('[data-message-kind="roleplay-agent"], [data-message-kind="direct-roleplay-agent"]');
  if (!target) return;
  const type = target.dataset.messageKind === 'roleplay-agent' ? 'group' : 'direct';
  const messageId = target.dataset.messageId || '';
  const touch = event.touches[0];
  cancelTouchLongPress();
  longPressTimer = window.setTimeout(() => {
    showMessageActionMenu({ type, messageId, x: touch.clientX, y: touch.clientY });
  }, 520);
}

function renderAttachedBadge(file) {
  return `<span class="dc-file-pill">${escapeHtml(file.name || file.originalName || 'file')}</span>`;
}

function renderSelectedFiles() {
  if (!selectedFilesEl) return;
  if (!selectedFileIds.length) {
    selectedFilesEl.innerHTML = '';
    syncFileLibraryVisibility();
    return;
  }
  const files = selectedFileIds.map((id) => fileLibrary.find((item) => item.id === id)).filter(Boolean);
  selectedFilesEl.innerHTML = files.map((file) => `
    <button class="dc-selected-pill" data-file-id="${file.id}" type="button">
      ${escapeHtml(file.name || file.originalName || 'file')}
      <span>×</span>
    </button>
  `).join('');
  selectedFilesEl.querySelectorAll('.dc-selected-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFileIds = selectedFileIds.filter((id) => id !== btn.dataset.fileId);
      renderSelectedFiles();
      renderFileLibrary();
    });
  });
  syncFileLibraryVisibility();
}

function renderFileLibrary() {
  if (!fileListEl) return;
  const items = fileLibrary || [];
  if (!items.length) {
    fileListEl.innerHTML = '<div class="dc-empty dc-files-empty">No saved files yet</div>';
    renderSelectedFiles();
    syncFileLibraryVisibility();
    return;
  }

  fileListEl.innerHTML = items.map((item) => {
    const selected = selectedFileIds.includes(item.id);
    return `
      <div class="dc-file-item ${selected ? 'selected' : ''}" data-file-id="${item.id}">
        <div class="dc-file-main">
          <button class="dc-file-toggle" type="button">${selected ? 'REMOVE' : 'USE'}</button>
          <div class="dc-file-meta">
            <div class="dc-file-name">${escapeHtml(item.name || item.originalName || 'file')}</div>
            <div class="dc-file-sub">${escapeHtml(item.kind === 'link' ? (item.sourceUrl || 'link') : `${formatBytes(item.size)} • ${item.mimeType || 'file'}`)}</div>
          </div>
        </div>
        <div class="dc-file-actions">
          <a class="dc-file-link" href="${escapeAttr(item.downloadUrl)}" target="_blank" rel="noopener noreferrer">OPEN</a>
          <button class="dc-file-delete" type="button">DELETE</button>
        </div>
      </div>
    `;
  }).join('');

  fileListEl.querySelectorAll('.dc-file-item').forEach((row) => {
    const id = row.dataset.fileId;
    row.querySelector('.dc-file-toggle')?.addEventListener('click', () => toggleSelectedFile(id));
    row.querySelector('.dc-file-delete')?.addEventListener('click', () => deleteFile(id));
  });

  renderSelectedFiles();
  syncFileLibraryVisibility();
}

function toggleSelectedFile(id) {
  if (selectedFileIds.includes(id)) selectedFileIds = selectedFileIds.filter((value) => value !== id);
  else selectedFileIds = [...selectedFileIds, id];
  renderSelectedFiles();
  renderFileLibrary();
}

async function uploadFiles() {
  const files = Array.from(fileInputEl?.files || []);
  if (!files.length) return;

  const form = new FormData();
  files.forEach((file) => form.append('files', file, file.name));

  try {
    const res = await fetch(`${BASE}/api/chat/files/upload`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    fileLibrary = [...(data.items || []), ...fileLibrary];
    selectedFileIds = [...new Set([...selectedFileIds, ...(data.items || []).map((item) => item.id)])];
    renderFileLibrary();
    terminal.log(`[chat] Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`, 'info', true);
  } catch (err) {
    terminal.log(`[chat] Upload failed: ${err.message}`, 'error', true);
  } finally {
    if (fileInputEl) fileInputEl.value = '';
  }
}

async function saveLink() {
  const url = String(linkUrlEl?.value || '').trim();
  const name = String(linkNameEl?.value || '').trim();
  const notes = String(linkNotesEl?.value || '').trim();
  if (!url) return;
  try {
    const res = await fetch(`${BASE}/api/chat/files/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name, notes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save link');
    if (data.item) {
      fileLibrary = [data.item, ...fileLibrary];
      selectedFileIds = [...new Set([...selectedFileIds, data.item.id])];
      renderFileLibrary();
    }
    linkNameEl.value = '';
    linkUrlEl.value = '';
    linkNotesEl.value = '';
  } catch (err) {
    terminal.log(`[chat] Link save failed: ${err.message}`, 'error', true);
  }
}

async function deleteFile(id) {
  try {
    const res = await fetch(`${BASE}/api/chat/files/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    fileLibrary = fileLibrary.filter((item) => item.id !== id);
    selectedFileIds = selectedFileIds.filter((value) => value !== id);
    renderFileLibrary();
  } catch (err) {
    terminal.log(`[chat] Delete failed: ${err.message}`, 'error', true);
  }
}

function getSessionLabel(session = null) {
  if (!session) return activeChatMode === 'roleplay' ? 'Roleplay' : 'Latest';
  return String(session.title || session.lastMessagePreview || 'Untitled session').trim().slice(0, 36) || 'Untitled session';
}

function formatSessionMeta(session = {}) {
  const count = Number(session.messageCount || 0);
  const updated = session.updatedAt
    ? new Date(session.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'new';
  return `${count} msg${count === 1 ? '' : 's'} • ${updated}`;
}

function updateSessionTitle(label = '') {
  if (!sessionTitleEl) return;
  const session = (sessionsByAgent[activeChatAgent] || []).find((item) => item.id === activeChatSessionId);
  sessionTitleEl.textContent = label || getSessionLabel(session) || 'Latest';
}

function renderSessionList(query = '') {
  if (!sessionListEl || !activeChatAgent) return;
  if (isFairyAgent()) {
    sessionListEl.innerHTML = '<div class="dc-empty dc-session-empty">Fairy Live uses the current call transcript</div>';
    return;
  }
  const needle = String(query || '').trim().toLowerCase();
  const sessions = (sessionsByAgent[activeChatAgent] || []).filter((session) => {
    if (!needle) return true;
    return `${session.title || ''} ${session.lastMessagePreview || ''}`.toLowerCase().includes(needle);
  });

  if (!sessions.length) {
    sessionListEl.innerHTML = '<div class="dc-empty dc-session-empty">No saved sessions yet</div>';
    return;
  }

  sessionListEl.innerHTML = sessions.map((session) => `
    <button class="dc-session-item ${session.id === activeChatSessionId ? 'active' : ''}" data-session-id="${escapeAttr(session.id)}" type="button">
      <span class="dc-session-item-title">${escapeHtml(getSessionLabel(session))}</span>
      <span class="dc-session-item-meta">${escapeHtml(formatSessionMeta(session))}</span>
    </button>
  `).join('');

  sessionListEl.querySelectorAll('.dc-session-item').forEach((btn) => {
    btn.addEventListener('click', () => selectSession(btn.dataset.sessionId));
  });
}

async function selectSession(sessionId) {
  if (!sessionId) return;
  activeChatSessionId = sessionId;
  syncRoleplayModelFromSession(sessionId);
  await loadSessionMessages(sessionId);
  updateSessionTitle();
  renderMessages();
  renderSessionList(sessionSearchEl?.value || '');
  isSessionMenuOpen = false;
  syncSessionMenuVisibility();
}

async function createNewSession() {
  if (!activeChatAgent || isFairyAgent() || isCreatingSession) return;
  isCreatingSession = true;
  if (newSessionBtnEl) {
    newSessionBtnEl.disabled = true;
    newSessionBtnEl.setAttribute('aria-busy', 'true');
  }
  try {
    const res = await fetch(`${BASE}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: activeChatAgent,
        title: '',
        mode: activeChatMode,
        model: activeChatMode === 'roleplay' ? getRoleplayModel() : '',
        roleplayProvider: activeChatMode === 'roleplay' ? getRoleplayProvider() : null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to create session');
    if (!sessionsByAgent[activeChatAgent]) sessionsByAgent[activeChatAgent] = [];
    sessionsByAgent[activeChatAgent] = [data.session, ...sessionsByAgent[activeChatAgent].filter((item) => item.id !== data.session.id)];
    activeChatSessionId = data.session.id;
    chatHistory[activeChatSessionId] = [];
    updateSessionTitle(activeChatMode === 'roleplay' ? 'New roleplay' : 'New session');
    renderMessages();
    renderSessionList(sessionSearchEl?.value || '');
    isSessionMenuOpen = false;
    syncSessionMenuVisibility();
    messageInputEl?.focus();
  } catch (err) {
    terminal.log(`[chat] New session failed: ${err.message}`, 'error', true);
  } finally {
    isCreatingSession = false;
    if (newSessionBtnEl) {
      newSessionBtnEl.disabled = false;
      newSessionBtnEl.removeAttribute('aria-busy');
    }
  }
}

async function sendMessage() {
  if (!activeChatAgent) return;
  const text = String(messageInputEl?.value || '').trim();
  if (!text) return;

  const historyKey = getActiveHistoryKey();
  const fairyMode = isFairyAgent();
  const files = selectedFileIds.map((id) => fileLibrary.find((item) => item.id === id)).filter(Boolean);
  if (!fairyMode) addMessage(historyKey, { role: 'user', text, kind: 'text', files });
  addMessage(historyKey, { role: 'agent', kind: 'typing', text: '' });
  pendingByAgent[activeChatAgent] = true;
  messageInputEl.value = '';
  renderMessages();

  if (!fairyMode && activeChatMode === 'roleplay' && selectedRoleplayModel === ROLEPLAY_CUSTOM_MODEL) {
    persistRoleplayCustomProvider();
    const provider = getRoleplayProvider();
    if (!provider?.baseUrl || !provider?.model) {
      removeTypingMessage(historyKey);
      pendingByAgent[activeChatAgent] = false;
      renderMessages();
      terminal.log('[chat] Custom roleplay model requires a base URL and model ID.', 'error', true);
      return;
    }
  }

  const agentLabel = getAgent(activeChatAgent).label;
  const modeLabel = fairyMode ? 'fairy-live' : (activeChatMode === 'roleplay' ? `roleplay:${getRoleplayModel()}` : 'agent');
  terminal.log(`[you → ${agentLabel} (${modeLabel})] ${text}`, 'agent', true);

  try {
    if (fairyMode) {
      await fairyLive.sendDirectChatMessage?.(text);
      pendingByAgent[activeChatAgent] = false;
      removeTypingMessage(historyKey);
      renderMessages();
      return;
    }

    const roleplayProvider = activeChatMode === 'roleplay' ? getRoleplayProvider() : null;
    const payload = activeChatSessionId
      ? { message: text, sessionId: activeChatSessionId, fileIds: selectedFileIds, mode: activeChatMode, model: activeChatMode === 'roleplay' ? getRoleplayModel() : '', roleplayProvider }
      : { message: text, agent: activeChatAgent, fileIds: selectedFileIds, mode: activeChatMode, model: activeChatMode === 'roleplay' ? getRoleplayModel() : '', roleplayProvider };

    const res = await fetch(`${BASE}/api/chat/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to send');

    if (data.session?.id) {
      activeChatSessionId = data.session.id;
      await loadAgentSessions(activeChatAgent);
      updateSessionTitle();
    }

    if (data.message?.id && data.response?.id) {
      const activeKey = getActiveHistoryKey();
      const history = ensureHistory(activeKey);
      if (history.length >= 2) {
        history[history.length - 2] = {
          id: data.message.id,
          role: 'user',
          kind: 'text',
          text,
          timestamp: data.message.timestamp ? new Date(data.message.timestamp).getTime() : history[history.length - 2].timestamp,
          files,
        };
        history[history.length - 1] = {
          id: data.response.id,
          role: 'agent',
          kind: 'text',
          text: data.response.text || '',
          timestamp: data.response.timestamp ? new Date(data.response.timestamp).getTime() : Date.now(),
          files: Array.isArray(data.response.meta?.files) ? data.response.meta.files : [],
          meta: history[history.length - 1]?.meta || '',
        };
      }
      renderMessages();
      renderSessionList(sessionSearchEl?.value || '');
      if (activeChatMode === 'roleplay') {
        const responseText = String(data.response?.text || '').trim();
        if (responseText && shouldAutoSpeakRoleplayVoice()) {
          voice.playSpokenResponse(responseText, activeChatAgent, { force: true }).catch((err) => {
            terminal.log(`[voice] ${err.message || 'Auto-play failed.'}`, 'error', true);
          });
        }
      }
    }
  } catch (err) {
    pendingByAgent[activeChatAgent] = false;
    removeTypingMessage(historyKey);
    addMessage(historyKey, { role: 'agent', text: `Error: ${err.message}`, kind: 'error' });
    renderMessages();
    terminal.log(`[chat] Error: ${err.message}`, 'error', true);
  }
}

function syncFairyLiveAgent(detail = {}) {
  const reason = String(detail?.reason || 'update');
  const fairyActive = typeof detail?.active === 'boolean'
    ? detail.active
    : !!fairyLive.isLiveCallActive?.();
  const availabilityChanged = lastFairyLiveActive !== fairyActive;
  lastFairyLiveActive = fairyActive;
  if (!isChatOpen) return;
  if (reason === 'status' && !availabilityChanged) return;
  if (reason === 'transcript' || reason === 'assistant-commit') {
    if (activeChatAgent && isFairyAgent(activeChatAgent)) renderMessages();
    return;
  }
  renderAgentList();
  if (!activeChatAgent || !isFairyAgent(activeChatAgent)) return;
  updateSessionTitle('Live call');
  renderSessionList();
  renderMessages();
}

function scheduleFairyMessageRender() {
  if (fairyMessageRenderTimer || !isChatOpen) return;
  fairyMessageRenderTimer = setTimeout(() => {
    fairyMessageRenderTimer = null;
    if (isChatOpen && activeChatAgent && isFairyAgent(activeChatAgent)) renderMessages();
  }, 120);
}

export function handleChatEvent(msg) {
  const { type, data } = msg || {};

  if (type === 'agent_comms:message' || type === 'agent_comms:read') {
    loadBackchannelMessages().catch(() => {});
    loadGlobalBackchannelMessages().catch(() => {});
    return;
  }

  if (isFairyAgent(activeChatAgent)) {
    const historyKey = getActiveHistoryKey();
    if (type === 'call:transcript.final' && data?.sessionId) {
      removeTypingMessage(historyKey);
      addMessage(historyKey, { role: 'agent', kind: 'typing', text: '' });
      pendingByAgent[activeChatAgent] = true;
      renderMessages();
      return;
    }
    if (type === 'call:response.text' && data?.sessionId) {
      if (data.done) {
        pendingByAgent[activeChatAgent] = false;
        removeTypingMessage(historyKey);
        renderMessages();
      } else {
        scheduleFairyMessageRender();
      }
      return;
    }
    if (type === 'call:assistant.interrupted' || type === 'call:error' || type === 'call:session.ended') {
      pendingByAgent[activeChatAgent] = false;
      removeTypingMessage(historyKey);
      renderMessages();
      return;
    }
  }

  const agentId = data?.agent;
  if (!agentId) return;
  if (agentId !== activeChatAgent) return;

  const isDirectChatEvent = data?.chat === true || data?.source === 'direct-chat';
  const isExternalAgentEvent = !isDirectChatEvent && (data?.source === 'hermes-session-monitor' || data?.source === 'session-monitor');
  if (!isDirectChatEvent && !isExternalAgentEvent) return;
  if (isDirectChatEvent && !pendingByAgent[agentId]) return;
  if (data?.sessionId && activeChatSessionId && data.sessionId !== activeChatSessionId) return;

  const historyKey = getActiveHistoryKey();
  const sourceMeta = formatEventSourceLabel(data);

  if (type === 'agent:thinking') {
    if (isDirectChatEvent && agentId === activeChatAgent) renderMessages();
    return;
  }

  if (type === 'agent:tool_use') {
    if (isDirectChatEvent) removeTypingMessage(historyKey);
    addMessage(historyKey, {
      role: 'agent',
      kind: 'tool',
      text: `${data.tool || 'tool'}(${shortenToolInput(data.input)})`,
      meta: sourceMeta,
    });
    if (isDirectChatEvent) addMessage(historyKey, { role: 'agent', kind: 'typing', text: '' });
    if (agentId === activeChatAgent) renderMessages();
    return;
  }

  if (type === 'agent:responding' && data?.message) {
    if (isDirectChatEvent) pendingByAgent[agentId] = false;
    removeTypingMessage(historyKey);
    const history = ensureHistory(historyKey);
    const last = history[history.length - 1];
    if (!last || last.text !== data.message || last.kind === 'typing') {
      addMessage(historyKey, { role: 'agent', kind: 'text', text: data.message, meta: sourceMeta });
    }
    if (agentId === activeChatAgent) renderMessages();
    return;
  }

  if (type === 'agent:error') {
    if (isDirectChatEvent) pendingByAgent[agentId] = false;
    removeTypingMessage(historyKey);
    addMessage(historyKey, { role: 'agent', kind: 'error', text: `Error: ${data.message || 'Unknown error'}`, meta: sourceMeta });
    if (agentId === activeChatAgent) renderMessages();
  }
}

function shortenToolInput(input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderImmersionText(value = '') {
  const source = String(value || '');
  const placeholders = [];
  const stash = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let text = escapeHtml(source);
  text = text.replace(/`([^`\n]+?)`/g, (_, content) => stash(`<code class="dc-immersion-code">${content}</code>`));
  text = text.replace(/\*\*\*([\s\S]+?)\*\*\*/g, (_, content) => stash(`<strong class="dc-immersion-strong"><em class="dc-immersion-action dc-immersion-action-strong">${content}</em></strong>`));
  text = text.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, (_, content) => stash(`<strong class="dc-immersion-strong">${content}</strong>`));
  text = text.replace(/(^|[\s([{“"'—-])\*([^*\n][\s\S]*?[^*\n])\*(?=$|[\s.,!?;:)}\]”"'—-])/g, (match, prefix, content) => `${prefix}${stash(`<em class="dc-immersion-action">${content}</em>`)}`);
  text = text.replace(/\n/g, '<br>');

  return placeholders.reduce((html, replacement, index) => html.replaceAll(`\u0000${index}\u0000`, replacement), text);
}

function escapeAttr(text) {
  return escapeHtml(String(text || '')).replace(/"/g, '&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function setRoster(nextRoster = { agents: [], primaryAgentId: 'main' }) {
  roster = nextRoster || { agents: [], primaryAgentId: 'main' };
  renderAgentList();
  if (activeChatAgent) {
    const agent = getAgent(activeChatAgent);
    const companionCanvas = panelEl?.querySelector('.dc-agent-companion');
    applyAgentTheme(agent);
    if (panelEl?.querySelector('.dc-agent-name')) {
      panelEl.querySelector('.dc-agent-name').textContent = agent.label;
      panelEl.querySelector('.dc-agent-name').style.color = agent.color;
    }
    if (agent.visual?.mode === 'companion') {
      companionCanvas?.classList.remove('hidden');
      companions.mountCompanionCanvas(companionCanvas, { agentId: agent.id, state: 'idle' });
    } else {
      companionCanvas?.classList.add('hidden');
    }
  }
}

export function setCompanionData(visuals = {}, items = []) {
  companionVisuals = visuals || {};
  companionItems = items || [];
  companions.setCompanionData({ visuals: companionVisuals, items: companionItems });
  renderAgentList();
  if (activeChatAgent) {
    const agent = getAgent(activeChatAgent);
    const companionCanvas = panelEl?.querySelector('.dc-agent-companion');
    applyAgentTheme(agent);
    if (agent.visual?.mode === 'companion') {
      companionCanvas?.classList.remove('hidden');
      companions.mountCompanionCanvas(companionCanvas, { agentId: agent.id, state: 'idle' });
    } else {
      companionCanvas?.classList.add('hidden');
    }
  }
}

export function open() {
  openChatPanel();
}

export function isOpen() {
  return isChatOpen;
}

export function getActiveAgent() {
  return activeChatAgent;
}
