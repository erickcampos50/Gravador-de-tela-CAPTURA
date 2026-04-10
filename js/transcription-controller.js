import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';
import { isVideoFileName } from './media-library.js';

const SAFE_UPLOAD_BYTES = 24 * 1024 * 1024;
const LIVE_CHUNK_MS = 10_000;
const MIN_LIVE_CHUNK_SECONDS = 0.35;
const NORMALIZED_BITRATE = '64k';
const NORMALIZED_SAMPLE_RATE = '24000';
const FILE_CHUNK_SECONDS = 10 * 60;
const FILE_CHUNK_OVERLAP_SECONDS = 2;
const FFMPEG_CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
const FFMPEG_CLASS_WORKER_URL = new URL('./vendor/ffmpeg/worker.js', import.meta.url).href;

let ffmpegPromise = null;

function getExtension(fileName) {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isVideoMediaFile(file) {
  if (!file) return false;
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  return type.startsWith('video/') || isVideoFileName(file.name || '');
}

function blobToFile(blob, fileName, type = blob.type) {
  return new File([blob], fileName, { type: type || 'application/octet-stream' });
}

function encodeWavFromFloat32(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, Math.round(pcm), true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function mergeFloat32Chunks(chunks, totalSamples) {
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  chunks.forEach(chunk => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

function extractMonoSamples(inputBuffer) {
  const channelCount = inputBuffer.numberOfChannels;
  if (channelCount <= 1) {
    return new Float32Array(inputBuffer.getChannelData(0));
  }

  const frameCount = inputBuffer.length;
  const mono = new Float32Array(frameCount);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = inputBuffer.getChannelData(channelIndex);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      mono[frameIndex] += channelData[frameIndex] / channelCount;
    }
  }
  return mono;
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
    'Contexto do segmento de áudio anterior:',
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
      reject(new Error('Não foi possível ler a duração da mídia para dividir o arquivo.'));
    }, { once: true });
  });
}

async function getFfmpeg(onProgress) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onProgress?.({ stage: 'preparing', message: 'Carregando o kit de mídia no navegador…' });

      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
        classWorkerURL: FFMPEG_CLASS_WORKER_URL,
      });
      return ffmpeg;
    })();
  }

  return ffmpegPromise;
}

class RollingTranscriptionSession {
  #clientManager;
  #prompt = '';
  #audioContext = null;
  #sourceNode = null;
  #processorNode = null;
  #silenceGainNode = null;
  #stream = null;
  #track = null;
  #chunkBuffers = [];
  #chunkSampleCount = 0;
  #flushTimerId = null;
  #paused = false;
  #processing = Promise.resolve();
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
    if (!track) throw new Error('Nenhuma faixa de áudio combinada está disponível para transcrição ao vivo.');
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Este navegador não oferece suporte à transcrição ao vivo em partes.');

    this.#prompt = prompt;
    this.#track = track;
    this.#stream = new MediaStream([track]);
    this.#audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
    this.#sourceNode = this.#audioContext.createMediaStreamSource(this.#stream);
    this.#processorNode = this.#audioContext.createScriptProcessor(4096, 2, 1);
    this.#silenceGainNode = this.#audioContext.createGain();
    this.#silenceGainNode.gain.value = 0;

    this.#processorNode.onaudioprocess = event => {
      if (this.#paused) return;
      const mono = extractMonoSamples(event.inputBuffer);
      if (!mono.length) return;
      this.#chunkBuffers.push(mono);
      this.#chunkSampleCount += mono.length;
    };

    this.#sourceNode.connect(this.#processorNode);
    this.#processorNode.connect(this.#silenceGainNode);
    this.#silenceGainNode.connect(this.#audioContext.destination);
    await this.#audioContext.resume();

