// ── app.js ────────────────────────────────────────────────────────────────────
// The UI layer.
// Responsibilities:
//   • Create engine instances and wire them into RecorderAPI + RecorderStateMachine.
//   • Render the correct button / badge / selector state for each machine state.
//   • Dispatch state machine events from user interactions.
//   • Manage the elapsed-time timer and OS media session.
//   • Enumerate devices, manage preferences, and bootstrap the page.

import { AudioMixer }                            from './audio-mixer.js';
import { Compositor }                            from './compositor.js';
import { Metronome }                             from './metronome.js';
import { StorageManager }                        from './storage.js';
import { RecorderCore }                          from './recorder-core.js';
import { PREFS, savePref, loadPref }             from './prefs.js';
import { showAlert, showToast, showErrorDialog } from './dialogs.js';
import { setupMediaSession, clearMediaSession }  from './media-session.js';
import { registerServiceWorker }                 from './register-service-worker.js';
import { RecorderAPI }                           from './recorder-api.js';
import { RecorderStateMachine, STATE, EVENT }    from './recorder-state-machine.js';
import { trackEvent }                            from './analytics.js';
import { MediaLibrary, isVideoFileName }         from './media-library.js';
import {
  OpenAIClientManager,
  OpenAIConfigError,
  TRANSCRIPTION_OUTPUT_MODES,
  TRANSCRIPTION_OUTPUT_MODE_LABELS,
} from './openai-client.js';
import { TranscriptionController }               from './transcription-controller.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const BLOB_URL_REVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const FORMAT_MP3                 = 'mp3-audio-only';
const AUDIO_BITRATE              = 128_000;
const VIDEO_BITRATES             = { '480': 2_000_000, '720': 4_000_000, '1080': 8_000_000 };
const ONE_HOUR_SECONDS           = 60 * 60;
const LIBRARY_DATE_FORMATTER     = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const STATUS_CLASS = {
  muted:   'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
};
const POSTPROCESS_MODEL = 'gpt-5.4-mini';
const DEFAULT_POSTPROCESS_PROMPT = 'Reescreva a transcrição em português do Brasil, com clareza, boa fluidez e preservando o sentido original. Retorne apenas o texto final.';
const POSTPROCESS_PROMPT_PRESETS = {
  meeting_minutes: 'Reescreva esta transcrição como uma ata de reunião em português do Brasil. Estruture em: contexto, participantes citados quando identificáveis, decisões tomadas, pendências, responsáveis e próximos passos. Use linguagem objetiva e profissional.',
  legal: 'Reescreva esta transcrição em linguagem jurídica formal, técnica e impessoal, em português do Brasil. Preserve o conteúdo original, elimine ambiguidades, organize os fatos com clareza e utilize terminologia compatível com documentos jurídicos.',
  executive_summary: 'Reescreva esta transcrição como um resumo executivo em português do Brasil. Destaque objetivo, principais pontos discutidos, decisões, riscos, oportunidades e próximos passos em linguagem clara e concisa.',
};
const POSTPROCESS_RESULT_SUFFIX = 'reformulado';

// ── Formatters ─────────────────────────────────────────────────────────────────

const gainPct = v => Math.round(parseFloat(v) * 100) + '%';
const fmtTime = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const fmtBytes = bytes => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(decimals) + ' ' + units[unitIndex];
};
const isMp3Format = format => format === FORMAT_MP3;

// ── DOM refs ───────────────────────────────────────────────────────────────────

const recorderUi     = document.getElementById('recorder-ui');
const transcriptionUi = document.getElementById('transcription-ui');
const canvas         = document.getElementById('recorder-canvas');
const webcamSel      = document.getElementById('webcam-select');
const micSel         = document.getElementById('mic-select');
const fpsSel         = document.getElementById('fps-select');
const qualitySel     = document.getElementById('quality-select');
const formatSel      = document.getElementById('format-select');
const sysAudioChk    = document.getElementById('sys-audio-chk');
const startBtn       = document.getElementById('start-btn');
const pauseBtn       = document.getElementById('pause-btn');
const stopBtn        = document.getElementById('stop-btn');
const micToggleBtn   = document.getElementById('mic-toggle-btn');
const endSessionBtn  = document.getElementById('end-session-btn');
const pickDirBtn     = document.getElementById('pick-dir-btn');
const dirNameEl      = document.getElementById('dir-name');
const statusBadge    = document.getElementById('status-badge');
const timerEl        = document.getElementById('timer-text');
const recordingEstimateEl = document.getElementById('recording-estimate');
const formatHintEl        = document.getElementById('format-hint');
const longRecordingAlertEl = document.getElementById('long-recording-alert');
const micGainSlider  = document.getElementById('mic-gain-slider');
const sysGainSlider  = document.getElementById('sys-gain-slider');
const micGainLabel   = document.getElementById('mic-gain-label');
const sysGainLabel   = document.getElementById('sys-gain-label');
const micLevelCanvas = document.getElementById('mic-level-canvas');
const sysLevelCanvas = document.getElementById('sys-level-canvas');
const errorDialog    = document.getElementById('captura-error-dialog');

const openAiPanel            = document.getElementById('openai-panel');
const transcriptionPanel     = document.getElementById('transcription-settings-panel');
const openAiKeyForm          = document.getElementById('openai-key-form');
const openAiApiKeyInput      = document.getElementById('openai-api-key');
const openAiApiKeyToggleBtn  = document.getElementById('openai-api-key-toggle');
const liveTranscriptionChk   = document.getElementById('live-transcription-chk');
const transcriptionPromptEl  = document.getElementById('transcription-prompt');
const transcriptionModeSel   = document.getElementById('transcription-mode-select');
const transcriptionModeHintEl = document.getElementById('transcription-mode-hint');
const transcriptionStatusEl  = document.getElementById('transcription-status');
const liveTranscriptOutputEl = document.getElementById('live-transcript-output');
const liveTranscriptBadgeEl  = document.getElementById('live-transcript-badge');
const refreshLibraryBtn      = document.getElementById('refresh-library-btn');
const mediaFileListEl        = document.getElementById('media-file-list');
const mediaDetailPanelEl     = document.getElementById('media-detail-panel');
const librarySummaryEl       = document.getElementById('library-summary');
const selectedVideoPlayerEl  = document.getElementById('selected-video-player');
const selectedAudioPlayerEl  = document.getElementById('selected-audio-player');
const mediaPreviewPlaceholderEl = document.getElementById('media-preview-placeholder');
const transcribeSelectedBtn  = document.getElementById('transcribe-selected-btn');
const transcribeNewVersionBtn = document.getElementById('transcribe-new-version-btn');
const transcriptVersionSel   = document.getElementById('transcript-version-select');
const selectedTranscriptStatusEl = document.getElementById('selected-transcript-status');
const transcriptViewerEl     = document.getElementById('transcript-viewer');
const processSelectedTranscriptBtn = document.getElementById('process-selected-transcript-btn');
const postProcessStatusEl    = document.getElementById('postprocess-status');
const postProcessPresetSel   = document.getElementById('postprocess-preset-select');
const postProcessPromptEl    = document.getElementById('postprocess-prompt');
const postProcessOutputEl    = document.getElementById('postprocess-output');
const postProcessCopyBtn     = document.getElementById('postprocess-copy-btn');
const postProcessSaveBtn     = document.getElementById('postprocess-save-btn');

// ── Capability checks ──────────────────────────────────────────────────────────

const hasGetDisplayMedia = !!(navigator.mediaDevices?.getDisplayMedia);
const hasFSA             = typeof window.showDirectoryPicker === 'function';

