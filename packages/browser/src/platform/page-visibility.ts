import { handleError } from "@groundcover/rum-core/common/error-handler";

// Whether the page was visible recently, so the user could have seen what it
// held: it is visible now, or it stopped being visible no longer ago than a
// given window.
//
// Read when the SDK starts, on every visibility change, and when asked, so a
// change the listeners missed still counts. The page is visible when it is the
// active tab of a window that isn't minimized. It stays not visible while it
// loads in a background tab, while the device is locked or asleep, and while it
// is prerendered and nobody has opened it yet (`prerenderingchange` fires when
// they do).
//
// Recent, not ever: a tab seen for a moment and then left in the background
// for hours shouldn't send that background traffic as part of what the user
// saw.
//
// Not presence: a page can be visible with nobody in front of it. It only
// says the page wasn't out of sight.
export class PageVisibilityTracker {
  private visible = false;
  // When the page was last seen visible, or stopped being visible; null if it
  // never was.
  private lastVisibleAtMs: number | null = null;
  private listening = false;

  // Contained: runs as a document event handler in arbitrary embeds.
  private readonly read = (): void => {
    try {
      if (typeof document === "undefined") return;
      const prerendering = (document as Document & { prerendering?: boolean }).prerendering === true;
      const visibleNow = document.visibilityState === "visible" && !prerendering;
      // Visible now, or just stopped being: either way it was visible until now.
      if (visibleNow || this.visible) this.lastVisibleAtMs = Date.now();
      this.visible = visibleNow;
    } catch (error) {
      handleError(error);
    }
  };

  start(): void {
    this.read();
    if (this.listening || typeof document === "undefined") return;
    this.listening = true;
    try {
      document.addEventListener("visibilitychange", this.read);
      document.addEventListener("prerenderingchange", this.read);
    } catch (error) {
      handleError(error);
    }
  }

  stop(): void {
    if (!this.listening || typeof document === "undefined") return;
    this.listening = false;
    try {
      document.removeEventListener("visibilitychange", this.read);
      document.removeEventListener("prerenderingchange", this.read);
    } catch (error) {
      handleError(error);
    }
  }

  // Visible now, or stopped being visible at most `windowMs` ago.
  wasVisibleWithin(windowMs: number): boolean {
    this.read();
    if (this.visible) return true;
    return this.lastVisibleAtMs !== null && Date.now() - this.lastVisibleAtMs <= windowMs;
  }
}
