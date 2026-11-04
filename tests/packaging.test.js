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
  assert.match(gradle, /versionCode 8/);
  assert.match(gradle, /versionName '1\.5\.2'/);
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
  assert.match(workflow, /OUT=dist\/vani-ai-1\.5\.2-release\.apk/);
  assert.match(workflow, /versionCode='8' versionName='1\.5\.2'/);
});

test('verified pushes publish the standard versioned GitHub release directly', () => {
  assert.match(workflow, /RELEASE_TAG: "v1\.5\.2"/);
  assert.match(workflow, /if: github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.publish_release\)/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG"/);
  assert.match(workflow, /--title "Vani AI v1\.5\.2" --notes-file \/tmp\/body\.md --latest/);
  assert.match(workflow, /ASSETS=\(dist\/vani-ai-1\.5\.2-release\.apk dist\/vani-ai-1\.5\.2-source\.zip dist\/SHA256SUMS\.txt\)/);
  assert.doesNotMatch(workflow, /TEST_PUBLISH|inputs\.release_tag|PRERELEASE|\[publish-test\]/);
});