// ── Engine instances ───────────────────────────────────────────────────────────

const compositor = new Compositor(canvas, {
  onPipMoved: (x, y) => { savePref(PREFS.pipX, x); savePref(PREFS.pipY, y); },
});

const metronome      = new Metronome();
const audioMixer     = new AudioMixer(micLevelCanvas, sysLevelCanvas);
const storage        = new StorageManager(dirNameEl, showErrorDialog);
const recorderCore   = new RecorderCore();
const openAiClient   = new OpenAIClientManager(openAiApiKeyInput);
const mediaLibrary   = new MediaLibrary(storage);
const transcriptionController = new TranscriptionController({
  clientManager: openAiClient,
  mediaLibrary,
  onLiveUpdate: ({ text }) => {
    liveTranscriptOutputEl.value = text;
    setTranscriptionStatus('Transcrição ao vivo atualizada.', 'success');
    setLiveTranscriptBadge('Ouvindo', 'badge bg-success');
  },
  onStatus: payload => {
    if (payload?.message) setTranscriptionStatus(payload.message, 'muted');
  },
  onError: error => {
    setTranscriptionStatus(error.message || 'Falha na transcrição ao vivo.', 'danger');
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
  },
});

function extractPostProcessResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data?.output)) return '';

  const parts = [];
  data.output.forEach(item => {
    if (!Array.isArray(item?.content)) return;
    item.content.forEach(contentItem => {
      if (typeof contentItem?.text === 'string' && contentItem.text.trim()) {
        parts.push(contentItem.text.trim());
      }
    });
  });

  return parts.join('\n\n').trim();
}

async function fallbackPostProcessText({ text, prompt = '', signal } = {}) {
  const apiKey = openAiClient.assertConfigured();
  const transcriptText = text?.trim() || '';
  if (!transcriptText) {
    throw new Error('Não há texto de transcrição para processar.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: POSTPROCESS_MODEL,
      input: [
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'Você reescreve transcrições. Retorne apenas o texto final reformulado, sem prefácio, sem título e sem observações extras, a menos que isso seja pedido explicitamente.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Instrução:\n${prompt.trim() || DEFAULT_POSTPROCESS_PROMPT}`,
                `Transcrição:\n${transcriptText}`,
              ].join('\n\n'),
            },
          ],
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    let message = `A requisição para a OpenAI falhou com status ${response.status}.`;
    try {
      const data = await response.json();
      message = data?.error?.message || data?.message || message;
    } catch (_) {
      message = await response.text().catch(() => message);
    }
    throw new Error(message);
  }

  const data = await response.json();
  const outputText = extractPostProcessResponseText(data);
  if (!outputText) {
    throw new Error('A OpenAI retornou um resultado vazio no pós-processamento.');
  }

  return outputText;
}

const postProcessText = typeof openAiClient.postProcessText === 'function'
  ? params => openAiClient.postProcessText(params)
  : params => fallbackPostProcessText(params);

// ── API + state machine ────────────────────────────────────────────────────────

const api = new RecorderAPI({
  compositor, audioMixer, metronome, recorderCore, storage, canvas,
});

const machine = new RecorderStateMachine(api);

// ── UI state ───────────────────────────────────────────────────────────────────

let elapsedSecs               = 0;
let timerIntervalId           = null;
let libraryEntries            = [];
let selectedMediaEntry        = null;
let selectedTranscriptEntries = [];
let selectedPreviewUrl        = null;
let pendingLiveStopPromise    = Promise.resolve('');
let recordingTranscriptInFlight = false;
let transcriptionBusy         = false;
let postProcessingBusy        = false;
const selectedTranscriptNameByMedia = new Map();
const postProcessResultsByTranscript = new Map();

// ── Timer state ────────────────────────────────────────────────────────────────

