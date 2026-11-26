import assert from "node:assert/strict";
import test from "node:test";
import { nextLandingGroupHealth } from "./landingGroupFailoverPolicy";

const primary = { serviceId: 1, healthy: true as boolean | null };
const standby = { serviceId: 2, healthy: true as boolean | null };
const empty = { activeServiceId: null, activeUnhealthySince: null, primaryHealthySince: null, recoveryServiceId: null };

test("landing group chooses primary, waits for confirmed failure and recovers after a stable window", () => {
  const initial = nextLandingGroupHealth(empty, [primary, standby], 1_000_000);
  assert.equal(initial.activeServiceId, 1);
  const failed = [{ ...primary, healthy: false }, standby];
  const pending = nextLandingGroupHealth(initial, failed, 1_001_000);
  assert.equal(pending.activeServiceId, 1);
  assert.equal(nextLandingGroupHealth(pending, failed, 1_060_000).activeServiceId, 1);
  const switched = nextLandingGroupHealth(pending, failed, 1_061_000);
  assert.equal(switched.activeServiceId, 2);
  const recovering = nextLandingGroupHealth(switched, [primary, standby], 1_062_000);
  assert.equal(recovering.activeServiceId, 2);
  assert.equal(nextLandingGroupHealth(recovering, [primary, standby], 1_181_000).activeServiceId, 2);
  assert.equal(nextLandingGroupHealth(recovering, [primary, standby], 1_182_000).activeServiceId, 1);
});

test("recovery window resets when the preferred member changes", () => {
  const active = { ...empty, activeServiceId: 3 };
  const three = { serviceId: 3, healthy: true };
  const a = nextLandingGroupHealth(active, [primary, standby, three], 1_000_000);
  const b = nextLandingGroupHealth(a, [{ ...primary, healthy: false }, standby, three], 1_115_000);
  assert.equal(b.recoveryServiceId, 2);
  assert.equal(nextLandingGroupHealth(b, [{ ...primary, healthy: false }, standby, three], 1_120_000).activeServiceId, 3);
  assert.equal(nextLandingGroupHealth(b, [{ ...primary, healthy: false }, standby, three], 1_235_000).activeServiceId, 2);
});

test("unknown health and an unhealthy standby never force a switch", () => {
  const active = { ...empty, activeServiceId: 1 };
  const unknown = nextLandingGroupHealth(active, [{ ...primary, healthy: null }, standby], 1_000_000);
  assert.equal(unknown.activeUnhealthySince, null);
  assert.equal(nextLandingGroupHealth(unknown, [{ ...primary, healthy: null }, standby], 1_200_000).activeServiceId, 1);
  const noBackup = nextLandingGroupHealth(active, [{ ...primary, healthy: false }, { ...standby, healthy: false }], 1_000_000);
  assert.equal(nextLandingGroupHealth(noBackup, [{ ...primary, healthy: false }, { ...standby, healthy: false }], 1_300_000).activeServiceId, 1);
});
