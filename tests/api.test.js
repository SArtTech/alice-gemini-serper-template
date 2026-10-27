import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  aliceResponse, fitAliceText, isSearchIntent, boundedHistory, safeHistory
} from "../api/index.js";

function mockResponse() {
  return {
    code: 200, payload: null,
    status(code) { this.code = code; return this; },
    json(value) { this.payload = value; return this; },
    setHeader() {}
  };
}
async function call(body, opts = {}) {
  const res = mockResponse();
  await handler({
    method: opts.method || "POST",
    url: opts.url || "/api?token=" + TEST_SECRET,
    body,
  }, res);
  return res;
}
const TEST_SECRET = "test_secret_used_only_in_node_unit_tests_123456789";
process.env.ALICE_WEBHOOK_SECRET = TEST_SECRET;
delete process.env.ALICE_SKILL_ID;

test("Alice response envelope and version", () => {
  const r = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(r.version, "1.0");
  assert.equal(r.response.text, "Привет");
  assert.equal(r.response.end_session, false);
  assert.deepEqual(r.session_state.history, [{ role: "user", text: "тест" }]);
});
test("Russian and English search intent", () => {
  assert.ok(isSearchIntent("Какая погода сегодня?"));
  assert.ok(isSearchIntent("find latest news"));
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});
test("Long spoken replies fit Alice's 1024-character limit", () => {
  const result = fitAliceText(("Это короткое предложение. ").repeat(150));
  assert.ok(result.length <= 1024);
  assert.ok(result.endsWith("."));
});
test("Invalid history is discarded and safe state is byte-bounded", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: "Содержание диалога " + String(i) + " Ё".repeat(250)
  }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  assert.equal(safeHistory(input).length, 8);
  const history = boundedHistory(input);
  assert.ok(Buffer.byteLength(JSON.stringify({ history }), "utf8") <= 940);
});
test("Public GET is only a health check without API consumption", async () => {
  const res = await call(null, { method: "GET", url: "/api" });
  assert.equal(res.code, 200);
  assert.equal(res.payload.service, "edith-ai");
});
test("Missing secret denies POST", async () => {
  const res = await call({ session: { new: true }, request: {} }, { url: "/api" });
  assert.equal(res.code, 404);
});
test("Invalid POST JSON returns 400", async () => {
  const res = await call("bad payload");
  assert.equal(res.code, 400);
});
test("Launch returns immediately without Gemini key", async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const res = await call({ session: { new: true, message_id: 0 }, request: { command: "" }, state: { session: {} } });
    assert.equal(res.code, 200);
    assert.equal(res.payload.response.end_session, false);
    assert.match(res.payload.response.text, /Эдит ИИ/);
  } finally {
    if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
  }
});
test("Goodbye ends the current Alice session", async () => {
  const res = await call({ session: { new: false, message_id: 1 }, request: { command: "пока" }, state: { session: {} } });
  assert.equal(res.payload.response.end_session, true);
});
test("Gemini query uses mock API, replies, and saves bounded state", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit_test_key";
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /generativelanguage.googleapis.com/);
    const sent = JSON.parse(options.body);
    assert.equal(sent.contents.at(-1).parts[0].text, "Привет Эдит");
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "Привет! Я Эдит." }] } }] }) };
  };
  try {
    const res = await call({
      session: { new: false, message_id: 1 },
      request: { command: "Привет Эдит", original_utterance: "Привет Эдит" },
      state: { session: {} }
    });
    assert.equal(res.code, 200);
    assert.equal(res.payload.response.text, "Привет! Я Эдит.");
    assert.ok(Buffer.byteLength(JSON.stringify(res.payload.session_state), "utf8") <= 1024);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});
test("Gemini model HTTP 404 provides actionable Russian error", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit_test_key";
  globalThis.fetch = async () => ({
    ok: false, status: 404,
    json: async () => ({ error: { status: "NOT_FOUND" } })
  });
  try {
    const res = await call({ session: { new: false, message_id: 2 }, request: { command: "Что такое Linux?" }, state: { session: {} } });
    assert.equal(res.code, 200);
    assert.match(res.payload.response.text, /модел/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});