    this.#flushTimerId = window.setInterval(() => {
      void this.#flushChunk();
    }, LIVE_CHUNK_MS);

    this.#onStatus?.({ stage: 'live', message: 'A transcrição ao vivo está ouvindo…' });
  }

  pause() {
    this.#paused = true;
    void this.#flushChunk(true);
    this.#onStatus?.({ stage: 'live', message: 'Transcrição ao vivo pausada.' });
  }

  resume() {
    this.#paused = false;
    this.#onStatus?.({ stage: 'live', message: 'Transcrição ao vivo retomada.' });
  }

  async stop() {
    if (!this.#audioContext) return this.transcript;

    window.clearInterval(this.#flushTimerId);
    this.#flushTimerId = null;
    this.#paused = true;
    await this.#flushChunk(true);
    await this.#processing;
    this.#processorNode.onaudioprocess = null;
    this.#sourceNode?.disconnect();
    this.#processorNode?.disconnect();
    this.#silenceGainNode?.disconnect();
    await this.#audioContext.close().catch(() => {});
    this.#track?.stop();
    this.#stream?.getTracks().forEach(track => track.stop());
    this.#audioContext = null;
    this.#sourceNode = null;
    this.#processorNode = null;
    this.#silenceGainNode = null;
    this.#track = null;
    this.#stream = null;
    this.#chunkBuffers = [];
    this.#chunkSampleCount = 0;

    return this.transcript;
  }

  async #flushChunk(force = false) {
    if (!this.#chunkSampleCount || !this.#audioContext) return;

    const sampleRate = this.#audioContext.sampleRate;
    const minSamples = Math.floor(sampleRate * MIN_LIVE_CHUNK_SECONDS);
    if (!force && this.#chunkSampleCount < minSamples) return;

    const samples = mergeFloat32Chunks(this.#chunkBuffers, this.#chunkSampleCount);
    this.#chunkBuffers = [];
    this.#chunkSampleCount = 0;

    const chunkIndex = ++this.#chunkIndex;
    const blob = encodeWavFromFloat32(samples, sampleRate);
    this.#processing = this.#processing
      .then(() => this.#processChunk(blob, chunkIndex))
      .catch(error => {
        this.#onError?.(error);
      });
  }

  async #processChunk(blob, chunkIndex) {
    const file = blobToFile(blob, `live-transcript-${chunkIndex}.wav`, 'audio/wav');
    const prompt = buildPrompt(this.#prompt, this.#transcript);

    this.#onStatus?.({ stage: 'live', message: `Transcrevendo trecho ao vivo ${chunkIndex}…` });
    const text = await this.#clientManager.transcribeFile({ file, prompt });
    if (!text) return;

    this.#transcript = mergeTranscriptText(this.#transcript, text);
    this.#onUpdate?.({ text: this.transcript, latestSegment: text, source: 'live' });
    this.#onStatus?.({ stage: 'live', message: 'Transcrição ao vivo atualizada.' });
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
    if (!(file instanceof File)) throw new Error('Nenhum arquivo foi selecionado para transcrição.');

    const needsNormalization = file.size > SAFE_UPLOAD_BYTES || isVideoMediaFile(file);
    if (!needsNormalization) {
      onProgress?.({ stage: 'uploading', message: `Enviando ${file.name} para a OpenAI…` });
      return this.#clientManager.transcribeFile({ file, prompt });
    }

    onProgress?.({
      stage: 'preparing',
      message: isVideoMediaFile(file)
        ? `Extraindo áudio de ${file.name} para transcrição…`
        : `Preparando ${file.name} para transcrição em partes…`,
    });
    const chunks = await this.#createUploadChunks(file, onProgress);
    let transcript = '';

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkPrompt = buildPrompt(prompt, transcript);
      onProgress?.({
        stage: 'transcribing',
        message: `Transcrevendo parte ${index + 1} de ${chunks.length}…`,
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
      onProgress?.({
        stage: 'preparing',
        message: isVideoMediaFile(file)
          ? 'Extraindo e compactando o áudio do vídeo…'
          : 'Compactando áudio para envio à OpenAI…',
      });
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
          message: `Recortando parte ${chunkIndex}…`,
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
      throw new Error(`Não foi possível preparar ${file.name} para transcrição. ${error.message}`);
    } finally {
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(normalizedName).catch(() => {});
    }
  }
}
