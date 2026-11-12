// page object for the playground

import { expect, type Page } from "@playwright/test";

// Extend Window interface to include groundcover for type safety in tests
declare global {
  interface Window {
    groundcover?: {
      init: (params?: any) => void;
      identifyUser: (userIdentifier: any) => void;
      sendCustomEvent: (params: { event: string; attributes: Record<string, unknown> }) => void;
      captureException: (error: Error, metadata?: Record<string, unknown>) => void;
      updateConfig: (params: any) => void;
      startNavigation: (metadata: Record<string, unknown>) => void;
      endNavigation: (metadata: Record<string, unknown>) => void;
      setSessionId: (newSessionId?: string) => Promise<void>;
      startReplayRecording: () => void;
      stopReplayRecording: () => void;
      logger: {
        log: (message: string, attributes?: Record<string, unknown>) => void;
        info: (message: string, attributes?: Record<string, unknown>) => void;
        warn: (message: string, attributes?: Record<string, unknown>) => void;
        error: (message: string, attributes?: Record<string, unknown>) => void;
        debug: (message: string, attributes?: Record<string, unknown>) => void;
        trace: (message: string, attributes?: Record<string, unknown>) => void;
      };
    };
  }
}

export default class PlaygroundPage {
  constructor(private page: Page) {}

  async validatePage() {
    await expect(this.page.getByText('groundcover SDK Playground')).toBeVisible();
    await this.page.getByText('Update Config').click();
    await this.page.getByText('Update Config').click();
  }

  async sendCustomEvent() {
    await this.page.getByText('Send Custom Event').click();
  }

  async clickConsoleLog() {
    await this.page.getByText('Console Log').click();
  }

  async identifyUser() {
    await this.page.getByText('Identify User').click();
  }

  async throwError() {
    await this.page.getByText('Throw Error').click();
  }

  async navigate() {
    await this.page.getByText('Navigate').click();
  }

  async simulateClickEvent() {
    await this.page.getByText('Simulate DOM Event').click();
    await this.page.getByText('Click Event').click();
  }

  async testCustomHeadersFetch() {
    await this.page.getByText('Test Custom Headers (Fetch)').click();
  }

  async testCustomHeadersXHR() {
    await this.page.getByText('Test Custom Headers (XHR)').click();
  }

  async testReleaseId() {
    await this.page.getByText('Test Release ID').click();
  }

  async clickLoggerWarn() {
    await this.page.getByText('Logger.warn w/ Attributes').click();
  }

  async clickConsoleLogWithObject() {
    await this.page.getByText('Console.log w/ Structured Object').click();
  }

  // --- Privacy testing ---
  async sendSensitiveNetworkRequest() {
    await this.page.getByRole('button', { name: 'Sensitive Network Request' }).click();
  }

  async logSensitiveData() {
    await this.page.getByRole('button', { name: 'Log Sensitive Data' }).click();
  }

  async captureSensitiveError() {
    await this.page.getByRole('button', { name: 'Capture Sensitive Error' }).click();
  }

  async addSensitiveUrlParam() {
    await this.page.getByRole('button', { name: 'Add Sensitive URL Param' }).click();
  }

  async flushEvents() {
    await this.page.getByRole('button', { name: 'Flush Events' }).click();
  }

  async fillSensitiveInput(value: string) {
    const input = this.page.locator('#credit-card');
    await input.click();
    // type() emits per-key keydown events (captured by the DOM listener).
    await input.type(value);
    // blur to emit a change event too.
    await this.page.locator('h1').first().click();
  }

  async fillAcctInput(value: string) {
    const input = this.page.locator('#acct');
    await input.click();
    await input.type(value);
    await this.page.locator('h1').first().click();
  }

  // Inputs that are sensitive only by virtue of an ancestor (data-private
  // wrapper / .gc-mask maskSelector wrapper) — see App.tsx.
  async fillNestedInput(id: 'nested-private' | 'nested-mask', value: string) {
    const input = this.page.locator(`#${id}`);
    await input.click();
    await input.type(value);
    await this.page.locator('h1').first().click();
  }

  async clickStaticLabel() {
    await this.page.locator('#static-label').click();
  }

  async startSessionReplay() {
    await this.page.getByRole('button', { name: 'Start Recording' }).click();
  }

  async stopSessionReplay() {
    await this.page.getByRole('button', { name: 'Stop Recording' }).click();
  }

  async drawCanvasChart() {
    await this.page.getByRole('button', { name: 'Draw Chart' }).click();
  }

  /**
   * Verify that the groundcover SDK is exposed on the window object
   * and has all expected methods available
   */
  async verifyGroundcoverOnWindow() {
    const result = await this.page.evaluate(() => {
      if (typeof window === 'undefined') {
        return { success: false, reason: 'window is undefined' };
      }

      if (!window.groundcover) {
        return { success: false, reason: 'window.groundcover is not defined' };
      }

      // Check that all expected methods exist
      const expectedMethods = [
        'init',
        'identifyUser',
        'sendCustomEvent',
        'captureException',
        'updateConfig',
        'startNavigation',
        'endNavigation',
        'setSessionId',
        'startReplayRecording',
        'stopReplayRecording'
      ];

      const missingMethods = expectedMethods.filter(
        method => typeof (window.groundcover as any)[method] !== 'function'
      );

      if (missingMethods.length > 0) {
        return { 
          success: false, 
          reason: `Missing methods: ${missingMethods.join(', ')}` 
        };
      }

      return { success: true };
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`groundcover not properly exposed on window: ${result.reason}`);
    }
  }

  /**
   * Call a groundcover method directly via the window object
   * This is useful for testing that the exposed API works correctly
   */
  async callGroundcoverMethod(methodName: string, ...args: any[]) {
    return await this.page.evaluate(
      ({ method, params }) => {
        if (!window.groundcover) {
          throw new Error('window.groundcover is not defined');
        }
        
        const fn = (window.groundcover as any)[method];
        if (typeof fn !== 'function') {
          throw new Error(`window.groundcover.${method} is not a function`);
        }

        return fn(...params);
      },
      { method: methodName, params: args }
    );
  }
}

