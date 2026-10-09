import { Controller, Delete, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { MaintenanceApplication } from '../application/maintenance-service.js';
import { RunnerError } from '../domain/contracts.js';
import { handle, jsonBody, send } from './http.js';
import { LeaseExempt } from './lease-exempt.js';
import { SERVICES, type RunnerServices } from './services.js';

const PREPARE_BODY_BYTES = 256;

@Controller('v1/maintenance')
export class MaintenanceController {
  constructor(@Inject(SERVICES) private readonly services: RunnerServices) {}

  @Post('prepare')
  @LeaseExempt('maintenance')
  prepare(@Req() request: Request, @Res() response: Response) {
    return handle(response, async () => {
      const maintenance = this.maintenance();
      send(response, 200, await maintenance.prepare(await jsonBody(request, PREPARE_BODY_BYTES)));
    });
  }

  @Delete(':leaseId')
  @LeaseExempt('maintenance')
  release(@Param('leaseId') leaseId: string, @Res() response: Response) {
    return handle(response, async () => send(response, 200, this.maintenance().release(leaseId)));
  }

  private maintenance(): MaintenanceApplication {
    if (!this.services.maintenance) throw new RunnerError('not_found');
    return this.services.maintenance;
  }
}
