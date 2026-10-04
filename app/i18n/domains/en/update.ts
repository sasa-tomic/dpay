/**
 * i18n/domains/en/update.ts — the in-app update notice.
 *
 * The whole surface is ONE line and ONE button (founder 2026-10-04): the app says a newer
 * version exists, the button opens the browser to download it, the system installer prompt is
 * the second click. No dialog, no badge, no settings entry — the copy stays that small on
 * purpose.
 */

export type UpdateMessages = {
  /** The notice line. States the fact and nothing else — no version numbers, no urgency. */
  available: string;
  /** The single button. Opens the relay's download URL in the browser. */
  action: string;
};

export const updateEn: UpdateMessages = {
  available: 'A newer version of dpay is available.',
  action: 'Update',
};
