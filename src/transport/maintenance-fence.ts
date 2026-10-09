import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { finalize, from, type Observable } from 'rxjs';
import { RunnerError } from '../domain/contracts.js';
import { handle } from './http.js';
import { leaseExemption } from './lease-exempt.js';
import { SERVICES, type RunnerServices } from './services.js';

@Injectable()
export class MaintenanceFence implements NestInterceptor {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const maintenance = this.services.maintenance;
    if (!maintenance || leaseExemption(context.getHandler()) !== undefined) return next.handle();
    const admission = maintenance.admit();
    switch (admission.kind) {
      case 'refused': return from(handle(context.switchToHttp().getResponse<Response>(), () => Promise.reject(new RunnerError('busy'))));
      case 'admitted': return next.handle().pipe(finalize(admission.release));
      default: return unreachable(admission);
    }
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled maintenance admission: ${String(value)}`);
}
