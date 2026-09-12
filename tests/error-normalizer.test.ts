import assert from "node:assert/strict";
import { test } from "vitest";

import { normalizeError } from "../src/error-normalizer.js";

test("normalize a standard provider error object", () => {
  const error = normalizeError({
    status: 402,
    error: "insufficient_credits",
    message: "Not enough credits",
  });

  assert.equal(error.status, 402);
  assert.equal(error.code, "insufficient_credits");
  assert.equal(error.message, "Not enough credits");
});

test("normalize an alternative statusCode/code format", () => {
  const error = normalizeError({
    statusCode: 429,
    code: "quota_exceeded",
    message: "Quota exceeded",
  });

  assert.equal(error.status, 429);
  assert.equal(error.code, "quota_exceeded");
  assert.equal(error.message, "Quota exceeded");
});

test("normalize a plain Error", () => {
  const error = normalizeError(
    new Error("HTTP 402 Payment Required"),
  );

  assert.equal(error.message, "HTTP 402 Payment Required");
});

test("normalize a string error", () => {
  const error = normalizeError(
    "HTTP 402 Payment Required: insufficient credits",
  );

  assert.equal(error.status, 402);
  assert.equal(
    error.message,
    "HTTP 402 Payment Required: insufficient credits",
  );
});

test("normalize unknown values safely", () => {
  const error = normalizeError(null);

  assert.equal(error.status, undefined);
  assert.equal(error.code, undefined);
  assert.equal(error.message, undefined);
  assert.equal(error.raw, null);
});