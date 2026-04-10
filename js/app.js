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
import { OpenAIClientManager, OpenAIConfigError } from './openai-client.js';
import { TranscriptionController }               from './transcription-controller.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const BLOB_URL_REVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const FORMAT_MP3                 = 'mp3-audio-only';
const AUDIO_BITRATE              = 128_000;
const VIDEO_BITRATES             = { '480': 2_000_000, '720': 4_000_000, '1080': 8_000_000 };
const ONE_HOUR_SECONDS           = 60 * 60;
const STATUS_CLASS = {
  muted:   'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
};

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
const transcriptionStatusEl  = document.getElementById('transcription-status');
const liveTranscriptOutputEl = document.getElementById('live-transcript-output');
const liveTranscriptBadgeEl  = document.getElementById('live-transcript-badge');
const refreshLibraryBtn      = document.getElementById('refresh-library-btn');
const mediaFileListEl        = document.getElementById('media-file-list');
const librarySummaryEl       = document.getElementById('library-summary');
const selectedMediaLabelEl   = document.getElementById('selected-media-label');
const selectedMediaKindEl    = document.getElementById('selected-media-kind');
const selectedVideoPlayerEl  = document.getElementById('selected-video-player');
const selectedAudioPlayerEl  = document.getElementById('selected-audio-player');
const mediaPreviewPlaceholderEl = document.getElementById('media-preview-placeholder');
const transcribeSelectedBtn  = document.getElementById('transcribe-selected-btn');
const transcribeNewVersionBtn = document.getElementById('transcribe-new-version-btn');
const transcriptVersionSel   = document.getElementById('transcript-version-select');
const selectedTranscriptStatusEl = document.getElementById('selected-transcript-status');
const transcriptViewerEl     = document.getElementById('transcript-viewer');

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
    setTranscriptionStatus('Live transcript updated.', 'success');
    setLiveTranscriptBadge('Listening', 'badge bg-success');
  },
  onStatus: payload => {
    if (payload?.message) setTranscriptionStatus(payload.message, 'muted');
  },
  onError: error => {
    setTranscriptionStatus(error.message || 'Live transcription failed.', 'danger');
    setLiveTranscriptBadge('Error', 'badge bg-danger');
  },
});

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

function setLiveTranscriptBadge(label, className) {
  liveTranscriptBadgeEl.textContent = label;
  liveTranscriptBadgeEl.className = className;
}

function openOpenAiPanel() {
  openAiPanel.open = true;
  savePref(PREFS.openAiPanelOpen, 'true');
}

function getTranscriptionPrompt() {
  return transcriptionPromptEl.value.trim();
}

function isLiveTranscriptionEnabled() {
  return liveTranscriptionChk.checked;
}