function startTimer() {
  clearInterval(timerIntervalId);
  elapsedSecs = 0;
  timerEl.textContent = '00:00';
  updateRecordingEstimate();
  timerIntervalId = setInterval(() => {
    timerEl.textContent = fmtTime(++elapsedSecs);
    updateRecordingEstimate();
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerIntervalId);
  timerIntervalId = null;
  updateRecordingEstimate();
}

function resumeTimer() {
  if (!timerIntervalId) {
    timerIntervalId = setInterval(() => {
      timerEl.textContent = fmtTime(++elapsedSecs);
      updateRecordingEstimate();
    }, 1000);
  }
}

function resetTimer() {
  clearInterval(timerIntervalId);
  timerIntervalId = null;
  elapsedSecs = 0;
  timerEl.textContent = '00:00';
  updateRecordingEstimate();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setInlineStatus(el, message, tone = 'muted') {
  if (!el) return;
  el.textContent = message;
  el.className = `captura-inline-status small ${STATUS_CLASS[tone] || STATUS_CLASS.muted}`;
}

function setTranscriptionStatus(message, tone = 'muted') {
  setInlineStatus(transcriptionStatusEl, message, tone);
}

function setSelectedTranscriptStatus(message, tone = 'muted') {
  setInlineStatus(selectedTranscriptStatusEl, message, tone);
}

function setPostProcessStatus(message, tone = 'muted') {
  setInlineStatus(postProcessStatusEl, message, tone);
}

function setLiveTranscriptBadge(label, className) {
  liveTranscriptBadgeEl.textContent = label;
  liveTranscriptBadgeEl.className = className;
}

function openOpenAiPanel() {
  openAiPanel.open = true;
  savePref(PREFS.openAiPanelOpen, 'true');
}

function getTranscriptionMode() {
  return transcriptionModeSel?.value || TRANSCRIPTION_OUTPUT_MODES.plain;
}

function isDiarizationTranscriptionMode() {
  return getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.diarized;
}

function getLiveTranscriptionPrompt() {
  return transcriptionPromptEl.value.trim();
}

function getFileTranscriptionPrompt() {
  return isDiarizationTranscriptionMode() ? '' : transcriptionPromptEl.value.trim();
}

function isLiveTranscriptionEnabled() {
  return liveTranscriptionChk.checked;
}

function updateTranscriptionModeHint() {
  if (!transcriptionModeHintEl) return;

  transcriptionModeHintEl.textContent =
    getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.timestamps
      ? 'Gera um texto legível com timestamps por segmento.'
      : getTranscriptionMode() === TRANSCRIPTION_OUTPUT_MODES.diarized
        ? 'Gera speaker labels por segmento. Neste modo, o prompt de transcrição é ignorado apenas no fluxo de arquivo.'
        : 'Mantém a transcrição em texto simples, como hoje.';
}

function updatePostProcessActionButtons({ lockControls = false } = {}) {
  const hasOutput = !!postProcessOutputEl.value.trim();
  if (postProcessCopyBtn) postProcessCopyBtn.disabled = lockControls || !hasOutput;
  if (postProcessSaveBtn) postProcessSaveBtn.disabled = lockControls || !hasOutput;
}

async function copyTextToClipboard(text) {
  if (!text.trim()) throw new Error('Não há texto para copiar.');

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  helper.style.pointerEvents = 'none';
  document.body.appendChild(helper);
  helper.select();
  const copied = document.execCommand('copy');
  helper.remove();

  if (!copied) {
    throw new Error('Não foi possível copiar o texto para a área de transferência.');
  }
}

async function savePostProcessOutput() {
  const output = postProcessOutputEl.value.trim();
  if (!output) {
    throw new Error('Não há resultado reformulado para salvar.');
  }
  if (!selectedMediaEntry?.name) {
    throw new Error('Selecione um arquivo de mídia antes de salvar o resultado reformulado.');
  }

  const dirOk = await storage.ensureAccess({
    mode: 'readwrite',
    silent: false,
    requestIfNeeded: true,
  });
  if (!dirOk) {
    throw new Error('A pasta escolhida não está disponível para salvar o resultado reformulado.');
  }

  const result = await mediaLibrary.writeTranscript(selectedMediaEntry.name, output, {
    suffix: POSTPROCESS_RESULT_SUFFIX,
  });

  showToast(`Resultado salvo como ${result.fileName}.`, 'success');
  setPostProcessStatus(`Resultado salvo como ${result.fileName}.`, 'success');
  return result;
}

function revokeSelectedPreviewUrl() {
  if (!selectedPreviewUrl) return;
  URL.revokeObjectURL(selectedPreviewUrl);
  selectedPreviewUrl = null;
}

function hideMediaDetailPanel() {
  if (mediaDetailPanelEl) mediaDetailPanelEl.hidden = true;
}

function resetMediaPreview() {
  revokeSelectedPreviewUrl();
  [selectedVideoPlayerEl, selectedAudioPlayerEl].forEach(mediaEl => {
    mediaEl.pause();
    mediaEl.removeAttribute('src');
    mediaEl.load();
    mediaEl.hidden = true;
  });
  mediaPreviewPlaceholderEl.hidden = false;
}

function clearTranscriptViewer(message = 'A transcrição selecionada será exibida aqui.') {
  transcriptViewerEl.value = '';
  transcriptViewerEl.placeholder = message;
}

function getSelectedTranscriptCacheKey(mediaName = selectedMediaEntry?.name || '', transcriptName = transcriptVersionSel.value) {
  if (!mediaName || !transcriptName) return '';
  return `${mediaName}::${transcriptName}`;
}

function syncPostProcessOutput() {
  const cacheKey = getSelectedTranscriptCacheKey();
  if (!cacheKey) {
    postProcessOutputEl.value = '';
    postProcessOutputEl.placeholder = 'O resultado processado aparecerá aqui.';
    setPostProcessStatus('Escolha uma transcrição salva para habilitar o pós-processamento.', 'muted');
    updatePostProcessActionButtons();
    return;
  }

  const cached = postProcessResultsByTranscript.get(cacheKey) || '';
  postProcessOutputEl.value = cached;
  postProcessOutputEl.placeholder = 'O resultado processado aparecerá aqui.';
  updatePostProcessActionButtons();
  setPostProcessStatus(
    cached
      ? 'Exibindo o último texto reformulado desta versão da transcrição.'
      : 'Adicione um prompt opcional e processe a transcrição selecionada.',
    cached ? 'success' : 'muted'
  );
}

function clearSelectedMediaState(message = 'Selecione um arquivo da pasta escolhida para visualizar e inspecionar a transcrição.') {
  selectedMediaEntry = null;
  selectedTranscriptEntries = [];
  resetMediaPreview();
  mediaPreviewPlaceholderEl.textContent = message;
  transcriptVersionSel.innerHTML = '<option value="">Nenhuma transcrição ainda</option>';
  transcriptVersionSel.disabled = true;
  clearTranscriptViewer();
  setSelectedTranscriptStatus('Selecione um arquivo para carregar a transcrição.', 'muted');
  postProcessOutputEl.value = '';
  updatePostProcessActionButtons();
  setPostProcessStatus('Escolha um arquivo e uma versão da transcrição para executar o pós-processamento.', 'muted');
  hideMediaDetailPanel();
}

function applyPostProcessPreset(presetKey) {
  if (!presetKey || !POSTPROCESS_PROMPT_PRESETS[presetKey]) return;
  postProcessPromptEl.value = POSTPROCESS_PROMPT_PRESETS[presetKey];
  savePref(PREFS.postProcessPrompt, postProcessPromptEl.value);
}

function buildMediaListItem(entry) {
  const article = document.createElement('article');
  article.className = 'captura-library-entry';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'captura-library-item';
  button.dataset.name = entry.name;

  const shell = document.createElement('div');
  shell.className = 'captura-library-item-shell';

  const iconBox = document.createElement('div');
  iconBox.className = 'captura-library-thumb';
  iconBox.innerHTML = `<i class="fas ${entry.kind === 'video' ? 'fa-circle-play' : 'fa-wave-square'}"></i>`;

  const body = document.createElement('div');
  body.className = 'captura-library-copy';

  const top = document.createElement('div');
  top.className = 'd-flex align-items-start justify-content-between gap-2';

  const name = document.createElement('span');
  name.className = 'captura-library-name';
  name.textContent = entry.name;

  const badge = document.createElement('span');
  badge.className = 'captura-library-kind';
  badge.textContent = entry.kind === 'video' ? 'VÍDEO' : 'ÁUDIO';

  top.append(name, badge);

  const bottom = document.createElement('div');
  bottom.className = 'captura-library-meta';

  const dateLabel = document.createElement('span');
  dateLabel.textContent = entry.lastModified
    ? LIBRARY_DATE_FORMATTER.format(entry.lastModified)
    : 'Sem data';

  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = fmtBytes(entry.size);

  const transcriptLabel = document.createElement('small');
  transcriptLabel.className = 'captura-library-transcripts';
  transcriptLabel.textContent = entry.transcriptCount
    ? `${entry.transcriptCount} transcri${entry.transcriptCount === 1 ? 'ção' : 'ções'}`
    : 'Sem transcrição';

  const chevron = document.createElement('span');
  chevron.className = 'captura-library-chevron';
  chevron.innerHTML = `<i class="fas fa-chevron-${selectedMediaEntry?.name === entry.name ? 'up' : 'down'}"></i>`;

  bottom.append(dateLabel, document.createTextNode(' • '), sizeLabel);
  body.append(top, bottom, transcriptLabel);
  shell.append(iconBox, body);
  button.append(shell, chevron);
  article.append(button);
  return { article, button };
}

function renderMediaFileList() {
  mediaFileListEl.replaceChildren();

  if (!libraryEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'captura-library-empty';
    empty.textContent = storage.dirHandle
      ? 'Nenhum arquivo de áudio ou vídeo compatível foi encontrado na pasta selecionada.'
      : 'Escolha uma pasta para listar os arquivos de áudio e vídeo.';
    mediaFileListEl.appendChild(empty);
    return;
  }

  libraryEntries.forEach(entry => {
    const { article, button: item } = buildMediaListItem(entry);
    item.disabled = transcriptionBusy || postProcessingBusy;
    if (selectedMediaEntry?.name === entry.name) item.classList.add('active');
    item.addEventListener('click', () => {
      void selectMediaEntryByName(entry.name);
    });
    if (selectedMediaEntry?.name === entry.name) {
      article.classList.add('is-active');
      mediaDetailPanelEl.hidden = false;
      article.appendChild(mediaDetailPanelEl);
    }
    mediaFileListEl.appendChild(article);
  });

  if (!selectedMediaEntry) hideMediaDetailPanel();
}

function updateLibrarySummary() {
  if (!storage.dirHandle) {
    librarySummaryEl.textContent = 'Selecione uma pasta para listar áudios e vídeos.';
    return;
  }

  if (!libraryEntries.length) {
    librarySummaryEl.textContent = `Nenhum arquivo compatível foi encontrado em ${storage.dirHandle.name}.`;
    return;
  }

  librarySummaryEl.textContent = `${libraryEntries.length} arquivo${libraryEntries.length === 1 ? '' : 's'} encontrado${libraryEntries.length === 1 ? '' : 's'} em ${storage.dirHandle.name}.`;
}

function handleTranscriptionError(error, {
  toast = true,
  dialog = false,
  updateTranscriptPane = false,
  updateLivePane = true,
} = {}) {
  const title = error?.title || 'Erro de transcrição';
  const message = error?.message || String(error ?? 'Erro de transcrição desconhecido.');

  if (updateLivePane) setTranscriptionStatus(message, 'danger');
  if (updateTranscriptPane) setSelectedTranscriptStatus(message, 'danger');

  if (toast) showToast(message, 'danger');
  if (dialog) showErrorDialog(title, message, error);
  if (error instanceof OpenAIConfigError) openOpenAiPanel();
}

async function loadMediaPreview(mediaEntry) {
  resetMediaPreview();
  if (!mediaEntry) return;

  const file = await mediaEntry.handle.getFile();
  selectedPreviewUrl = URL.createObjectURL(file);

  const target = isVideoFileName(mediaEntry.name) ? selectedVideoPlayerEl : selectedAudioPlayerEl;
  target.src = selectedPreviewUrl;
  target.hidden = false;
  mediaPreviewPlaceholderEl.hidden = true;
}

async function loadTranscriptEntries(mediaFileName, preferredTranscriptName = '') {
  selectedTranscriptEntries = await mediaLibrary.getRelatedTranscripts(mediaFileName);
  transcriptVersionSel.replaceChildren();

  if (!selectedTranscriptEntries.length) {
    transcriptVersionSel.add(new Option('Nenhuma transcrição ainda', ''));
    transcriptVersionSel.disabled = true;
    clearTranscriptViewer('Este arquivo ainda não possui uma transcrição salva.');
    setSelectedTranscriptStatus('Ainda não existe transcrição salva para este arquivo.', 'muted');
    syncPostProcessOutput();
    return;
  }

  selectedTranscriptEntries.forEach(entry => {
    transcriptVersionSel.add(new Option(entry.name, entry.name));
  });
  transcriptVersionSel.disabled = false;

  const cachedTranscriptName = selectedTranscriptNameByMedia.get(mediaFileName);
  const preferred = selectedTranscriptEntries.find(entry => entry.name === preferredTranscriptName);
  const cached = selectedTranscriptEntries.find(entry => entry.name === cachedTranscriptName);
  transcriptVersionSel.value = preferred?.name || cached?.name || selectedTranscriptEntries[0].name;
  await loadSelectedTranscript();
}

async function loadSelectedTranscript() {
  const transcriptName = transcriptVersionSel.value;
  const transcriptEntry = selectedTranscriptEntries.find(entry => entry.name === transcriptName);

  if (!transcriptEntry) {
    clearTranscriptViewer('Este arquivo ainda não possui uma transcrição salva.');
    setSelectedTranscriptStatus('Ainda não existe transcrição salva para este arquivo.', 'muted');
    syncPostProcessOutput();
    return;
  }

  const transcriptText = await mediaLibrary.readTranscript(transcriptEntry.handle);
  transcriptViewerEl.value = transcriptText;
  if (selectedMediaEntry?.name) {
    selectedTranscriptNameByMedia.set(selectedMediaEntry.name, transcriptEntry.name);
  }
  setSelectedTranscriptStatus(`Exibindo ${transcriptEntry.name}.`, 'success');
  syncPostProcessOutput();
}

async function selectMediaEntryByName(mediaName, preferredTranscriptName = '') {
  const entry = libraryEntries.find(item => item.name === mediaName);
  if (!entry) return;

  selectedMediaEntry = entry;
  renderMediaFileList();

  try {
    await loadMediaPreview(entry);
    await loadTranscriptEntries(entry.name, preferredTranscriptName);
  } catch (error) {
    clearTranscriptViewer();
    setSelectedTranscriptStatus('Não foi possível carregar o arquivo selecionado.', 'danger');
    setPostProcessStatus('Não foi possível carregar a transcrição selecionada.', 'danger');
    handleTranscriptionError(error, { toast: true, dialog: false, updateLivePane: false });
  }

  render(machine.state);
}

async function refreshMediaLibrary({
  preferredMediaName = selectedMediaEntry?.name || '',
  preferredTranscriptName = '',
  silent = false,
} = {}) {
  if (!storage.dirHandle) {
    libraryEntries = [];
    clearSelectedMediaState();
    renderMediaFileList();
    updateLibrarySummary();
    render(machine.state);
    return;
  }

  const dirOk = await storage.ensureAccess({
    mode: 'readwrite',
    silent,
    requestIfNeeded: !silent,
  });
  if (!dirOk) return;

  libraryEntries = await mediaLibrary.listMediaFiles();
  updateLibrarySummary();
  renderMediaFileList();

  if (!libraryEntries.length) {
    clearSelectedMediaState('Nenhum arquivo de áudio ou vídeo compatível foi encontrado na pasta selecionada.');
    render(machine.state);
    return;
  }

  const nextMediaName = libraryEntries.some(entry => entry.name === preferredMediaName)
    ? preferredMediaName
    : libraryEntries[0].name;
  await selectMediaEntryByName(nextMediaName, preferredTranscriptName);
}

async function transcribeSelectedMedia({ alwaysVersion = false } = {}) {
  if (!selectedMediaEntry) return;
  const mediaName = selectedMediaEntry.name;
  const mediaHandle = selectedMediaEntry.handle;
  const mode = getTranscriptionMode();
  const modeLabel = TRANSCRIPTION_OUTPUT_MODE_LABELS[mode] || TRANSCRIPTION_OUTPUT_MODE_LABELS.plain;

  try {
    openAiClient.assertConfigured();
  } catch (error) {
    handleTranscriptionError(error, {
      toast: false,
      dialog: true,
      updateTranscriptPane: true,
      updateLivePane: true,
    });
    return;
  }

  trackEvent('captura_transcription_start', {
    file_name: mediaName,
    force_new_version: alwaysVersion,
    mode,
  });
  transcriptionBusy = true;
  renderMediaFileList();
  render(machine.state);
  setSelectedTranscriptStatus(`Preparando ${mediaName} para transcrição em ${modeLabel}…`, 'muted');
  setTranscriptionStatus(`Preparando ${mediaName} para transcrição em ${modeLabel}…`, 'muted');

  try {
    const result = await transcriptionController.transcribeFileHandle(mediaHandle, {
      prompt: getFileTranscriptionPrompt(),
      alwaysVersion,
      mode,
      onProgress: payload => {
        if (payload?.message) {
          setSelectedTranscriptStatus(payload.message, 'muted');
          setTranscriptionStatus(payload.message, 'muted');
        }
      },
    });

    showToast(`Transcrição salva como ${result.fileName}.`, 'success');
    setSelectedTranscriptStatus(`Transcrição salva como ${result.fileName}.`, 'success');
    setTranscriptionStatus(`Transcrição salva como ${result.fileName}.`, 'success');
    trackEvent('captura_transcription_saved', {
      file_name: mediaName,
      transcript_name: result.fileName,
      mode,
    });
    await refreshMediaLibrary({
      preferredMediaName: mediaName,
      preferredTranscriptName: result.fileName,
      silent: true,
    });
  } catch (error) {
    trackEvent('captura_transcription_error', { file_name: mediaName });
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: true,
      updateLivePane: true,
    });
  } finally {
    transcriptionBusy = false;
    renderMediaFileList();
    render(machine.state);
  }
}

