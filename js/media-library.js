import { dateStamp } from './storage.js';

const AUDIO_EXTENSIONS = new Set(['mp3', 'mpeg', 'mpga', 'm4a', 'wav']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);
const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

function getExtension(fileName) {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function getBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function isTranscriptNameFor(mediaFileName, candidateName) {
  const baseName = getBaseName(mediaFileName);
  return candidateName === `${baseName}-transcript.txt`
    || (/\.txt$/i).test(candidateName) && candidateName.startsWith(`${baseName}-transcript-`);
}

export function isMediaFileName(fileName) {
  return MEDIA_EXTENSIONS.has(getExtension(fileName));
}

export function isVideoFileName(fileName) {
  return VIDEO_EXTENSIONS.has(getExtension(fileName));
}

export function isAudioFileName(fileName) {
  return AUDIO_EXTENSIONS.has(getExtension(fileName));
}

export class MediaLibrary {
  #storage;

  constructor(storage) {
    this.#storage = storage;
  }

  async listMediaFiles() {
    const entries = await this.#storage.listDirectoryFileHandles();
    const transcriptEntries = entries.filter(entry => entry.name.toLowerCase().endsWith('.txt'));

    return Promise.all(
      entries
        .filter(entry => isMediaFileName(entry.name))
        .map(async entry => {
          const related = transcriptEntries.filter(candidate => isTranscriptNameFor(entry.name, candidate.name));
          return {
            ...entry,
            kind: isVideoFileName(entry.name) ? 'video' : 'audio',
            transcriptCount: related.length,
          };
        })
    );
  }

  async getRelatedTranscripts(mediaFileName) {
    const entries = await this.#storage.listDirectoryFileHandles();
    const candidates = entries.filter(entry => isTranscriptNameFor(mediaFileName, entry.name));
    const withMeta = await Promise.all(
      candidates.map(async entry => {
        const file = await entry.handle.getFile();
        return { ...entry, lastModified: file.lastModified || 0 };
      })
    );

    return withMeta.sort(
      (a, b) => b.lastModified - a.lastModified || b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
    );
  }

  async readTranscript(handle) {
    return this.#storage.readTextFile(handle);
  }

  async writeTranscript(mediaFileName, transcriptText, { alwaysVersion = false } = {}) {
    const trimmed = transcriptText.trim();
    if (!trimmed) throw new Error('The transcript is empty.');

    const baseName = getBaseName(mediaFileName);
    const existing = await this.getRelatedTranscripts(mediaFileName);
    const fileName = !alwaysVersion && existing.length === 0
      ? `${baseName}-transcript.txt`
      : `${baseName}-transcript-${dateStamp()}.txt`;

    const handle = await this.#storage.writeTextFile(fileName, `${trimmed}\n`);
    return { fileName, handle };
  }
}
