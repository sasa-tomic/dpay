/**
 * lib/updateCheck — the one-shot "is there a newer build?" decision (founder 2026-10-04).
 *
 * Pins the whole decision surface:
 *   • updateAvailable is TRUE only when the relay serves an APK whose build commit differs from
 *     THIS build's commit. Silent otherwise: no APK served, an empty BUILD_COMMIT (a dev/test
 *     build — the committed app/lib/buildStamp.ts placeholder), or the SAME commit (the APK is
 *     this build).
 *   • fetchUpdate never throws: a network failure, a non-200, or a malformed body degrades to
 *     null — an update banner that fires on a broken answer would be a lie.
 *   • The download URL passes through VERBATIM (the relay owns its shape, /download/dpay.apk?v=<etag>).
 */
import {describe, test, expect, jest} from '@jest/globals';
import {fetchUpdate, updateAvailable} from '../lib/updateCheck';

const REMOTE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BUILD_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const DOWNLOAD_URL = '/download/dpay.apk?v=582be6599b1cecf6eed4e6794b3f1c99';

/** A fetch impl answering `body` (JSON-serialized unless a raw string is given). */
function fetchAnswering(status: number, body: unknown) {
  return (jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  }))) as unknown as typeof fetch;
}

describe('updateAvailable — the pure decision', () => {
  const remote = {apk: {commit: REMOTE_COMMIT, url: DOWNLOAD_URL}};

  test('true only when the served build commit differs from this build', () => {
    expect(updateAvailable(remote, BUILD_COMMIT)).toBe(true);
  });

  test('silent when the relay serves the SAME commit (the APK is this build)', () => {
    expect(updateAvailable(remote, REMOTE_COMMIT)).toBe(false);
  });

  test('silent on a dev/test build (BUILD_COMMIT empty — nothing to compare)', () => {
    expect(updateAvailable(remote, '')).toBe(false);
  });

  test('silent when the relay serves no apk (null arm)', () => {
    expect(updateAvailable({apk: null}, BUILD_COMMIT)).toBe(false);
  });

  test('silent on a failed fetch (null)', () => {
    expect(updateAvailable(null, BUILD_COMMIT)).toBe(false);
  });
});

describe('fetchUpdate — one fetch, never throws', () => {
  test('parses the configured arm and passes the url through verbatim', async () => {
    const f = fetchAnswering(200, {apk: {commit: REMOTE_COMMIT, url: DOWNLOAD_URL}});
    const info = await fetchUpdate('https://relay.example', f);
    expect(info).toEqual({apk: {commit: REMOTE_COMMIT, url: DOWNLOAD_URL}});
    expect(f).toHaveBeenCalledTimes(1);
    expect((f as unknown as jest.Mock).mock.calls[0][0]).toBe('https://relay.example/api/v1/update');
  });

  test('a trailing slash on the relay base never doubles up', async () => {
    const f = fetchAnswering(200, {apk: null});
    await fetchUpdate('https://relay.example/', f);
    expect((f as unknown as jest.Mock).mock.calls[0][0]).toBe('https://relay.example/api/v1/update');
  });

  test('a non-200 answer is null (silent), not an error', async () => {
    const f = fetchAnswering(500, {apk: null});
    await expect(fetchUpdate('https://relay.example', f)).resolves.toBeNull();
  });

  test('malformed JSON is null (silent), never a throw', async () => {
    const f = (jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    }))) as unknown as typeof fetch;
    await expect(fetchUpdate('https://relay.example', f)).resolves.toBeNull();
  });

  test('a network failure is null (silent), never a throw', async () => {
    const f = (jest.fn(async () => {
      throw new Error('Network request failed');
    })) as unknown as typeof fetch;
    await expect(fetchUpdate('https://relay.example', f)).resolves.toBeNull();
  });

  test('a wrong-shaped body (apk fields missing or non-string) is null', async () => {
    for (const body of [{}, {apk: {}}, {apk: {commit: 1, url: '/x'}}, {apk: {commit: 'a'}}, 'nope', null]) {
      const f = fetchAnswering(200, body as unknown);
      await expect(fetchUpdate('https://relay.example', f)).resolves.toBeNull();
    }
  });
});
