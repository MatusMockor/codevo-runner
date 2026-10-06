import { RunnerError } from '../domain/contracts.js';
import {
  SPEECH_LIMITS, parseSpeechTranscript, validateSpeechAudioBytes, type SpeechLanguage, type SpeechTranscript,
} from '../domain/speech.js';

export interface SpeechTranscriber {
  transcribe(language: SpeechLanguage, audio: Uint8Array, signal: AbortSignal): Promise<unknown>;
}
export interface SpeechApplication {
  transcribe(language: SpeechLanguage, audio: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<SpeechTranscript>;
  close(): Promise<void>;
}
export type SpeechServiceOptions = Readonly<{ timeoutMs?: number; refusalDrainMs?: number }>;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('speech_aborted'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function* boundedChunks(source: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  let bytes = 0;
  for (let next = await abortable(iterator.next(), signal); !next.done; next = await abortable(iterator.next(), signal)) {
    bytes += next.value.byteLength;
    if (bytes > SPEECH_LIMITS.maximumAudioBytes) throw new RunnerError('too_large');
    yield next.value;
  }
}

async function readAudio(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of boundedChunks(source, signal)) {
    bytes += chunk.byteLength;
    chunks.push(chunk);
  }
  validateSpeechAudioBytes(bytes);
  return Buffer.concat(chunks, bytes);
}

async function discardAudio(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> {
  try {
    for await (const chunk of boundedChunks(source, signal)) void chunk;
  } catch {
    return;
  }
}

export class SpeechTranscriptionService implements SpeechApplication {
  private readonly cancellation = new AbortController();
  private readonly admitted = new Set<Promise<SpeechTranscript>>();
  private readonly waiting: Array<() => void> = [];
  private readonly timeoutMs: number;
  private readonly refusalDrainMs: number;
  private forwarding = false;

  constructor(private readonly transcriber: SpeechTranscriber, options: SpeechServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? SPEECH_LIMITS.timeoutMs;
    this.refusalDrainMs = options.refusalDrainMs ?? SPEECH_LIMITS.refusalDrainMs;
  }

  transcribe(language: SpeechLanguage, audio: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<SpeechTranscript> {
    if (this.cancellation.signal.aborted) return this.refuse('speech_unavailable', audio, signal);
    if (this.admitted.size >= 1 + SPEECH_LIMITS.waitingRequests) return this.refuse('busy', audio, signal);
    const work = this.serve(language, audio, signal).finally(() => this.admitted.delete(work));
    this.admitted.add(work);
    return work;
  }

  async close(): Promise<void> {
    this.cancellation.abort();
    await Promise.allSettled(this.admitted);
  }

  private async refuse(code: 'busy' | 'speech_unavailable', source: AsyncIterable<Uint8Array>, client: AbortSignal): Promise<never> {
    await discardAudio(source, AbortSignal.any([client, AbortSignal.timeout(this.refusalDrainMs)]));
    throw new RunnerError(code);
  }

  private async serve(language: SpeechLanguage, source: AsyncIterable<Uint8Array>, client: AbortSignal): Promise<SpeechTranscript> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([client, this.cancellation.signal, deadline]);
    const audio = await this.prepare(source, signal, deadline);
    try { return await this.forward(language, audio, signal); }
    finally { this.release(); }
  }

  private async prepare(source: AsyncIterable<Uint8Array>, signal: AbortSignal, deadline: AbortSignal): Promise<Uint8Array> {
    try {
      const audio = await readAudio(source, signal);
      await this.turn(signal);
      return audio;
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError(deadline.aborted ? 'busy' : 'speech_unavailable');
    }
  }

  private async forward(language: SpeechLanguage, audio: Uint8Array, signal: AbortSignal): Promise<SpeechTranscript> {
    try {
      const transcript = parseSpeechTranscript(await abortable(this.transcriber.transcribe(language, audio, signal), signal));
      signal.throwIfAborted();
      return transcript;
    } catch { throw new RunnerError('speech_unavailable'); }
  }

  private async turn(signal: AbortSignal): Promise<void> {
    if (!this.forwarding) {
      this.forwarding = true;
      return;
    }
    let grant!: () => void;
    const granted = new Promise<void>(resolve => { grant = resolve; });
    this.waiting.push(grant);
    try { await abortable(granted, signal); }
    catch (error) {
      this.abandon(grant);
      throw error;
    }
  }

  private abandon(grant: () => void): void {
    const position = this.waiting.indexOf(grant);
    if (position === -1) return this.release();
    this.waiting.splice(position, 1);
  }

  private release(): void {
    const next = this.waiting.shift();
    if (!next) {
      this.forwarding = false;
      return;
    }
    next();
  }
}
