import 'reflect-metadata';
import { SetMetadata } from '@nestjs/common';

export type LeaseExemption = 'discovery' | 'maintenance' | 'storage-read';

const LEASE_EXEMPTION = 'codevo:lease-exemption';

export const LeaseExempt = (exemption: LeaseExemption) => SetMetadata(LEASE_EXEMPTION, exemption);

export function leaseExemption(handler: object): LeaseExemption | undefined {
  const value: unknown = Reflect.getMetadata(LEASE_EXEMPTION, handler);
  if (value === 'discovery' || value === 'maintenance' || value === 'storage-read') return value;
  return undefined;
}
