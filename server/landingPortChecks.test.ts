import assert from "node:assert/strict";
import test from "node:test";
import {
  completeLandingPortCheck,
  getLandingPortCheck,
  requestLandingPortCheck,
  takeLandingPortChecks,
} from "./landingPortChecks";

test("landing port checks stay scoped to their Agent and complete once", () => {
  const check = requestLandingPortCheck(31, 31001);
  assert.equal(takeLandingPortChecks(30).length, 0);
  assert.equal(takeLandingPortChecks(31).some((item) => item.id === check.id), true);
  assert.equal(completeLandingPortCheck(30, check.id, true), null);
  const complete = completeLandingPortCheck(31, check.id, false, "occupied");
  assert.equal(complete?.available, false);
  assert.equal(getLandingPortCheck(check.id)?.message, "occupied");
  assert.equal(takeLandingPortChecks(31).some((item) => item.id === check.id), false);
});