async function processSelectedTranscript() {
  if (!selectedMediaEntry || !transcriptVersionSel.value || !transcriptViewerEl.value.trim()) return;

  try {
    openAiClient.assertConfigured();
  } catch (error) {
    setPostProcessStatus(error.message, 'danger');
    handleTranscriptionError(error, {
      toast: false,
      dialog: true,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
    return;
  }

  const transcriptName = transcriptVersionSel.value;
  const transcriptText = transcriptViewerEl.value.trim();
  const cacheKey = getSelectedTranscriptCacheKey();

  postProcessingBusy = true;
  renderMediaFileList();
  render(machine.state);
  setPostProcessStatus(`Processando ${transcriptName} com a OpenAI…`, 'muted');
  setTranscriptionStatus(`Processando ${transcriptName} com a OpenAI…`, 'muted');
  trackEvent('captura_postprocess_start', {
    file_name: selectedMediaEntry.name,
    transcript_name: transcriptName,
  });

  try {
    const result = await postProcessText({
      text: transcriptText,
      prompt: postProcessPromptEl.value,
    });

    if (cacheKey) postProcessResultsByTranscript.set(cacheKey, result);
    postProcessOutputEl.value = result;
    updatePostProcessActionButtons();
    setPostProcessStatus('Texto reformulado com sucesso.', 'success');
    setTranscriptionStatus(`Pós-processamento concluído para ${transcriptName}.`, 'success');
    trackEvent('captura_postprocess_saved', {
      file_name: selectedMediaEntry.name,
      transcript_name: transcriptName,
    });
  } catch (error) {
    setPostProcessStatus(error.message || 'Falha no pós-processamento.', 'danger');
    trackEvent('captura_postprocess_error', {
      file_name: selectedMediaEntry.name,
      transcript_name: transcriptName,
    });
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
  } finally {
    postProcessingBusy = false;
    renderMediaFileList();
    render(machine.state);
  }
}

async function startLiveTranscriptionForRecording() {
  if (!isLiveTranscriptionEnabled()) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
    return;
  }

  try {
    openAiClient.assertConfigured();
  } catch (error) {
    setLiveTranscriptBadge('Chave necessária', 'badge bg-danger');
    handleTranscriptionError(error, {
      toast: false,
      dialog: true,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
    return;
  }

  const track = audioMixer.getMixedTrackClone();
  if (!track) {
    setLiveTranscriptBadge('Sem áudio', 'badge bg-secondary');
    setTranscriptionStatus('A transcrição ao vivo foi ignorada porque esta gravação não tem fonte de áudio ativa.', 'warning');
    return;
  }

  liveTranscriptOutputEl.value = '';
  setLiveTranscriptBadge('Iniciando', 'badge bg-info');
  setTranscriptionStatus('Iniciando transcrição ao vivo…', 'muted');

  try {
    await transcriptionController.startLiveTranscription({
      track,
      prompt: getLiveTranscriptionPrompt(),
    });
    setLiveTranscriptBadge('Ouvindo', 'badge bg-success');
    trackEvent('captura_live_transcription_start');
  } catch (error) {
    track.stop();
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
  }
}

async function stopLiveTranscription({ preserveBadge = false } = {}) {
  pendingLiveStopPromise = transcriptionController.stopLiveTranscription().catch(error => {
    handleTranscriptionError(error, { toast: false, dialog: false, updateTranscriptPane: false, updateLivePane: true });
    return transcriptionController.liveTranscript;
  });

  const liveText = await pendingLiveStopPromise;
  if (liveText) liveTranscriptOutputEl.value = liveText;
  if (!preserveBadge && !recordingTranscriptInFlight) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
  }
  return liveText;
}

async function finalizeSavedRecordingTranscript(fileHandle) {
  if (!isLiveTranscriptionEnabled() || !fileHandle) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
    return;
  }

  transcriptionBusy = true;
  recordingTranscriptInFlight = true;
  const mode = getTranscriptionMode();
  const modeLabel = TRANSCRIPTION_OUTPUT_MODE_LABELS[mode] || TRANSCRIPTION_OUTPUT_MODE_LABELS.plain;
  renderMediaFileList();
  render(machine.state);
  setLiveTranscriptBadge('Finalizando', 'badge bg-info');
  setTranscriptionStatus(`Transcrevendo a gravação salva em ${modeLabel}…`, 'muted');

  let preferredTranscriptName = '';

  try {
    const liveText = await pendingLiveStopPromise;
    if (liveText.trim()) {
      const liveResult = await mediaLibrary.writeTranscript(fileHandle.name, liveText, { variant: 'live' });
      preferredTranscriptName = liveResult.fileName;
      setTranscriptionStatus(`Transcrição ao vivo salva como ${liveResult.fileName}.`, 'success');
      trackEvent('captura_live_transcript_saved', { transcript_name: liveResult.fileName });
    }

    const result = await transcriptionController.transcribeFileHandle(fileHandle, {
      prompt: getFileTranscriptionPrompt(),
      mode,
      onProgress: payload => {
        if (payload?.message) setTranscriptionStatus(payload.message, 'muted');
      },
    });

    preferredTranscriptName = result.fileName;
    showToast(`Transcrição salva como ${result.fileName}.`, 'success');
    setTranscriptionStatus(`Transcrição salva como ${result.fileName}.`, 'success');
    setLiveTranscriptBadge('Salvo', 'badge bg-success');
    trackEvent('captura_recording_transcript_saved', { transcript_name: result.fileName, mode });

    await refreshMediaLibrary({
      preferredMediaName: fileHandle.name,
      preferredTranscriptName,
      silent: true,
    });
  } catch (error) {
    if (preferredTranscriptName) {
      await refreshMediaLibrary({
        preferredMediaName: fileHandle.name,
        preferredTranscriptName,
        silent: true,
      }).catch(() => {});
    }
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: true,
    });
  } finally {
    transcriptionBusy = false;
    recordingTranscriptInFlight = false;
    renderMediaFileList();
    render(machine.state);
  }
}

