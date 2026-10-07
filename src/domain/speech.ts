import { RunnerError } from './contracts.js';

export const SPEECH_LIMITS = Object.freeze({
  minimumAudioBytes: 640, maximumAudioBytes: 960_000, transcriptCharacters: 4000,
  upstreamResponseBytes: 32_768, waitingRequests: 4, timeoutMs: 30_000, refusalDrainMs: 5_000,
});
export const SPEECH_LANGUAGES = Object.freeze(['auto', 'sk', 'en', 'cs'] as const);
export type SpeechLanguage = typeof SPEECH_LANGUAGES[number];
export type SpeechTranscript = Readonly<{ text: string }>;

const SPEECH_URL_ERROR = 'CODEVO_SPEECH_URL must be an http:// loopback IP origin without a path, such as http://127.0.0.1:8001';
const speechOrigin = /^http:\/\/(127(?:\.(?:0|[1-9][0-9]{0,2})){3}|\[::1\])(?::([1-9][0-9]{0,4}))?\/?$/;

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
  return SPEECH_LANGUAGES.some(language => language === value);
}

export function validateSpeechAudioBytes(bytes: number): void {
  if (bytes > SPEECH_LIMITS.maximumAudioBytes) throw new RunnerError('too_large');
  if (bytes < SPEECH_LIMITS.minimumAudioBytes || bytes % 2 !== 0) throw new RunnerError('invalid_input');
}

export function parseSpeechTranscript(value: unknown): SpeechTranscript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_speech_transcript');
  const text = (value as Record<string, unknown>).text;
  if (Object.keys(value).length !== 1 || typeof text !== 'string' || text.length > SPEECH_LIMITS.transcriptCharacters)
    throw new Error('invalid_speech_transcript');
  return Object.freeze({ text: text.trim() });
}

export function parseSpeechOrigin(value: string): string {
  const match = speechOrigin.exec(value);
  if (!match) throw new Error(SPEECH_URL_ERROR);
  const host = match[1] ?? '';
  const port = match[2];
  if (host.split('.').some(octet => Number(octet) > 255)) throw new Error(SPEECH_URL_ERROR);
  if (port === undefined) return `http://${host}`;
  if (Number(port) > 65_535) throw new Error(SPEECH_URL_ERROR);
  return `http://${host}:${port}`;
}
