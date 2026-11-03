import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8');

test('installer hotfix preserves package identity, ARM64 support and versionCode ordering', () => {
  assert.match(gradle, /applicationId 'ai\.vani\.app'/);
  assert.match(gradle, /minSdk 26/);
  assert.match(gradle, /targetSdk 34/);
  assert.match(gradle, /versionCode 7/);
  assert.match(gradle, /versionName '1\.5\.1'/);
  assert.match(gradle, /abiFilters 'arm64-v8a'/);
});

test('release uses conservative extractable JNI packaging and v1+v2 signing', () => {
  assert.match(gradle, /useLegacyPackaging = true/);
  assert.match(gradle, /enableV1Signing true/);
  assert.match(gradle, /enableV2Signing true/);
  assert.match(manifest, /android:extractNativeLibs="true"/);
  assert.match(gradle, /noCompress \+= \['vrm', 'glb', 'onnx'\]/);
});

test('CI blocks publication unless final APK parsing and certificate identity pass', () => {
  assert.match(workflow, /dump badging/);
  assert.match(workflow, /dump xmltree/);
  assert.match(workflow, /Verified using v1 scheme/);
  assert.match(workflow, /Verified using v2 scheme/);
  assert.match(workflow, /APK_CERT.*KEY_CERT|APK_CERT" != "\$KEY_CERT/);
  assert.match(workflow, /original OC-Lily\.vrm missing from final APK/);
});
