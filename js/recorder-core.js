// ── recorder-core.js ──────────────────────────────────────────────────────────
// The Mediabunny Wrapper: ties canvas frames and a mixed audio track to a
// FileSystemWritableFileStream via WebCodecs hardware encode + mux.
// Responsibilities:
//   • Lazily import Mediabunny from CDN (browser caches after first load).
//   • Build the Output / CanvasSource / MediaStreamAudioTrackSource graph.
//   • Expose start(), addFrame(), pause(), resume(), and finalize() so that
//     app.js can drive the encode pipeline without knowing the Mediabunny API.

const MEDIABUNNY_CDN     = 'https://cdn.jsdelivr.net/npm/mediabunny@1.40.1/+esm';
const MP3_ENCODER_CDN    = 'https://cdn.jsdelivr.net/npm/@mediabunny/mp3-encoder@1.40.1/+esm';
const OUTPUT_KIND_MP4    = 'mp4-h264-aac';
const OUTPUT_KIND_MP3    = 'mp3-audio-only';

export class RecorderCore {
  #output       = null;
  #canvasSource = null;
  #audioSource  = null;
  #hasVideo     = false;

  // The Mediabunny audio source; exposed so app.js can pause/resume it
  // when the recording is paused (Mediabunny tracks the pause offset
  // internally to keep audio and video timestamps in sync).
  get audioSource() { return this.#audioSource; }
  get hasVideo()    { return this.#hasVideo; }

  // Dynamically imports Mediabunny (module-level cache means only one network
  // request is ever made, even if init() is called multiple times).
  static async #importMediabunny() {
    const { Output, WebMOutputFormat, Mp4OutputFormat, Mp3OutputFormat,
            StreamTarget, CanvasSource, MediaStreamAudioTrackSource } =
      await import(MEDIABUNNY_CDN);
    return { Output, WebMOutputFormat, Mp4OutputFormat, Mp3OutputFormat,
             StreamTarget, CanvasSource, MediaStreamAudioTrackSource };
  }

  static #mp3EncoderRegistration = null;

  static async #ensureMp3Encoder() {
    if (!RecorderCore.#mp3EncoderRegistration) {
      RecorderCore.#mp3EncoderRegistration = import(MP3_ENCODER_CDN).then(mod => {
        mod.registerMp3Encoder();
      });
    }
    await RecorderCore.#mp3EncoderRegistration;
  }

  // Builds the encode pipeline. Must be called before start().
  //
  // canvas          – HTMLCanvasElement whose pixels are encoded each frame.
  // mixedAudioTrack – MediaStreamTrack from the mixed audio graph, or null.
  // writableStream  – FileSystemWritableFileStream opened by StorageManager.
  // outputKind      – output/container preset.
  // videoBitrate    – target video bitrate in bits per second.
  async init({ canvas, mixedAudioTrack, writableStream, outputKind, videoBitrate }) {
    const { Output, WebMOutputFormat, Mp4OutputFormat, Mp3OutputFormat,
            StreamTarget, CanvasSource, MediaStreamAudioTrackSource } =
      await RecorderCore.#importMediabunny();

    if (outputKind === OUTPUT_KIND_MP3) {
      await RecorderCore.#ensureMp3Encoder();
    }

    const isMp4 = outputKind === OUTPUT_KIND_MP4;
    const isMp3 = outputKind === OUTPUT_KIND_MP3;

    this.#output = new Output({
      format: isMp3
        ? new Mp3OutputFormat()
        : isMp4
          ? new Mp4OutputFormat()
          : new WebMOutputFormat(),
      target: new StreamTarget(writableStream),
    });

    this.#hasVideo = !isMp3;
    if (this.#hasVideo) {
      this.#canvasSource = new CanvasSource(canvas, {
        codec:   isMp4 ? 'avc' : 'vp9',
        bitrate: videoBitrate,
      });
      this.#output.addVideoTrack(this.#canvasSource);
    }

    if (mixedAudioTrack) {
      this.#audioSource = new MediaStreamAudioTrackSource(mixedAudioTrack, {
        codec:   isMp3 ? 'mp3' : isMp4 ? 'aac' : 'opus',
        bitrate: 128_000,
      });
      this.#output.addAudioTrack(this.#audioSource);
    }
  }

  // Signals Mediabunny to open the output container and begin accepting frames.
  async start() {
    await this.#output.start();
  }

  // Encodes one video frame at the given presentation timestamp (in seconds).
  // Awaiting this call provides back-pressure when the hardware encoder is busy.
  async addFrame(timestamp) {
    if (!this.#canvasSource) return;
    await this.#canvasSource.add(timestamp);
  }

  // Pauses the audio source so that incoming samples are discarded while
  // Mediabunny accumulates a pause offset. The AudioContext keeps running so
  // samples continue to flow; Mediabunny simply marks them as dropped and
  // adjusts future timestamps accordingly — no silence gap in the output.
  pause() {
    this.#audioSource?.pause();
  }

  // Resumes the audio source. Mediabunny uses the accumulated pause offset to
  // stamp subsequent audio samples with the correct presentation timestamp.
  resume() {
    this.#audioSource?.resume();
  }

  // Flushes the hardware encoders, writes the correct duration/seek header,
  // and closes the FileSystemWritableFileStream. Do NOT call
  // writableStream.close() manually after this — finalize() does it.
  async finalize() {
    await this.#output.finalize();
    this.#output = this.#canvasSource = this.#audioSource = null;
    this.#hasVideo = false;
  }
}
