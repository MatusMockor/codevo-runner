import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { SpeechTranscriber } from '../../application/speech-transcription-service.js';
import { SPEECH_LIMITS, parseSpeechOrigin, type SpeechLanguage } from '../../domain/speech.js';

async function readJson(response: IncomingMessage): Promise<unknown> {
  if (response.statusCode !== 200) throw new Error('speech_upstream_status');
  if (Number(response.headers['content-length'] ?? 0) > SPEECH_LIMITS.upstreamResponseBytes) throw new Error('speech_upstream_size');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > SPEECH_LIMITS.upstreamResponseBytes) throw new Error('speech_upstream_size');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
}

export class HttpSpeechTranscriber implements SpeechTranscriber {
  private readonly origin: string;

  constructor(url: string) {
    this.origin = parseSpeechOrigin(url);
  }

  transcribe(language: SpeechLanguage, audio: Uint8Array, signal: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const request = httpRequest(`${this.origin}/transcribe?language=${language}`, {
        method: 'POST', agent: false, signal,
        headers: { 'content-type': 'application/octet-stream', 'content-length': audio.byteLength },
      });
      request.once('response', response => {
        readJson(response).then(resolve, reject).finally(() => request.destroy());
      });
      request.once('error', reject);
      request.end(audio);
    });
  }
}
