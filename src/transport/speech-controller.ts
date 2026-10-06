import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunnerError } from '../domain/contracts.js';
import { SPEECH_LIMITS, isSpeechLanguage } from '../domain/speech.js';
import { handle, send } from './http.js';
import { SERVICES, type RunnerServices } from './services.js';

@Controller('v1/speech/transcriptions')
export class SpeechController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Post()
  transcribe(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const speech = this.services.speech;
      const languages = new URL(request.originalUrl, 'http://localhost').searchParams.getAll('language');
      const language = languages[0];
      if (!speech || languages.length !== 1 || !isSpeechLanguage(language)) throw new RunnerError('not_found');
      if (request.headers['content-encoding'] || request.headers['content-type']?.toLowerCase() !== 'application/octet-stream')
        throw new RunnerError('unsupported_media');
      if (Number(request.headers['content-length'] ?? 0) > SPEECH_LIMITS.maximumAudioBytes) throw new RunnerError('too_large');
      const disconnection = new AbortController();
      const disconnected = () => disconnection.abort();
      request.once('aborted', disconnected);
      response.once('close', disconnected);
      try {
        send(response, 200, await speech.transcribe(language, request.iterator({ destroyOnReturn: false }), disconnection.signal));
      } finally {
        request.off('aborted', disconnected);
        response.off('close', disconnected);
      }
    });
  }
}
