/**
 * Shared layout for /admin pages.
 *
 * Mounts EditorTokenBridge so every admin page bootstraps the existing editor
 * session the same way the main schedule page does. Previously the bridge ran
 * only on `/`, so opening an admin page directly (saved link / Home Screen PWA)
 * left the httpOnly `la_editor_session` cookie unrefreshed and every admin API
 * call returned 401.
 *
 * This adds no sign-in step and no second auth system — it reuses the one-time
 * `?editor=` token this device already stored.
 */

import { EditorTokenBridge } from "@/components/EditorTokenBridge";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <EditorTokenBridge />
      {children}
    </>
  );
}