// ── UI rendering ───────────────────────────────────────────────────────────────

function render(state) {
  const isSession   = state === STATE.SESSION;
  const isReq       = state === STATE.REQUESTING;
  const isRec       = state === STATE.RECORDING;
  const isPaused    = state === STATE.PAUSED;
  const isStopping  = state === STATE.STOPPING;
  const isError     = state === STATE.ERROR;
  const active      = isRec || isPaused;
  const hasSession  = isSession || api.hasSession;

  startBtn.hidden   = active || isStopping;
  startBtn.disabled = isReq;

  pauseBtn.hidden    = !active;
  pauseBtn.disabled  = false;
  pauseBtn.innerHTML = isPaused
    ? '<i class="fas fa-play me-1"></i>Retomar'
    : '<i class="fas fa-pause me-1"></i>Pausar';
  pauseBtn.className = isPaused
    ? 'btn captura-pause-button is-resume'
    : 'btn captura-pause-button';

  stopBtn.hidden   = !active;
  stopBtn.disabled = false;

  micToggleBtn.hidden   = !active || !api.hasActiveMic;
  micToggleBtn.disabled = !active || !api.hasActiveMic;
  micToggleBtn.innerHTML = api.isMicMuted
    ? '<i class="fas fa-microphone me-1"></i>Ativar microfone'
    : '<i class="fas fa-microphone-slash me-1"></i>Silenciar microfone';
  micToggleBtn.className = api.isMicMuted ? 'btn btn-success' : 'btn btn-danger';

  endSessionBtn.hidden   = !hasSession;
  endSessionBtn.disabled = isStopping || isReq;

  const lockControls = active || isStopping || isReq || transcriptionBusy || postProcessingBusy;
  const mp3Mode = isMp3Format(formatSel.value);
  const hasSelectedTranscript = selectedTranscriptEntries.length > 0 && !!transcriptVersionSel.value;

  pickDirBtn.disabled     = lockControls;
  webcamSel.disabled      = lockControls || mp3Mode;
  micSel.disabled         = lockControls;
  sysAudioChk.disabled    = lockControls || !hasGetDisplayMedia;
  fpsSel.disabled         = lockControls || mp3Mode;
  qualitySel.disabled     = lockControls || mp3Mode;
  formatSel.disabled      = lockControls;
  liveTranscriptionChk.disabled = lockControls;
  transcriptionPromptEl.disabled = lockControls;
  transcriptionModeSel.disabled = lockControls;
  openAiApiKeyInput.disabled = lockControls;
  openAiApiKeyToggleBtn.disabled = lockControls;
  refreshLibraryBtn.disabled = lockControls || !storage.dirHandle;
  transcribeSelectedBtn.disabled = lockControls || !selectedMediaEntry;
  transcribeNewVersionBtn.disabled = lockControls || !selectedMediaEntry;
  transcriptVersionSel.disabled = lockControls || selectedTranscriptEntries.length === 0;
  processSelectedTranscriptBtn.disabled = lockControls || !hasSelectedTranscript;
  postProcessPromptEl.disabled = lockControls;
  postProcessPresetSel.disabled = lockControls;
  updatePostProcessActionButtons({ lockControls });

  statusBadge.textContent =
      isRec      ? '⏺ Gravando'
    : isPaused   ? '⏸ Pausado'
    : isReq      ? '⏳ Preparando…'
    : isStopping ? '⏳ Salvando…'
    : isSession  ? '◉ Sessão ativa'
    : isError    ? '⚠ Erro'
    :              'Inativo';

  statusBadge.className =
      isRec                    ? 'badge bg-danger'
    : isPaused                 ? 'badge bg-secondary'
    : isReq || isStopping || isSession
      ? 'badge bg-info'
    : isError                  ? 'badge bg-danger'
    :                            'badge bg-secondary';
}