function revokeSelectedPreviewUrl() {
  if (!selectedPreviewUrl) return;
  URL.revokeObjectURL(selectedPreviewUrl);
  selectedPreviewUrl = null;
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

function clearTranscriptViewer(message = 'The selected transcript will be displayed here.') {
  transcriptViewerEl.value = '';
  transcriptViewerEl.placeholder = message;
}

function clearSelectedMediaState(message = 'Select a file from the chosen folder to preview it and inspect the related transcript.') {
  selectedMediaEntry = null;
  selectedTranscriptEntries = [];
  selectedMediaLabelEl.textContent = 'No file selected';
  selectedMediaKindEl.textContent = 'Idle';
  selectedMediaKindEl.className = 'badge bg-secondary';
  resetMediaPreview();
  mediaPreviewPlaceholderEl.textContent = message;
  transcriptVersionSel.innerHTML = '<option value="">No transcript yet</option>';
  transcriptVersionSel.disabled = true;
  clearTranscriptViewer();
  setSelectedTranscriptStatus('Pick a file to load its transcript.', 'muted');
}

function buildMediaListItem(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'list-group-item list-group-item-action';
  button.dataset.name = entry.name;

  const top = document.createElement('div');
  top.className = 'd-flex align-items-center justify-content-between gap-2';

  const name = document.createElement('span');
  name.className = 'text-truncate';
  name.textContent = entry.name;

  const badge = document.createElement('span');
  badge.className = entry.kind === 'video' ? 'badge bg-primary' : 'badge bg-secondary';
  badge.textContent = entry.kind === 'video' ? 'Video' : 'Audio';

  top.append(name, badge);

  const bottom = document.createElement('div');
  bottom.className = 'd-flex align-items-center justify-content-between gap-2 mt-1';

  const transcriptLabel = document.createElement('small');
  transcriptLabel.className = 'text-muted';
  transcriptLabel.textContent = entry.transcriptCount
    ? `${entry.transcriptCount} transcript${entry.transcriptCount === 1 ? '' : 's'}`
    : 'No transcript yet';

  bottom.append(transcriptLabel);
  button.append(top, bottom);
  return button;
}

function renderMediaFileList() {
  mediaFileListEl.replaceChildren();

  if (!libraryEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'list-group-item text-muted small';
    empty.textContent = storage.dirHandle
      ? 'No supported audio or video files were found in the selected folder root.'
      : 'Choose a folder to list its audio and video files.';
    mediaFileListEl.appendChild(empty);
    return;
  }

  libraryEntries.forEach(entry => {
    const item = buildMediaListItem(entry);
    item.disabled = transcriptionBusy;
    if (selectedMediaEntry?.name === entry.name) item.classList.add('active');
    item.addEventListener('click', () => {
      void selectMediaEntryByName(entry.name);
    });
    mediaFileListEl.appendChild(item);
  });
}

function updateLibrarySummary() {
  if (!storage.dirHandle) {
    librarySummaryEl.textContent = 'Select a folder to browse audio and video files.';
    return;
  }

  if (!libraryEntries.length) {
    librarySummaryEl.textContent = `No supported media files found in ${storage.dirHandle.name}.`;
    return;
  }

  librarySummaryEl.textContent = `${libraryEntries.length} media file${libraryEntries.length === 1 ? '' : 's'} found in ${storage.dirHandle.name}.`;
}

function handleTranscriptionError(error, {
  toast = true,
  dialog = false,
  updateTranscriptPane = false,
  updateLivePane = true,
} = {}) {
  const title = error?.title || 'Transcription Error';
  const message = error?.message || String(error ?? 'Unknown transcription error.');

  if (updateLivePane) setTranscriptionStatus(message, 'danger');
  if (updateTranscriptPane) setSelectedTranscriptStatus(message, 'danger');

  if (toast) showToast(message, 'danger');
  if (dialog) showErrorDialog(title, message);
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
    transcriptVersionSel.add(new Option('No transcript yet', ''));
    transcriptVersionSel.disabled = true;
    clearTranscriptViewer('This file does not have a saved transcript yet.');
    setSelectedTranscriptStatus('No transcript saved for this file yet.', 'muted');
    return;
  }

  selectedTranscriptEntries.forEach(entry => {
    transcriptVersionSel.add(new Option(entry.name, entry.name));
  });
  transcriptVersionSel.disabled = false;

  const preferred = selectedTranscriptEntries.find(entry => entry.name === preferredTranscriptName);
  transcriptVersionSel.value = preferred?.name || selectedTranscriptEntries[0].name;
  await loadSelectedTranscript();
}

async function loadSelectedTranscript() {
  const transcriptName = transcriptVersionSel.value;
  const transcriptEntry = selectedTranscriptEntries.find(entry => entry.name === transcriptName);

  if (!transcriptEntry) {
    clearTranscriptViewer('This file does not have a saved transcript yet.');
    setSelectedTranscriptStatus('No transcript saved for this file yet.', 'muted');
    return;
  }

  const transcriptText = await mediaLibrary.readTranscript(transcriptEntry.handle);
  transcriptViewerEl.value = transcriptText;
  setSelectedTranscriptStatus(`Showing ${transcriptEntry.name}.`, 'success');
}

