import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isValidYoutubeUrl } from '../lib/yt-dlp';
import {
  clearUserYtCookies,
  DEFAULT_STUDIO_CONCURRENCY,
  getPublicStudioSettings,
  loadDecryptedPlaywrightYtCookies,
  saveStudioUserConfig,
  saveUserYtCookies,
} from '../lib/studio-settings';
import {
  markClipYtDeleted,
  readClipYtSidecar,
  saveClipYtSidecar,
} from '../lib/studio-window-clips';
import {
  getEffectiveModel,
  markModelExhausted,
  MAX_CONCURRENT_MODEL_WINDOWS,
  resetModelQuotaState,
} from '../lib/studio-model-state';

async function main() {
  console.log('--- Running YouTube Link Flow & Simplified Model Rules Tests ---');

  // (a) YouTube URL validation
  assert.strictEqual(isValidYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), true, 'youtu.be valid');
  assert.strictEqual(isValidYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true, 'watch?v= valid');
  assert.strictEqual(isValidYoutubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ'), true, 'shorts valid');
  assert.strictEqual(isValidYoutubeUrl('https://example.com/video.mp4'), false, 'non-YT invalid');
  assert.strictEqual(isValidYoutubeUrl('not-a-url'), false, 'malformed URL invalid');
  console.log('✓ (a) YouTube URL validation passed');

  // (b) YT Studio cookie parse + AES-256-GCM encrypt/decrypt round-trip
  const testUser = '__test_yt_flow_user__';
  const rawCookies = JSON.stringify([
    {
      name: 'SID',
      value: 'test-sid-value-123',
      domain: '.youtube.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
    },
    {
      name: '__Secure-1PSID',
      value: 'test-1psid-456',
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  const saved = await saveUserYtCookies(testUser, rawCookies);
  assert.strictEqual(saved.count, 2, 'Should save 2 cookies');
  const pubSettings = await getPublicStudioSettings(testUser);
  assert.strictEqual(pubSettings.hasYtCookies, true, 'hasYtCookies should be true');
  assert.strictEqual(pubSettings.ytCookieCount, 2, 'ytCookieCount should be 2');
  assert.strictEqual(
    JSON.stringify(pubSettings).includes('test-sid-value-123'),
    false,
    'Public settings must NEVER leak raw cookie values',
  );

  const decrypted = await loadDecryptedPlaywrightYtCookies(testUser);
  assert.strictEqual(decrypted.length, 2, 'Decrypted should have 2 cookies');
  assert.strictEqual(decrypted[0].name, 'SID');
  assert.strictEqual(decrypted[0].value, 'test-sid-value-123');
  await clearUserYtCookies(testUser);
  assert.strictEqual((await loadDecryptedPlaywrightYtCookies(testUser)).length, 0, 'Cleared cookies should be empty');
  console.log('✓ (b) YT Studio cookie parse/encrypt/decrypt round-trip passed');

  // (c) Clip-sidecar reuse logic (reuses existing ytUrl if file unchanged and !ytDeleted)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-yt-sidecar-'));
  const dummyClip = path.join(tmpDir, 'w01_0-300.mp4');
  fs.writeFileSync(dummyClip, Buffer.from('fake-mp4-bytes-1234567890'));

  assert.strictEqual(readClipYtSidecar(dummyClip), null, 'No sidecar initially');
  saveClipYtSidecar(dummyClip, {
    scanId: 'scan-test-1',
    windowNumber: 1,
    ytUrl: 'https://youtu.be/abc123def45',
    ytVideoId: 'abc123def45',
    ytUploadedAt: Date.now(),
    ytDeleted: false,
  });

  const hit = readClipYtSidecar(dummyClip);
  assert.ok(hit, 'Sidecar should be found');
  assert.strictEqual(hit?.ytUrl, 'https://youtu.be/abc123def45');
  assert.strictEqual(hit?.ytDeleted, false);

  // Mark deleted -> readClipYtSidecar should return null
  markClipYtDeleted(dummyClip);
  assert.strictEqual(readClipYtSidecar(dummyClip), null, 'Deleted sidecar must not be reused');

  // Save again, then mutate clip file size -> sidecar invalidated
  saveClipYtSidecar(dummyClip, {
    scanId: 'scan-test-1',
    windowNumber: 1,
    ytUrl: 'https://youtu.be/xyz987uvw65',
    ytVideoId: 'xyz987uvw65',
  });
  assert.strictEqual(readClipYtSidecar(dummyClip)?.ytUrl, 'https://youtu.be/xyz987uvw65');
  fs.writeFileSync(dummyClip, Buffer.from('modified-mp4-bytes-longer-now-999999'));
  assert.strictEqual(readClipYtSidecar(dummyClip), null, 'Modified clip file must invalidate sidecar');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✓ (c) Clip-sidecar reuse & invalidation passed');

  // (d) Model switch only on quota exhaustion (not internal error; no 1-window-1-model lease blocking)
  await resetModelQuotaState(null);
  const m1 = await getEffectiveModel('Gemini 3.8 Flash', undefined, Date.now(), 'w01');
  const m2 = await getEffectiveModel('Gemini 3.8 Flash', undefined, Date.now(), 'w02');
  assert.strictEqual(m1, 'Gemini 3.8 Flash');
  assert.strictEqual(m2, 'Gemini 3.8 Flash', 'Multiple windows must use the same selected model simultaneously');

  await markModelExhausted('Gemini 3.8 Flash');
  const mAfter = await getEffectiveModel('Gemini 3.8 Flash', undefined, Date.now(), 'w01');
  assert.strictEqual(mAfter, 'Gemini 3.6 Flash', 'Should switch to 3.6 Flash on quota exhaustion');
  await resetModelQuotaState(null);
  console.log('✓ (d) Model switch only on quota exhaustion passed');

  // (e) Concurrency clamp = 10 & default = 10
  assert.strictEqual(MAX_CONCURRENT_MODEL_WINDOWS, 10, 'MAX_CONCURRENT_MODEL_WINDOWS should be 10');
  assert.strictEqual(DEFAULT_STUDIO_CONCURRENCY, 10, 'DEFAULT_STUDIO_CONCURRENCY should be 10');
  const clampedHigh = await saveStudioUserConfig(testUser, { studioConcurrency: 25 });
  assert.strictEqual(clampedHigh.studioConcurrency, 10, 'studioConcurrency > 10 should clamp to 10');
  const clampedLow = await saveStudioUserConfig(testUser, { studioConcurrency: 0 });
  assert.strictEqual(clampedLow.studioConcurrency, 1, 'studioConcurrency < 1 should clamp to 1');
  console.log('✓ (e) Concurrency clamp = 10 passed');

  console.log('ALL YOUTUBE FLOW & MODEL RULES TESTS PASSED!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
