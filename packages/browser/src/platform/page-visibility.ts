import { handleError } from "@groundcover/rum-core/common/error-handler";

// Whether the page has been visible at any point since the SDK started, so
// the user could have seen it.
//
// Read when the SDK starts, on every visibility change, and when asked, so a
// change the listeners missed still counts. The page is visible when it is the
// active tab of a window that isn't minimized. It stays not visible while it
// loads in a background tab, while the device is locked or asleep, and while it
// is prerendered and nobody has opened it yet (`prerenderingchange` fires when
// they do).
//
// Not presence: a page can be visible with nobody in front of it. It only
// says the page wasn't loaded out of sight.
export class PageVisibilityTracker {
  private seen = false;
  private listening = false;

  // Contained: runs as a document event handler in arbitrary embeds.
  private readonly read = (): void => {
    try {
      if (typeof document === "undefined") return;
      const prerendering = (document as Document & { prerendering?: boolean }).prerendering === true;
      if (document.visibilityState === "visible" && !prerendering) this.seen = true;
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

  wasVisible(): boolean {
    this.read();
    return this.seen;
  }
}
