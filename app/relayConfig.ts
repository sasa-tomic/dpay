// Hand-edited source of the default relay URL a fresh install talks to (overridable in-app via
// Settings, and per-run via DPAY_RELAY_URL — the build scripts no longer overwrite this file).
// scripts/build-apk.sh verifies the value matches the env-derived release URL before shipping.
export const RELAY_DEFAULT = 'https://dpay.kalaj.org';
