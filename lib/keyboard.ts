export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const element = target as (Element & {
    tagName?: string;
    isContentEditable?: boolean;
  }) | null;
  if (!element) return false;

  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
  if (element.isContentEditable) return true;

  if (typeof element.getAttribute === "function") {
    const role = element.getAttribute("role");
    if (role === "textbox") return true;
    const contentEditable = element.getAttribute("contenteditable");
    if (contentEditable === "" || contentEditable === "true" || contentEditable === "plaintext-only") {
      return true;
    }
  }

  if (typeof element.closest === "function") {
    const closestEditable = element.closest("input, textarea, select, [role='textbox'], [contenteditable]");
    if (!closestEditable) return false;
    const closestTagName = closestEditable.tagName.toLowerCase();
    if (closestTagName === "input" || closestTagName === "textarea" || closestTagName === "select") return true;
    if ((closestEditable as HTMLElement).isContentEditable) return true;
    const contentEditable = closestEditable.getAttribute("contenteditable");
    return contentEditable === "" || contentEditable === "true" || contentEditable === "plaintext-only";
  }

  return false;
}

export function shouldHandleKeyboardShortcut(target: EventTarget | null): boolean {
  return !isEditableKeyboardTarget(target);
}
