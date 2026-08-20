process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";

const { normalizeSafaricomStkPhone } = await import("../server.js");

test("normalizeSafaricomStkPhone accepts valid Safaricom STK formats", () => {
  const cases = [
    ["0725518824", "254725518824"],
    ["725518824", "254725518824"],
    ["254725518824", "254725518824"],
    ["+254725518824", "254725518824"],
    ["0112345678", "254112345678"],
    ["112345678", "254112345678"],
    ["254112345678", "254112345678"],
    ["+254112345678", "254112345678"],
  ];

  for (const [raw, expected] of cases) {
    assert.equal(normalizeSafaricomStkPhone(raw), expected, raw);
  }
});

test("normalizeSafaricomStkPhone rejects invalid STK phone formats", () => {
  const invalid = [
    "",
    null,
    "072551882",
    "07255188245",
    "0625518824",
    "212345678",
    "254625518824",
    "25472551882",
    "2547255188249",
    "+255725518824",
    "abcdef",
  ];

  for (const raw of invalid) {
    assert.equal(normalizeSafaricomStkPhone(raw), null, String(raw));
  }
});