async function selectMediaEntryByName(mediaName, preferredTranscriptName = '') {
  const entry = libraryEntries.find(item => item.name === mediaName);
  if (!entry) return;

  selectedMediaEntry = entry;
  renderMediaFileList();
  selectedMediaLabelEl.textContent = entry.name;
  selectedMediaKindEl.textContent = entry.kind === 'video' ? 'Video' : 'Audio';
  selectedMediaKindEl.className = entry.kind === 'video' ? 'badge bg-primary' : 'badge bg-secondary';

  try {
    await loadMediaPreview(entry);
    await loadTranscriptEntries(entry.name, preferredTranscriptName);
  } catch (error) {
    clearTranscriptViewer();
    setSelectedTranscriptStatus('Could not load the selected file.', 'danger');
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
    clearSelectedMediaState('No supported audio or video files were found in the selected folder root.');
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

  trackEvent('captura_transcription_start', { file_name: mediaName, force_new_version: alwaysVersion });
  transcriptionBusy = true;
  renderMediaFileList();
  render(machine.state);
  setSelectedTranscriptStatus(`Preparing ${mediaName} for transcription…`, 'muted');
  setTranscriptionStatus(`Preparing ${mediaName} for transcription…`, 'muted');

  try {
    const result = await transcriptionController.transcribeFileHandle(mediaHandle, {
      prompt: getTranscriptionPrompt(),
      alwaysVersion,
      onProgress: payload => {
        if (payload?.message) {
          setSelectedTranscriptStatus(payload.message, 'muted');
          setTranscriptionStatus(payload.message, 'muted');
        }
      },
    });

    showToast(`Transcript saved as ${result.fileName}.`, 'success');
    setSelectedTranscriptStatus(`Transcript saved as ${result.fileName}.`, 'success');
    setTranscriptionStatus(`Transcript saved as ${result.fileName}.`, 'success');
    trackEvent('captura_transcription_saved', { file_name: mediaName, transcript_name: result.fileName });
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

async function startLiveTranscriptionForRecording() {
  if (!isLiveTranscriptionEnabled()) {
    setLiveTranscriptBadge('Inactive', 'badge bg-secondary');
    return;
  }

  try {
    openAiClient.assertConfigured();
  } catch (error) {
    setLiveTranscriptBadge('Key Needed', 'badge bg-danger');
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
    setLiveTranscriptBadge('No Audio', 'badge bg-secondary');
    setTranscriptionStatus('Live transcription skipped because this recording has no active audio source.', 'warning');
    return;
  }

  liveTranscriptOutputEl.value = '';
  setLiveTranscriptBadge('Starting', 'badge bg-info text-dark');
  setTranscriptionStatus('Starting live transcription…', 'muted');

  try {
    await transcriptionController.startLiveTranscription({
      track,
      prompt: getTranscriptionPrompt(),
    });
    setLiveTranscriptBadge('Listening', 'badge bg-success');
    trackEvent('captura_live_transcription_start');
  } catch (error) {
    track.stop();
    setLiveTranscriptBadge('Error', 'badge bg-danger');
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
    setLiveTranscriptBadge('Inactive', 'badge bg-secondary');
  }
  return liveText;
}

async function finalizeSavedRecordingTranscript(fileHandle) {
  if (!isLiveTranscriptionEnabled() || !fileHandle) {
    setLiveTranscriptBadge('Inactive', 'badge bg-secondary');
    return;
  }

  transcriptionBusy = true;
  recordingTranscriptInFlight = true;
  renderMediaFileList();
  render(machine.state);
  setLiveTranscriptBadge('Finalizing', 'badge bg-info text-dark');
  setTranscriptionStatus('Transcribing the saved recording…', 'muted');

  let preferredTranscriptName = '';

  try {
    const liveText = await pendingLiveStopPromise;
    if (liveText.trim()) {
      const liveResult = await mediaLibrary.writeTranscript(fileHandle.name, liveText, { variant: 'live' });
      preferredTranscriptName = liveResult.fileName;
      setTranscriptionStatus(`Live transcript saved as ${liveResult.fileName}.`, 'success');
      trackEvent('captura_live_transcript_saved', { transcript_name: liveResult.fileName });
    }

    const result = await transcriptionController.transcribeFileHandle(fileHandle, {
      prompt: getTranscriptionPrompt(),
      onProgress: payload => {
        if (payload?.message) setTranscriptionStatus(payload.message, 'muted');
      },
    });

    preferredTranscriptName = result.fileName;
    showToast(`Transcript saved as ${result.fileName}.`, 'success');
    setTranscriptionStatus(`Transcript saved as ${result.fileName}.`, 'success');
    setLiveTranscriptBadge('Saved', 'badge bg-success');
    trackEvent('captura_recording_transcript_saved', { transcript_name: result.fileName });

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
    setLiveTranscriptBadge('Error', 'badge bg-danger');
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
    ? '<i class="fas fa-play me-1"></i>Resume'
    : '<i class="fas fa-pause me-1"></i>Pause';
  pauseBtn.className = isPaused ? 'btn btn-success' : 'btn btn-warning text-dark';

  stopBtn.hidden   = !active;
  stopBtn.disabled = false;

  micToggleBtn.hidden   = !active || !api.hasActiveMic;
  micToggleBtn.disabled = !active || !api.hasActiveMic;
  micToggleBtn.innerHTML = api.isMicMuted
    ? '<i class="fas fa-microphone me-1"></i>Unmute Mic'
    : '<i class="fas fa-microphone-slash me-1"></i>Mute Mic';
  micToggleBtn.className = api.isMicMuted ? 'btn btn-success' : 'btn btn-danger';

  endSessionBtn.hidden   = !hasSession;
  endSessionBtn.disabled = isStopping || isReq;

  const lockControls = active || isStopping || isReq || transcriptionBusy;
  const mp3Mode = isMp3Format(formatSel.value);

  pickDirBtn.disabled     = lockControls;
  webcamSel.disabled      = lockControls || mp3Mode;
  micSel.disabled         = lockControls;
  sysAudioChk.disabled    = lockControls || !hasGetDisplayMedia;
  fpsSel.disabled         = lockControls || mp3Mode;
  qualitySel.disabled     = lockControls || mp3Mode;
  formatSel.disabled      = lockControls;
  liveTranscriptionChk.disabled = lockControls;
  transcriptionPromptEl.disabled = lockControls;
  openAiApiKeyInput.disabled = lockControls;
  openAiApiKeyToggleBtn.disabled = lockControls;
  refreshLibraryBtn.disabled = lockControls || !storage.dirHandle;
  transcribeSelectedBtn.disabled = lockControls || !selectedMediaEntry;
  transcribeNewVersionBtn.disabled = lockControls || !selectedMediaEntry;
  transcriptVersionSel.disabled = lockControls || selectedTranscriptEntries.length === 0;

  statusBadge.textContent =
      isRec      ? '⏺ Recording'
    : isPaused   ? '⏸ Paused'
    : isReq      ? '⏳ Acquiring…'
    : isStopping ? '⏳ Saving…'
    : isSession  ? '◉ Session Active'
    : isError    ? '⚠ Error'
    :              'Idle';

  statusBadge.className =
      isRec                    ? 'badge bg-danger'
    : isPaused || isStopping   ? 'badge bg-warning text-dark'
    : isSession                ? 'badge bg-warning text-dark'
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
        setLiveTranscriptBadge('Listening', 'badge bg-success');
        setTranscriptionStatus('Live transcription resumed.', 'muted');
      }
    }
  } else if (state === STATE.PAUSED) {
    trackEvent('captura_recording_pause', { elapsed_secs: elapsedSecs });
    transcriptionController.pauseLiveTranscription();
    if (isLiveTranscriptionEnabled()) setLiveTranscriptBadge('Paused', 'badge bg-warning text-dark');
  } else if (state === STATE.STOPPING) {
    trackEvent('captura_recording_stop', { elapsed_secs: elapsedSecs, format: formatSel.value });
    void stopLiveTranscription({ preserveBadge: true }).then(() => {
      if (isLiveTranscriptionEnabled()) setLiveTranscriptBadge('Finalizing', 'badge bg-info text-dark');
    });
  } else if (state === STATE.IDLE && event === EVENT.END_SESSION) {
    trackEvent('captura_session_end');
  }

  if (event === EVENT.STREAMS_FAILED) {
    trackEvent('captura_stream_failed', { error_name: payload?.name ?? 'unknown' });
  } else if (state === STATE.ERROR) {
    trackEvent('captura_error', { error_message: payload?.message ?? String(payload ?? '') });
    void stopLiveTranscription();
    setLiveTranscriptBadge('Error', 'badge bg-danger');
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
      payload?.title   || 'Recording Error',
      payload?.message || String(payload ?? 'An unknown error occurred.')
    );
  }

  if ((state === STATE.IDLE || state === STATE.SESSION) && !recordingTranscriptInFlight && !isLiveTranscriptionEnabled()) {
    setLiveTranscriptBadge('Inactive', 'badge bg-secondary');
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
  msg.append('Recording saved to disk. ');
  if (fileHandle) {
    try {
      const file = await fileHandle.getFile();
      const url  = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), {
        href: url, target: '_blank', rel: 'noopener noreferrer',
        textContent: 'Open in new tab', className: 'toast-link',
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
      ? 'Select a microphone or enable system audio for MP3.'
      : 'Select audio sources to include them in the estimate.';
    return;
  }

  const label = (machine.state === STATE.RECORDING || machine.state === STATE.PAUSED)
    ? 'Estimated file size'
    : '1h estimate';
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
    ? 'MP3 with system audio still requires screen share.'
    : micSel.selectedIndex > 0
      ? 'MP3 records microphone only and skips screen share.'
      : 'MP3 needs a microphone or system audio enabled.';
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
    ? 'Long meeting? This video setup can produce large files. For safer long recordings, prefer 480p at 15 fps, disable webcam if optional, or switch to MP3 when you only need audio.'
    : 'This is the lightest video profile available here. MP3 will still use much less space if the meeting only needs audio.';
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

    webcamSel.innerHTML = '<option value="">None</option>';
    videoDevs.forEach((d, i) => webcamSel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));

    micSel.innerHTML = '<option value="">None</option>';
    audioDevs.forEach((d, i) => micSel.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));

    restoreDevicePrefs();
    refreshAdvisoryUi();

    const s = machine.state;
    if (s !== STATE.RECORDING && s !== STATE.PAUSED && s !== STATE.STOPPING) {
      syncDevicesToApi();
      api.restartPreviews();
    }
  } catch (err) {
    showErrorDialog('Device Error', 'Could not enumerate devices: ' + err.message);
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

  restoreDetailsPref(openAiPanel, PREFS.openAiPanelOpen);
  restoreDetailsPref(transcriptionPanel, PREFS.transcriptionPanelOpen);
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
    'Screen capture is not available in this browser. ' +
    'Video recording and system-audio capture are unavailable here, but MP3 microphone-only recording can still work.',
    'warning'
  );
} else if (!hasFSA) {
  showAlert(
    'Your browser does not support the File System Access API, which this recorder requires to ' +
    'stream video directly to disk. Please open this page in Chrome or Edge to use the recorder.',
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
setTranscriptionStatus('No transcription running.', 'muted');
setLiveTranscriptBadge('Inactive', 'badge bg-secondary');

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
      'Not Supported',
      'This browser cannot capture the screen. Use MP3 with microphone only, or switch to a desktop browser with screen-capture support.'
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
  void loadSelectedTranscript();
});

openAiKeyForm?.addEventListener('submit', event => event.preventDefault());

openAiApiKeyToggleBtn.addEventListener('click', () => {
  const reveal = openAiApiKeyInput.type === 'password';
  openAiApiKeyInput.type = reveal ? 'text' : 'password';
  openAiApiKeyToggleBtn.textContent = reveal ? 'Hide' : 'Show';
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
    setLiveTranscriptBadge('Inactive', 'badge bg-secondary');
  }
  render(machine.state);
});

transcriptionPromptEl.addEventListener('input', () => {
  savePref(PREFS.transcriptionPrompt, transcriptionPromptEl.value);
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