// ── State-change handler ───────────────────────────────────────────────────────

machine.onStateChange((state, event, payload) => {
  render(state);

  if (state === STATE.RECORDING) {
    if (event === EVENT.ENCODER_READY) {
      trackEvent('captura_recording_start', {
        fps:         payload?.fps,
        quality:     payload?.quality,
        format:      payload?.format,
        has_webcam:  payload?.webcamSelected,
        has_mic:     payload?.micSelected,
        sys_audio:   payload?.wantSysAudio,
      });
      void startLiveTranscriptionForRecording();
    } else if (event === EVENT.USER_RESUME) {
      trackEvent('captura_recording_resume', { elapsed_secs: elapsedSecs });
      transcriptionController.resumeLiveTranscription();
      if (isLiveTranscriptionEnabled()) {
        setLiveTranscriptBadge('Ouvindo', 'badge bg-success');
        setTranscriptionStatus('Transcrição ao vivo retomada.', 'muted');
      }
    }
  } else if (state === STATE.PAUSED) {
    trackEvent('captura_recording_pause', { elapsed_secs: elapsedSecs });
    transcriptionController.pauseLiveTranscription();
    if (isLiveTranscriptionEnabled()) setLiveTranscriptBadge('Pausado', 'badge bg-secondary');
  } else if (state === STATE.STOPPING) {
    trackEvent('captura_recording_stop', { elapsed_secs: elapsedSecs, format: formatSel.value });
    void stopLiveTranscription({ preserveBadge: true }).then(() => {
      if (isLiveTranscriptionEnabled()) setLiveTranscriptBadge('Finalizando', 'badge bg-info');
    });
  } else if (state === STATE.IDLE && event === EVENT.END_SESSION) {
    trackEvent('captura_session_end');
  }

  if (event === EVENT.STREAMS_FAILED) {
    trackEvent('captura_stream_failed', { error_name: payload?.name ?? 'unknown' });
  } else if (state === STATE.ERROR) {
    trackEvent('captura_error', { error_message: payload?.message ?? String(payload ?? '') });
    void stopLiveTranscription();
    setLiveTranscriptBadge('Erro', 'badge bg-danger');
  }

  if (event === EVENT.FINALIZE_DONE && payload) {
    trackEvent('captura_recording_saved', { format: formatSel.value });
    void showSaveSuccessToast(payload);
    void finalizeSavedRecordingTranscript(payload);
  }

  if (state === STATE.RECORDING) {
    if (event === EVENT.USER_RESUME) resumeTimer();
    else startTimer();
  } else if (state === STATE.PAUSED) {
    pauseTimer();
  } else {
    resetTimer();
  }

  if (state === STATE.RECORDING) {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
    setupMediaSession(
      () => machine.transition(EVENT.USER_RESUME, { fps: parseInt(fpsSel.value, 10) }),
      () => machine.transition(EVENT.USER_PAUSE),
      () => machine.transition(EVENT.USER_STOP),
    );
  } else if (state === STATE.PAUSED) {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
  } else {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
    clearMediaSession();
  }

  if (state === STATE.ERROR) {
    showErrorDialog(
      payload?.title   || 'Erro de gravação',
      payload?.message || String(payload ?? 'Ocorreu um erro desconhecido.'),
      payload
    );
  }

  if ((state === STATE.IDLE || state === STATE.SESSION) && !recordingTranscriptInFlight && !isLiveTranscriptionEnabled()) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
  }

  refreshAdvisoryUi();

  if (state === STATE.IDLE || state === STATE.SESSION) {
    syncDevicesToApi();
  }
});

// ── Recorder helpers ───────────────────────────────────────────────────────────

function syncDevicesToApi() {
  const mp3Mode = isMp3Format(formatSel.value);
  api.setDevices({
    webcamDeviceId: webcamSel.value,
    webcamSelected: !mp3Mode && webcamSel.selectedIndex > 0,
    micDeviceId:    micSel.value,
    micSelected:    micSel.selectedIndex > 0,
  });
}

function buildStartPayload() {
  syncDevicesToApi();
  const mp3Mode = isMp3Format(formatSel.value);
  return {
    fps:            fpsSel.value,
    quality:        qualitySel.value,
    format:         formatSel.value,
    wantSysAudio:   sysAudioChk.checked,
    webcamSelected: !mp3Mode && webcamSel.selectedIndex > 0,
    webcamDeviceId: webcamSel.value,
    micSelected:    micSel.selectedIndex > 0,
    micDeviceId:    micSel.value,
    micGain:        parseFloat(micGainSlider.value),
    sysGain:        parseFloat(sysGainSlider.value),
  };
}

async function showSaveSuccessToast(fileHandle) {
  const msg = document.createDocumentFragment();
  msg.append('Gravação salva no disco. ');
  if (fileHandle) {
    try {
      const file = await fileHandle.getFile();
      const url  = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), {
        href: url, target: '_blank', rel: 'noopener noreferrer',
        textContent: 'Abrir em nova aba', className: 'toast-link',
      });
      msg.append(link);
      setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_TIMEOUT_MS);
      window.addEventListener('beforeunload', () => URL.revokeObjectURL(url), { once: true });
    } catch (_) {
      // getFile() may fail if the user moved/deleted the file; skip the link.
    }
  }
  showToast(msg, 'success');
}

function getExpectedAudioBitrate() {
  return (micSel.selectedIndex > 0 || sysAudioChk.checked) ? AUDIO_BITRATE : 0;
}

