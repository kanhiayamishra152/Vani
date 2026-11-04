import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AvatarStage } from '../web/js/avatar.js';
import { ANIME_DEFS, AXES, sampleAction, setAxes } from '../web/js/anime.js';

function stageForFetch() {
  const stage = Object.create(AvatarStage.prototype);
  stage.disposed = false;
  stage.loadAbort = null;
  return stage;
}

function streamedResponse(chunks, declaredLength = null) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
  const headers = declaredLength == null ? {} : { 'Content-Length': String(declaredLength) };
  return new Response(stream, { status: 200, headers });
}

test('VRM stream uses one final-sized staging buffer and preserves every byte', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => streamedResponse([[0, 1], [2, 3, 4]], 5);
  try {
    const progress = [];
    const result = await stageForFetch()._fetchVRM('assets/vrm/OC-Lily.vrm', p => progress.push(p));
    assert.deepEqual([...new Uint8Array(result)], [0, 1, 2, 3, 4]);
    assert.equal(progress.at(-1), 1);
  } finally { globalThis.fetch = previous; }
});

test('VRM stream rejects a truncated declared-length response', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => streamedResponse([[1, 2]], 5);
  try {
    await assert.rejects(stageForFetch()._fetchVRM('assets/vrm/OC-Lily.vrm'), /truncated/i);
  } finally { globalThis.fetch = previous; }
});

test('VRM unknown-length responses use the browser arrayBuffer path', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => streamedResponse([[7, 6], [5]]);
  try {
    const result = await stageForFetch()._fetchVRM('assets/vrm/OC-Lily.vrm');
    assert.deepEqual([...new Uint8Array(result)], [7, 6, 5]);
  } finally { globalThis.fetch = previous; }
});

test('anime axis calibration never mutates canonical keyframes', () => {
  const originalAxes = { ...AXES };
  const key = '__axisRegression';
  const original = 0.4;
  ANIME_DEFS[key] = { duration: 1, bones: { leftUpperLeg: [{ t: 0, x: original }, { t: 1, x: original }] } };
  try {
    setAxes({ leg: -1 });
    const first = sampleAction(key, 0);
    const second = sampleAction(key, 0);
    assert.equal(first.bones.leftUpperLeg.x, -original);
    assert.equal(second.bones.leftUpperLeg.x, -original);
    assert.equal(ANIME_DEFS[key].bones.leftUpperLeg[0].x, original);
  } finally {
    delete ANIME_DEFS[key];
    setAxes(originalAxes);
  }
});

test('downloader retains Range restart, response validation, EOF checks and throttled progress', () => {
  const source = fs.readFileSync(new URL('../android/app/src/main/java/ai/vani/app/DownloadService.java', import.meta.url), 'utf8');
  assert.match(source, /code == 200 && offset > 0[\s\S]*?offset = 0; append = false/);
  assert.match(source, /validateContentRange\(con\.getHeaderField\("Content-Range"\), offset, expected\)/);
  assert.match(source, /Unexpected EOF/);
  assert.match(source, /now - lastEmit >= 400/);
  assert.match(source, /new byte\[65536\]/);
  assert.match(source, /startForeground\(notifId\("summary"\)/);
});

test('native ownership is bounded and projector/multimodal allocations have cleanup guards', () => {
  const speech = fs.readFileSync(new URL('../android/app/src/main/java/ai/vani/app/SpeechEngine.kt', import.meta.url), 'utf8');
  const audio = fs.readFileSync(new URL('../android/app/src/main/java/ai/vani/app/VaniAudioBridge.java', import.meta.url), 'utf8');
  const native = fs.readFileSync(new URL('../android/app/src/main/cpp/vani_llama.cpp', import.meta.url), 'utf8');
  assert.match(speech, /MAX_PENDING_DECODES = 3/);
  assert.match(speech, /MAX_PTT_SAMPLES = 16000 \* 60/);
  assert.match(audio, /captureLoop\(created\)/);
  assert.match(audio, /s\.record\.release\(\)/);
  assert.match(native, /std::atomic<mtmd_context \*>/);
  assert.match(native, /std::unique_ptr<mtmd_input_chunks/);
  assert.match(native, /BitmapCleanup/);
});

test('Live slow-turn watchdog reports status without force-stopping generation', () => {
  const source = fs.readFileSync(new URL('../web/js/live.js', import.meta.url), 'utf8');
  const start = source.indexOf('const armStall');
  const end = source.indexOf('gen = generate', start);
  assert.ok(start >= 0 && end > start);
  const watchdog = source.slice(start, end);
  assert.doesNotMatch(watchdog, /\.stop\s*\(/);
  assert.match(watchdog, /Still generating/);
});

test('push CI cannot rewrite an existing immutable release', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /if: github\.event_name == 'push' \|\|/);
  assert.doesNotMatch(workflow, /gh release edit/);
  assert.match(workflow, /preserving its assets and notes/);
});

test('fatal guard has no watchdog process-kill path and Activity no longer owns a cached thread pool', () => {
  const guard = fs.readFileSync(new URL('../android/app/src/main/java/ai/vani/app/CrashGuard.java', import.meta.url), 'utf8');
  const activity = fs.readFileSync(new URL('../android/app/src/main/java/ai/vani/app/MainActivity.java', import.meta.url), 'utf8');
  const executable = guard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(executable, /killProcess|System\.exit|while\s*\(true\)/);
  assert.doesNotMatch(activity, /newCachedThreadPool/);
  assert.match(activity, /if \(instance == this\) instance = null/);
});
