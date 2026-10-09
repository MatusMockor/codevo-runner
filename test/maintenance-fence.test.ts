import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Controller, Get, Module, Post, Res } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { MaintenanceLease } from '../src/application/maintenance-lease.js';
import { MaintenanceService, RunnerIdleProbe } from '../src/application/maintenance-service.js';
import { openSqliteRepository } from '../src/infrastructure/sqlite/index.js';
import { handle, send } from '../src/transport/http.js';
import { LeaseExempt, leaseExemption } from '../src/transport/lease-exempt.js';
import { MaintenanceFence } from '../src/transport/maintenance-fence.js';
import { SERVICES } from '../src/transport/services.js';
import { eventually, ManualClock } from './maintenance-fixture.js';

const calls: string[] = [];
let settle: () => void = () => undefined;
let settleExempt: () => void = () => undefined;

@Controller('probe')
class ProbeController {
  @Get('unclassified')
  unclassified(@Res() response: Response) {
    return handle(response, async () => { calls.push('unclassified'); send(response, 200, { answered: 'unclassified' }); });
  }
  @Get('exempt')
  @LeaseExempt('storage-read')
  exempt(@Res() response: Response) {
    return handle(response, async () => { calls.push('exempt'); send(response, 200, { answered: 'exempt' }); });
  }
  @Get('blocking')
  blocking(@Res() response: Response) {
    return handle(response, async () => {
      calls.push('blocking');
      await new Promise<void>(resolve => { settle = resolve; });
      send(response, 200, { answered: 'blocking' });
    });
  }
  @Get('exempt-blocking')
  @LeaseExempt('storage-read')
  exemptBlocking(@Res() response: Response) {
    return handle(response, async () => {
      calls.push('exempt-blocking');
      await new Promise<void>(resolve => { settleExempt = resolve; });
      send(response, 200, { answered: 'exempt-blocking' });
    });
  }
  @Post('unclassified')
  mutate(@Res() response: Response) {
    return handle(response, async () => { calls.push('mutate'); send(response, 200, { answered: 'mutate' }); });
  }
}

@Module({})
class ProbeModule {}

async function fixture(t: TestContext, startLeaseId?: string) {
  const root = await mkdtemp(join(tmpdir(), 'runner-maintenance-fence-'));
  const runnerId = randomUUID();
  const repository = await openSqliteRepository(root, runnerId);
  const lease = new MaintenanceLease(new ManualClock(), startLeaseId);
  const maintenance = new MaintenanceService(runnerId, lease, new RunnerIdleProbe(repository, []));
  const app = await NestFactory.create({ module: ProbeModule, controllers: [ProbeController],
    providers: [{ provide: SERVICES, useValue: { maintenance } }, { provide: APP_INTERCEPTOR, useClass: MaintenanceFence }] }, { logger: false });
  t.after(async () => {
    settle();
    settleExempt();
    await app.close();
    lease.close();
    await repository.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const call = async (method: string, path: string) => {
    const response = await fetch(`${url}${path}`, { method });
    return { status: response.status, body: await response.json() as unknown };
  };
  calls.length = 0;
  return { maintenance, call };
}

test('an exemption is explicit metadata and anything else, including an unknown value, is unclassified', () => {
  const classified = (ProbeController.prototype.exempt as object);
  assert.equal(leaseExemption(classified), 'storage-read');
  assert.equal(leaseExemption(ProbeController.prototype.unclassified as object), undefined);
  assert.equal(leaseExemption(ProbeController.prototype.mutate as object), undefined);
  const forged = () => undefined;
  Reflect.defineMetadata('codevo:lease-exemption', 'anything', forged);
  assert.equal(leaseExemption(forged), undefined);
});

test('a route registered without classification is fenced by default whatever its method', async t => {
  const leaseId = randomUUID();
  const state = await fixture(t, leaseId);
  for (const [method, path] of [['GET', '/probe/unclassified'], ['POST', '/probe/unclassified'], ['GET', '/probe/blocking']] as const)
    assert.deepEqual(await state.call(method, path), { status: 503, body: { error: 'busy' } }, `${method} ${path}`);
  assert.deepEqual(await state.call('GET', '/probe/exempt'), { status: 200, body: { answered: 'exempt' } });
  assert.deepEqual(calls, ['exempt']);
  assert.deepEqual(state.maintenance.release(leaseId), { leaseId, released: true });
  assert.deepEqual(await state.call('GET', '/probe/unclassified'), { status: 200, body: { answered: 'unclassified' } });
  assert.deepEqual(await state.call('POST', '/probe/unclassified'), { status: 200, body: { answered: 'mutate' } });
  assert.deepEqual(calls, ['exempt', 'unclassified', 'mutate']);
});

test('an unclassified read in flight blocks the grant until its handler settles and an exempt read never does', async t => {
  const state = await fixture(t);
  const leaseId = randomUUID();
  const blocking = state.call('GET', '/probe/blocking');
  await eventually(() => calls.includes('blocking'), Boolean, 'unclassified read');
  await assert.rejects(state.maintenance.prepare({ leaseId }), { code: 'conflict' });
  const exempt = state.call('GET', '/probe/exempt-blocking');
  await eventually(() => calls.includes('exempt-blocking'), Boolean, 'exempt read');
  await assert.rejects(state.maintenance.prepare({ leaseId }), { code: 'conflict' });
  settle();
  assert.deepEqual(await blocking, { status: 200, body: { answered: 'blocking' } });
  assert.equal((await state.maintenance.prepare({ leaseId })).leaseId, leaseId);
  assert.deepEqual(await state.call('GET', '/probe/blocking'), { status: 503, body: { error: 'busy' } });
  settleExempt();
  assert.deepEqual(await exempt, { status: 200, body: { answered: 'exempt-blocking' } });
  assert.deepEqual(calls, ['blocking', 'exempt-blocking']);
});
