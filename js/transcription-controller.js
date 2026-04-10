import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';

const SAFE_UPLOAD_BYTES = 24 * 1024 * 1024;
const LIVE_CHUNK_MS = 10_000;
const NORMALIZED_BITRATE = '64k';
const NORMALIZED_SAMPLE_RATE = '24000';
const FILE_CHUNK_SECONDS = 10 * 60;
const FILE_CHUNK_OVERLAP_SECONDS = 2;

let ffmpegPromise = null;

function getExtension(fileName) {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function getLiveChunkMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function blobToFile(blob, fileName, type = blob.type) {
  return new File([blob], fileName, { type: type || 'application/octet-stream' });
}

function truncateContext(text, maxChars = 1_200) {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars);
}

function buildPrompt(basePrompt = '', previousTranscript = '') {
  const cleanBasePrompt = basePrompt.trim();
  const context = truncateContext(previousTranscript);
  if (!cleanBasePrompt && !context) return '';
  if (!context) return cleanBasePrompt;

  const contextPrompt = [
    'Context from the previous audio segment:',
    context,
  ].join('\n');

  return cleanBasePrompt
    ? `${cleanBasePrompt}\n\n${contextPrompt}`
    : contextPrompt;
}

function normalizeToken(token) {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function findWordOverlap(previousText, nextText, maxWords = 40) {
  const prevWords = previousText.trim().split(/\s+/).filter(Boolean);
  const nextWords = nextText.trim().split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(maxWords, prevWords.length, nextWords.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    const prevSlice = prevWords.slice(-size).map(normalizeToken);
    const nextSlice = nextWords.slice(0, size).map(normalizeToken);
    if (prevSlice.every((token, index) => token && token === nextSlice[index])) {
      return size;
    }
  }

  return 0;
}

function mergeTranscriptText(previousText, nextText) {
  const cleanNextText = nextText.trim();
  if (!cleanNextText) return previousText.trim();

  const cleanPreviousText = previousText.trim();
  if (!cleanPreviousText) return cleanNextText;

  const overlapCount = findWordOverlap(cleanPreviousText, cleanNextText);
  if (overlapCount === 0) return `${cleanPreviousText}\n${cleanNextText}`.trim();

  const words = cleanNextText.split(/\s+/).filter(Boolean);
  return `${cleanPreviousText}\n${words.slice(overlapCount).join(' ')}`.trim();
}

function getMediaDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const media = document.createElement('audio');
    media.preload = 'metadata';
    media.src = url;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      media.removeAttribute('src');
      media.load();
    };

    media.addEventListener('loadedmetadata', () => {
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      cleanup();
      resolve(duration);
    }, { once: true });

    media.addEventListener('error', () => {
      cleanup();
      reject(new Error('Could not read the media duration for chunking.'));
    }, { once: true });
  });
}

async function getFfmpeg(onProgress) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onProgress?.({ stage: 'preparing', message: 'Loading the in-browser media toolkit…' });

      const baseUrl = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })();
  }

  return ffmpegPromise;
}

class RollingTranscriptionSession {
  #clientManager;
  #prompt = '';
  #recorder = null;
  #stream = null;
  #track = null;
  #processing = Promise.resolve();
  #stopPromise = Promise.resolve();
  #stopResolver = null;
  #chunkIndex = 0;
  #transcript = '';
  #onUpdate;
  #onStatus;
  #onError;

  constructor({ clientManager, onUpdate, onStatus, onError }) {
    this.#clientManager = clientManager;
    this.#onUpdate = onUpdate;
    this.#onStatus = onStatus;
    this.#onError = onError;
  }

  get transcript() {
    return this.#transcript.trim();
  }