function getExpectedTotalBitrate() {
  if (isMp3Format(formatSel.value)) return getExpectedAudioBitrate();
  return (VIDEO_BITRATES[qualitySel.value] ?? VIDEO_BITRATES['720']) + getExpectedAudioBitrate();
}

function getEstimateSeconds() {
  const active = machine.state === STATE.RECORDING || machine.state === STATE.PAUSED;
  return active ? elapsedSecs : ONE_HOUR_SECONDS;
}

function updateRecordingEstimate() {
  const bitrate = getExpectedTotalBitrate();
  if (!recordingEstimateEl) return;
  if (bitrate <= 0) {
    recordingEstimateEl.textContent = isMp3Format(formatSel.value)
      ? 'Selecione um microfone ou ative o áudio do sistema para MP3.'
      : 'Selecione fontes de áudio para incluí-las na estimativa.';
    return;
  }

  const label = (machine.state === STATE.RECORDING || machine.state === STATE.PAUSED)
    ? 'Tamanho estimado'
    : 'Estimativa de 1h';
  const estimatedBytes = (bitrate / 8) * getEstimateSeconds();
  recordingEstimateEl.textContent = `${label}: ${fmtBytes(estimatedBytes)}`;
}

function updateFormatHint() {
  if (!formatHintEl) return;
  if (!isMp3Format(formatSel.value)) {
    formatHintEl.textContent = '';
    return;
  }

  formatHintEl.textContent = sysAudioChk.checked
    ? 'MP3 com áudio do sistema ainda exige compartilhamento de tela.'
    : micSel.selectedIndex > 0
      ? 'MP3 grava apenas o microfone e dispensa compartilhamento de tela.'
      : 'MP3 precisa de microfone ou áudio do sistema ativo.';
}

function updateLongRecordingAlert() {
  if (!longRecordingAlertEl) return;

  if (isMp3Format(formatSel.value)) {
    longRecordingAlertEl.hidden = true;
    longRecordingAlertEl.textContent = '';
    return;
  }

  const heavyVideoProfile = qualitySel.value !== '480' || fpsSel.value !== '15' || webcamSel.selectedIndex > 0;
  longRecordingAlertEl.hidden = false;
  longRecordingAlertEl.className = `alert ${heavyVideoProfile ? 'alert-warning' : 'alert-info'} py-2 small mb-0`;
  longRecordingAlertEl.textContent = heavyVideoProfile
    ? 'Reunião longa? Esta configuração de vídeo pode gerar arquivos grandes. Para gravações longas, prefira 480p a 15 fps, desative a webcam se ela for opcional ou use MP3 quando só precisar do áudio.'
    : 'Este é o perfil de vídeo mais leve disponível. Ainda assim, MP3 ocupa bem menos espaço quando você só precisa do áudio.';
}

function refreshAdvisoryUi() {
  updateFormatHint();
  updateLongRecordingAlert();
  updateRecordingEstimate();
}

// ── Device enumeration ────────────────────────────────────────────────────────

async function enumerateDevices() {
  try {
    const devices   = await navigator.mediaDevices.enumerateDevices();
    const videoDevs = devices.filter(d => d.kind === 'videoinput');
    const audioDevs = devices.filter(d => d.kind === 'audioinput');

    webcamSel.innerHTML = '<option value="">Nenhuma</option>';
    videoDevs.forEach((d, i) => webcamSel.add(new Option(d.label || `Câmera ${i + 1}`, d.deviceId)));

    micSel.innerHTML = '<option value="">Nenhum</option>';
    audioDevs.forEach((d, i) => micSel.add(new Option(d.label || `Microfone ${i + 1}`, d.deviceId)));

    restoreDevicePrefs();
    refreshAdvisoryUi();

    const s = machine.state;
    if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
      syncDevicesToApi();
      api.restartPreviews();
    }
  } catch (err) {
    showErrorDialog('Erro de dispositivos', 'Não foi possível listar os dispositivos: ' + err.message, err);
  }
}

// ── Preferences ────────────────────────────────────────────────────────────────

function restoreDetailsPref(detailsEl, prefKey) {
  const pref = loadPref(prefKey);
  if (pref !== null) detailsEl.open = pref === 'true';
}

function restoreSimplePrefs() {
  const fps = loadPref(PREFS.fps);
  if (fps) fpsSel.value = fps;

  const quality = loadPref(PREFS.quality);
  if (quality) qualitySel.value = quality;

  const format = loadPref(PREFS.format);
  if (format) formatSel.value = format;

  const sysAudio = loadPref(PREFS.sysAudio);
  if (sysAudio !== null) sysAudioChk.checked = sysAudio === 'true';

  const storedPipX = loadPref(PREFS.pipX);
  const storedPipY = loadPref(PREFS.pipY);
  if (storedPipX !== null && storedPipY !== null) {
    compositor.pipX = parseFloat(storedPipX);
    compositor.pipY = parseFloat(storedPipY);
  }

  const micGain = loadPref(PREFS.micGain);
  if (micGain !== null) {
    micGainSlider.value      = micGain;
    micGainLabel.textContent = gainPct(micGain);
  }

  const sysGain = loadPref(PREFS.sysGain);
  if (sysGain !== null) {
    sysGainSlider.value      = sysGain;
    sysGainLabel.textContent = gainPct(sysGain);
  }

  const liveTranscriptionPref = loadPref(PREFS.liveTranscriptionEnabled);
  if (liveTranscriptionPref !== null) {
    liveTranscriptionChk.checked = liveTranscriptionPref === 'true';
  }

  const savedPrompt = loadPref(PREFS.transcriptionPrompt);
  if (savedPrompt !== null) transcriptionPromptEl.value = savedPrompt;

  const savedTranscriptionMode = loadPref(PREFS.transcriptionMode);
  if (savedTranscriptionMode && transcriptionModeSel.querySelector(`option[value="${CSS.escape(savedTranscriptionMode)}"]`)) {
    transcriptionModeSel.value = savedTranscriptionMode;
  }

  const savedPostProcessPrompt = loadPref(PREFS.postProcessPrompt);
  if (savedPostProcessPrompt !== null) postProcessPromptEl.value = savedPostProcessPrompt;

  restoreDetailsPref(openAiPanel, PREFS.openAiPanelOpen);
  restoreDetailsPref(transcriptionPanel, PREFS.transcriptionPanelOpen);
  updateTranscriptionModeHint();
}

function restoreDevicePrefs() {
  const webcamId = loadPref(PREFS.webcam);
  if (webcamId && webcamSel.querySelector(`option[value="${CSS.escape(webcamId)}"]`)) {
    webcamSel.value = webcamId;
  }
  const micId = loadPref(PREFS.mic);
  if (micId && micSel.querySelector(`option[value="${CSS.escape(micId)}"]`)) {
    micSel.value = micId;
  }
}

