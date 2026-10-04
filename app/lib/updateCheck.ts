/**
 * lib/updateCheck — the app's one-shot "is there a newer build?" decision.
 *
 * Founder directive (2026-10-04): the app tells the user there is a newer version, and gets them
 * to it in 1-2 clicks. The decision needs a build identity on BOTH sides: the relay answers
 * `GET /api/v1/update` with the served APK's build commit (`<apk>.commit`, written by
 * `scripts/build-apk.sh`), and THIS build carries its own commit in `lib/buildStamp.ts` (written
 * into the release bundle by the same script; the committed placeholder is '' — a dev/test build).
 *
 * One fetch per launch, no polling, no cache: the caller (App.tsx) runs it once after mount.
 * Every failure mode — network, non-200, malformed JSON, wrong shape — degrades to null/false.
 * An update banner that fires on a broken answer would be a lie, so it never can.
 */

/** The `GET /api/v1/update` answer, strictly shaped. `apk: null` is the relay's honest "nothing to compare". */
export type RemoteUpdate = {apk: {commit: string; url: string} | null};

/** Fetch the relay's update answer. Resolves null on ANY failure; never throws. */
export async function fetchUpdate(
  relayBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteUpdate | null> {
  try {
    const res = await fetchImpl(`${relayBase.replace(/\/+$/, '')}/api/v1/update`);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const apk = (body as {apk?: unknown}).apk;
    if (apk === null) return {apk: null};
    if (typeof apk !== 'object' || apk === null) return null;
    const commit = (apk as {commit?: unknown}).commit;
    const url = (apk as {url?: unknown}).url;
    if (typeof commit !== 'string' || commit === '' || typeof url !== 'string' || url === '') {
      return null;
    }
    return {apk: {commit, url}};
  } catch {
    return null;
  }
}

/**
 * The whole decision: a banner exists ONLY when the relay serves a build whose commit differs
 * from this build's. An empty buildCommit (dev/test build) stays silent — there is nothing to
 * compare against, and a dev build must never advertise the release channel to its developer.
 */
export function updateAvailable(remote: RemoteUpdate | null, buildCommit: string): boolean {
  return (
    remote !== null &&
    remote.apk !== null &&
    buildCommit !== '' &&
    remote.apk.commit !== buildCommit
  );
}