  async start({ track, prompt = '' }) {
    if (!track) throw new Error('No mixed audio track is available for live transcription.');
    if (!window.MediaRecorder) throw new Error('This browser does not support live chunk transcription.');

    this.#prompt = prompt;
    this.#track = track;
    this.#stream = new MediaStream([track]);

    const mimeType = getLiveChunkMimeType();
    const options = mimeType ? { mimeType } : undefined;
    this.#recorder = new MediaRecorder(this.#stream, options);
    this.#stopPromise = new Promise(resolve => { this.#stopResolver = resolve; });

    this.#recorder.addEventListener('dataavailable', event => {
      if (event.data?.size) this.#queueChunk(event.data);
    });

    this.#recorder.addEventListener('stop', () => {
      this.#stopResolver?.();
      this.#stopResolver = null;
    }, { once: true });

    this.#onStatus?.({ stage: 'live', message: 'Live transcription is listening…' });
    this.#recorder.start(LIVE_CHUNK_MS);
  }

  pause() {
    if (this.#recorder?.state === 'recording') {
      this.#recorder.requestData();
      this.#recorder.pause();
      this.#onStatus?.({ stage: 'live', message: 'Live transcription paused.' });
    }
  }

  resume() {
    if (this.#recorder?.state === 'paused') {
      this.#recorder.resume();
      this.#onStatus?.({ stage: 'live', message: 'Live transcription resumed.' });
    }
  }

  async stop() {
    if (!this.#recorder) return this.transcript;

    if (this.#recorder.state === 'paused') this.#recorder.resume();
    if (this.#recorder.state !== 'inactive') {
      this.#recorder.requestData();
      this.#recorder.stop();
    }

    await this.#stopPromise;
    await this.#processing;

    this.#track?.stop();
    this.#stream?.getTracks().forEach(track => track.stop());
    this.#track = null;
    this.#stream = null;
    this.#recorder = null;

    return this.transcript;
  }

  #queueChunk(blob) {
    const chunkIndex = ++this.#chunkIndex;
    this.#processing = this.#processing
      .then(() => this.#processChunk(blob, chunkIndex))
      .catch(error => {
        this.#onError?.(error);
      });
  }

  async #processChunk(blob, chunkIndex) {
    const extension = getLiveChunkMimeType().includes('mp4') ? 'm4a' : 'webm';
    const file = blobToFile(blob, `live-transcript-${chunkIndex}.${extension}`);
    const prompt = buildPrompt(this.#prompt, this.#transcript);

    this.#onStatus?.({ stage: 'live', message: `Transcribing live audio chunk ${chunkIndex}…` });
    const text = await this.#clientManager.transcribeFile({ file, prompt });
    if (!text) return;

    this.#transcript = mergeTranscriptText(this.#transcript, text);
    this.#onUpdate?.({ text: this.transcript, latestSegment: text, source: 'live' });
    this.#onStatus?.({ stage: 'live', message: 'Live transcript updated.' });
  }
}

export class TranscriptionController {
  #clientManager;
  #mediaLibrary;
  #liveSession = null;
  #liveTranscript = '';
  #onLiveUpdate;
  #onStatus;
  #onError;

  constructor({ clientManager, mediaLibrary, onLiveUpdate, onStatus, onError }) {
    this.#clientManager = clientManager;
    this.#mediaLibrary = mediaLibrary;
    this.#onLiveUpdate = onLiveUpdate;
    this.#onStatus = onStatus;
    this.#onError = onError;
  }

  get liveTranscript() {
    return this.#liveTranscript.trim();
  }

  async startLiveTranscription({ track, prompt = '' }) {
    await this.stopLiveTranscription();
    this.#liveTranscript = '';

    const session = new RollingTranscriptionSession({
      clientManager: this.#clientManager,
      onUpdate: payload => {
        this.#liveTranscript = payload.text;
        this.#onLiveUpdate?.(payload);
      },
      onStatus: this.#onStatus,
      onError: error => this.#onError?.(error),
    });

    await session.start({ track, prompt });
    this.#liveSession = session;
  }

  pauseLiveTranscription() {
    this.#liveSession?.pause();
  }

  resumeLiveTranscription() {
    this.#liveSession?.resume();
  }

  async stopLiveTranscription() {
    if (!this.#liveSession) return this.liveTranscript;
    const session = this.#liveSession;
    this.#liveSession = null;
    this.#liveTranscript = await session.stop();
    return this.liveTranscript;
  }

  async transcribeFileHandle(fileHandle, { prompt = '', alwaysVersion = false, onProgress } = {}) {
    const file = await fileHandle.getFile();
    const text = await this.transcribeFile(file, { prompt, onProgress });
    const savedTranscript = await this.#mediaLibrary.writeTranscript(file.name, text, { alwaysVersion });
    return { text, ...savedTranscript };
  }

  async transcribeFile(file, { prompt = '', onProgress } = {}) {
    if (!(file instanceof File)) throw new Error('No file was selected for transcription.');

    if (file.size <= SAFE_UPLOAD_BYTES) {
      onProgress?.({ stage: 'uploading', message: `Uploading ${file.name} to OpenAI…` });
      return this.#clientManager.transcribeFile({ file, prompt });
    }

    onProgress?.({ stage: 'preparing', message: `Preparing ${file.name} for chunked transcription…` });
    const chunks = await this.#createUploadChunks(file, onProgress);
    let transcript = '';

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkPrompt = buildPrompt(prompt, transcript);
      onProgress?.({
        stage: 'transcribing',
        message: `Transcribing chunk ${index + 1} of ${chunks.length}…`,
        current: index + 1,
        total: chunks.length,
      });
      const chunkText = await this.#clientManager.transcribeFile({ file: chunk, prompt: chunkPrompt });
      transcript = mergeTranscriptText(transcript, chunkText);
    }

    return transcript.trim();
  }

  async #createUploadChunks(file, onProgress) {
    const ffmpeg = await getFfmpeg(onProgress);
    const inputName = `input.${getExtension(file.name) || 'bin'}`;
    const normalizedName = 'normalized.mp3';

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(file));
      onProgress?.({ stage: 'preparing', message: 'Compressing audio for OpenAI upload…' });
      await ffmpeg.exec([
        '-i', inputName,
        '-vn',
        '-ac', '1',
        '-ar', NORMALIZED_SAMPLE_RATE,
        '-b:a', NORMALIZED_BITRATE,
        normalizedName,
      ]);

      const normalizedData = await ffmpeg.readFile(normalizedName);
      const normalizedFile = blobToFile(
        new Blob([normalizedData], { type: 'audio/mpeg' }),
        `${file.name.replace(/\.[^.]+$/, '')}-normalized.mp3`,
        'audio/mpeg'
      );

      if (normalizedFile.size <= SAFE_UPLOAD_BYTES) {
        return [normalizedFile];
      }

      const duration = await getMediaDuration(normalizedFile);
      if (!duration) {
        return [normalizedFile];
      }

      const chunks = [];
      const stepSeconds = FILE_CHUNK_SECONDS - FILE_CHUNK_OVERLAP_SECONDS;
      let chunkIndex = 0;

      for (let start = 0; start < duration; start += stepSeconds) {
        chunkIndex += 1;
        const outputName = `chunk-${chunkIndex}.mp3`;
        const chunkDuration = Math.min(FILE_CHUNK_SECONDS, Math.max(1, duration - start));

        onProgress?.({
          stage: 'preparing',
          message: `Cutting chunk ${chunkIndex}…`,
          current: chunkIndex,
        });

        await ffmpeg.exec([
          '-i', normalizedName,
          '-ss', start.toFixed(3),
          '-t', chunkDuration.toFixed(3),
          '-ac', '1',
          '-ar', NORMALIZED_SAMPLE_RATE,
          '-b:a', NORMALIZED_BITRATE,
          outputName,
        ]);

        const chunkData = await ffmpeg.readFile(outputName);
        chunks.push(
          blobToFile(new Blob([chunkData], { type: 'audio/mpeg' }), `${file.name.replace(/\.[^.]+$/, '')}-part-${chunkIndex}.mp3`, 'audio/mpeg')
        );
        await ffmpeg.deleteFile(outputName).catch(() => {});
      }

      return chunks;
    } catch (error) {
      throw new Error(`Could not prepare ${file.name} for transcription. ${error.message}`);
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(normalizedName).catch(() => {});
    }
  }
}