async function initializeStorageAndLibrary() {
  if (!hasFSA) return;
  await storage.init();
  await refreshMediaLibrary({ silent: true });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

if (!hasGetDisplayMedia) {
  showAlert(
    'A captura de tela não está disponível neste navegador. ' +
    'A gravação de vídeo e o áudio do sistema não funcionarão aqui, mas a gravação MP3 apenas com microfone ainda pode funcionar.',
    'warning'
  );
} else if (!hasFSA) {
  showAlert(
    'Seu navegador não oferece suporte à File System Access API, necessária para ' +
    'gravar vídeo diretamente no disco. Abra esta página no Chrome ou no Edge para usar o gravador.',
    'warning'
  );
  recorderUi.hidden = true;
  transcriptionUi.hidden = true;
}

restoreSimplePrefs();
if (!hasGetDisplayMedia) sysAudioChk.checked = false;
refreshAdvisoryUi();
render(machine.state);
updateLibrarySummary();
clearSelectedMediaState();
setTranscriptionStatus('Nenhuma transcrição em andamento.', 'muted');
setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
setPostProcessStatus('Escolha um arquivo e uma versão da transcrição para executar o pós-processamento.', 'muted');

trackEvent('captura_page_view', {
  has_screen_capture:  hasGetDisplayMedia,
  has_file_system_api: hasFSA,
});

if (hasGetDisplayMedia) {
  navigator.mediaDevices.addEventListener('devicechange', enumerateDevices);
  void enumerateDevices();
}

api.restartPreviews();
void initializeStorageAndLibrary();

// ── Event listeners ────────────────────────────────────────────────────────────

startBtn.addEventListener('click', () => {
  if (!hasGetDisplayMedia && (!isMp3Format(formatSel.value) || sysAudioChk.checked)) {
    showErrorDialog(
      'Não suportado',
      'Este navegador não consegue capturar a tela. Use MP3 apenas com microfone ou troque para um navegador desktop com suporte a captura de tela.'
    );
    return;
  }
  machine.transition(EVENT.USER_START, buildStartPayload());
});

pauseBtn.addEventListener('click', () => {
  if (machine.state === STATE.PAUSED) {
    machine.transition(EVENT.USER_RESUME, { fps: parseInt(fpsSel.value, 10) });
  } else {
    machine.transition(EVENT.USER_PAUSE);
  }
});

stopBtn.addEventListener('click', () => machine.transition(EVENT.USER_STOP));
micToggleBtn.addEventListener('click', () => {
  const muted = api.setMicMuted(!api.isMicMuted);
  trackEvent('captura_mic_toggle', { muted });
  render(machine.state);
});

endSessionBtn.addEventListener('click', () => machine.transition(EVENT.END_SESSION));

pickDirBtn.addEventListener('click', async () => {
  trackEvent('captura_folder_pick');
  const picked = await storage.pickDirectory();
  if (picked) await refreshMediaLibrary({ silent: true });
});

refreshLibraryBtn.addEventListener('click', async () => {
  if (!storage.dirHandle) {
    const picked = await storage.pickDirectory();
    if (!picked) return;
  }
  await refreshMediaLibrary({ silent: false });
});

transcribeSelectedBtn.addEventListener('click', () => {
  void transcribeSelectedMedia({ alwaysVersion: false });
});

transcribeNewVersionBtn.addEventListener('click', () => {
  void transcribeSelectedMedia({ alwaysVersion: true });
});

transcriptVersionSel.addEventListener('change', () => {
  if (selectedMediaEntry?.name) {
    selectedTranscriptNameByMedia.set(selectedMediaEntry.name, transcriptVersionSel.value);
  }
  void loadSelectedTranscript();
});

processSelectedTranscriptBtn.addEventListener('click', () => {
  void processSelectedTranscript();
});

postProcessPresetSel.addEventListener('change', () => {
  applyPostProcessPreset(postProcessPresetSel.value);
});

openAiKeyForm?.addEventListener('submit', event => event.preventDefault());

openAiApiKeyToggleBtn.addEventListener('click', () => {
  const reveal = openAiApiKeyInput.type === 'password';
  openAiApiKeyInput.type = reveal ? 'text' : 'password';
  openAiApiKeyToggleBtn.textContent = reveal ? 'Ocultar' : 'Mostrar';
});

openAiPanel.addEventListener('toggle', () => {
  savePref(PREFS.openAiPanelOpen, String(openAiPanel.open));
});

transcriptionPanel.addEventListener('toggle', () => {
  savePref(PREFS.transcriptionPanelOpen, String(transcriptionPanel.open));
});

liveTranscriptionChk.addEventListener('change', () => {
  savePref(PREFS.liveTranscriptionEnabled, String(liveTranscriptionChk.checked));
  trackEvent('captura_pref_change', { pref: 'live_transcription', value: String(liveTranscriptionChk.checked) });
  if (!liveTranscriptionChk.checked && machine.state !== STATE.RECORDING && machine.state !== STATE.PAUSED) {
    setLiveTranscriptBadge('Inativo', 'badge bg-secondary');
  }
  render(machine.state);
});

transcriptionPromptEl.addEventListener('input', () => {
  savePref(PREFS.transcriptionPrompt, transcriptionPromptEl.value);
});

transcriptionModeSel.addEventListener('change', () => {
  savePref(PREFS.transcriptionMode, transcriptionModeSel.value);
  trackEvent('captura_pref_change', { pref: 'transcription_mode', value: transcriptionModeSel.value });
  updateTranscriptionModeHint();
  render(machine.state);
});

postProcessPromptEl.addEventListener('input', () => {
  savePref(PREFS.postProcessPrompt, postProcessPromptEl.value);
});

postProcessCopyBtn.addEventListener('click', async () => {
  try {
    await copyTextToClipboard(postProcessOutputEl.value);
    showToast('Resultado copiado para a área de transferência.', 'success');
  } catch (error) {
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: false,
    });
  }
});

postProcessSaveBtn.addEventListener('click', async () => {
  try {
    await savePostProcessOutput();
  } catch (error) {
    handleTranscriptionError(error, {
      toast: true,
      dialog: false,
      updateTranscriptPane: false,
      updateLivePane: false,
    });
  }
});

errorDialog?.addEventListener('close', () => {
  if (machine.state === STATE.ERROR) {
    machine.transition(EVENT.ERROR_DISMISSED);
  }
});

function saveAndTrackPref(key, value, analyticsKey) {
  savePref(key, value);
  trackEvent('captura_pref_change', { pref: analyticsKey, value: String(value) });
  refreshAdvisoryUi();
  render(machine.state);
}

fpsSel.addEventListener('change', () => saveAndTrackPref(PREFS.fps, fpsSel.value, 'fps'));
qualitySel.addEventListener('change', () => saveAndTrackPref(PREFS.quality, qualitySel.value, 'quality'));
formatSel.addEventListener('change', () => saveAndTrackPref(PREFS.format, formatSel.value, 'format'));
sysAudioChk.addEventListener('change', () => saveAndTrackPref(PREFS.sysAudio, sysAudioChk.checked, 'sys_audio'));

webcamSel.addEventListener('change', () => {
  savePref(PREFS.webcam, webcamSel.value);
  refreshAdvisoryUi();
  const s = machine.state;
  if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
    syncDevicesToApi();
    api.restartPreviews();
  }
});

micSel.addEventListener('change', () => {
  savePref(PREFS.mic, micSel.value);
  refreshAdvisoryUi();
  const s = machine.state;
  if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
    syncDevicesToApi();
    api.restartPreviews();
  }
});

micGainSlider.addEventListener('input', () => {
  const v = parseFloat(micGainSlider.value);
  micGainLabel.textContent = gainPct(v);
  audioMixer.setMicGain(v);
  savePref(PREFS.micGain, v);
});

sysGainSlider.addEventListener('input', () => {
  const v = parseFloat(sysGainSlider.value);
  sysGainLabel.textContent = gainPct(v);
  audioMixer.setSysGain(v);
  savePref(PREFS.sysGain, v);
});

window.addEventListener('beforeunload', () => {
  revokeSelectedPreviewUrl();
});

// ── PWA Service Worker Registration ───────────────────────────────────────────

registerServiceWorker();
