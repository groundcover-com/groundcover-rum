import { describe, it, expect, beforeEach, afterEach, vi, MockedFunction } from 'vitest';
import { AsyncEncoder, Transporter } from './transporter';
import { Logger } from '../common/logger';
import { ConfigManager } from '../config/config-manager';
import { Batch } from '../events/types';
import { gzipSync, strToU8 } from 'fflate';

// All vi.mock calls at the top, with no external variable references
vi.mock('../common/logger', () => ({
  Logger: {
    getInstance: vi.fn().mockReturnValue({
      log: vi.fn()
    })
  }
}));

// strToU8 starts as the real one: common/utf8 checks at load that it encodes
// exactly, and only then sends every call through it.
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return {
    gzipSync: vi.fn(),
    strToU8: vi.fn(actual.strToU8)
  };
});

// The real encoder, for expected payload bytes (fflate itself is mocked above).
const { strToU8: realStrToU8 } = await vi.importActual<typeof import('fflate')>('fflate');

// Regular test setup after all mocks
describe('Transporter', () => {
  // Type definitions for our test
  interface TestConfig {
    apiKey?: string;
    dsn: string;
    appId: string;
    cluster: string;
    environment: string;
    user: { id: string };
    options: { debug?: boolean; transport?: { compression?: boolean } };
    getEndpoint: () => string;
  }

  // Test variables
  let transporter: Transporter;
  let mockedGzipSync: MockedFunction<typeof gzipSync>;
  let mockedStrToU8: MockedFunction<typeof strToU8>;
  let mockConfigManager: { getConfig: MockedFunction<() => TestConfig | null> };
  let mockLogger: { log: MockedFunction<(message: string, ...rest: unknown[]) => void> };
  const mockFetch = vi.fn().mockResolvedValue({ ok: true });
  const mockCompressedData = new Uint8Array([1, 2, 3, 4, 5]);
  const originalStrToU8 = realStrToU8;

  // Default config for tests
  const defaultConfig: TestConfig = {
    apiKey: 'test-api-key',
    dsn: 'https://test-endpoint.com',
    appId: 'test-app',
    cluster: 'test-cluster',
    environment: 'test',
    user: { id: 'test-user' },
    options: {
      debug: false,
      transport: { compression: true }
    },
    // Matches the real SDKConfig.getEndpoint: the connection base, no path.
    getEndpoint: () => 'https://test-endpoint.com',
  };

  // DI: the ConfigManager is a plain injected fake — no module mock needed.
  const asConfigManager = () => mockConfigManager as unknown as ConfigManager;

  // The network primitive is injected; the recording sender below is what the
  // mockFetch assertions observe.
  const fetchSender = (endpoint: string, request: unknown) => mockFetch(endpoint, request);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    // Setup mocked implementations for our imports
    mockedGzipSync = vi.mocked(gzipSync);
    mockedStrToU8 = vi.mocked(strToU8);
    mockConfigManager = { getConfig: vi.fn() };
    mockLogger = vi.mocked(Logger.getInstance()) as unknown as {
      log: MockedFunction<(message: string, ...rest: unknown[]) => void>
    };

    // Set default behavior
    mockConfigManager.getConfig.mockReturnValue(defaultConfig);
    mockedStrToU8.mockImplementation((data: string) => originalStrToU8(data));
    mockedGzipSync.mockImplementation(() => mockCompressedData);

    // Create our test subject
    transporter = new Transporter({ config: asConfigManager(), sendBatch: fetchSender });
  });

  const testBatch: Batch = {
    sessionAttributes: {
      session_id: 'test-session',
      session_start_time: 1700000000000,
      user: { id: 'test-user' },
      device: { model: 'test-device', os: 'test-os', version: '1.0', language: 'en' },
    },
    events: [{ type: 'custom', timestamp: Date.now(), id: '1', spanId: '1', parentSpanId: '1', traceId: '1' }],
  };
  const testBatchJSON = JSON.stringify(testBatch);

  describe('send', () => {
    it('should send compressed data when fflate compression succeeds', async () => {
      await transporter.send(testBatch);

      expect(mockedStrToU8).toHaveBeenCalledWith(testBatchJSON);
      expect(mockedGzipSync).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            apikey: 'test-api-key',
          },
          body: mockCompressedData,
        }
      );
    });

    it('passes no transport-specific keepalive option to the sender', async () => {
      await transporter.send(testBatch);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchOptions = mockFetch.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(fetchOptions).toBeDefined();
      expect(fetchOptions).not.toHaveProperty('keepalive');
    });

    // The network primitive is injected, not read off the global: core must
    // never touch `fetch` itself (no-restricted-globals enforces that
    // statically; this pins the runtime behaviour).
    it('sends through the injected BatchSender, not the global fetch', async () => {
      const injected = vi.fn().mockResolvedValue({ ok: true });
      const globalFetch = vi.fn();
      vi.stubGlobal('fetch', globalFetch);

      const isolated = new Transporter({ config: asConfigManager(), sendBatch: injected });
      await isolated.send(testBatch);

      expect(injected).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(injected).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('logs and contains a rejecting sender instead of leaking an unhandled rejection', async () => {
      const rejecting = vi.fn().mockRejectedValue(new Error('offline'));

      const isolated = new Transporter({ config: asConfigManager(), sendBatch: rejecting });

      await expect(isolated.send(testBatch)).resolves.toBeUndefined();
      await Promise.resolve();
      expect(rejecting).toHaveBeenCalledTimes(1);
    });

    it('should send uncompressed data when fflate compression fails', async () => {
      const compressionError = new Error('Compression failed');
      mockedGzipSync.mockImplementationOnce(() => {
        throw compressionError;
      });

      await transporter.send(testBatch);

      expect(mockedStrToU8).toHaveBeenCalledWith(testBatchJSON);
      expect(mockedGzipSync).toHaveBeenCalledWith(expect.any(Uint8Array));
      
      const expectedUncompressedData = realStrToU8(testBatchJSON);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': '',
            apikey: 'test-api-key',
          },
          body: expectedUncompressedData,
        }
      );
    });

    it('should handle network errors gracefully', async () => {
      const networkError = new Error('Network error');
      mockFetch.mockRejectedValueOnce(networkError);

      await transporter.send(testBatch);
      // send() never awaits the sender, so its handlers run after send() returns.
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockLogger.log).toHaveBeenCalledWith(
        'Network error while sending batch:',
        networkError,
        { groundcoverIgnore: true }
      );
    });

    // fetch resolves, not rejects, on 4xx and 5xx: before this was read, an
    // endpoint that refused every batch looked exactly like one that took them.
    describe('a resolved response that is not 2xx', () => {
      const ENDPOINT = 'https://test-endpoint.com/json/rum';
      let warnSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      });

      afterEach(() => {
        warnSpy.mockRestore();
      });

      // send() never awaits the sender, so the response handler runs after it returns.
      const sendAndSettle = async (response: unknown) => {
        mockFetch.mockResolvedValueOnce(response);
        await transporter.send(testBatch);
        await new Promise(resolve => setTimeout(resolve, 0));
      };

      it('logs the status and endpoint in debug, without a console warning', async () => {
        await sendAndSettle({ ok: false, status: 500 });

        expect(mockLogger.log).toHaveBeenCalledWith(
          `Batch rejected by ${ENDPOINT} with HTTP 500`,
          { groundcoverIgnore: true }
        );
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it.each([401, 403])('warns once without debug when the endpoint refuses the credentials (%i)', async (status) => {
        await sendAndSettle({ ok: false, status });
        await sendAndSettle({ ok: false, status });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const message = String(warnSpy.mock.calls[0]?.[0]);
        expect(message).toContain(`${ENDPOINT} rejected a batch with HTTP ${status}`);
        expect(message).toContain('apiKey');
        // The SDK's own console capture skips messages carrying this marker.
        expect(message).toContain('groundcoverIgnore');
      });

      it('warns separately for 401 and 403', async () => {
        await sendAndSettle({ ok: false, status: 401 });
        await sendAndSettle({ ok: false, status: 403 });

        expect(warnSpy).toHaveBeenCalledTimes(2);
      });

      it('reports nothing for a 2xx, or for a sender that resolves with no response', async () => {
        await sendAndSettle({ ok: true, status: 202 });
        await sendAndSettle(undefined);

        expect(mockLogger.log).not.toHaveBeenCalledWith(
          expect.stringContaining('Batch rejected'),
          expect.anything()
        );
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    it('should not send request when no API key is provided', async () => {
      mockConfigManager.getConfig.mockReturnValueOnce({ 
        ...defaultConfig, 
        apiKey: undefined 
      });

      await transporter.send(testBatch);

      expect(mockLogger.log).toHaveBeenCalledWith('No API key found');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should log batch in debug mode', async () => {
      mockConfigManager.getConfig.mockReturnValueOnce({
        ...defaultConfig,
        options: { debug: true, transport: { compression: true } }
      });

      await transporter.send(testBatch);

      expect(mockLogger.log).toHaveBeenCalledWith(
        'Sending batch:',
        testBatch,
        { groundcoverIgnore: true }
      );
      expect(mockFetch).toHaveBeenCalled();
    });

    it('compresses inline (never the async encoder) when called with lifecycle: true', async () => {
      // A lifecycle flush must queue the send before returning — the async
      // encoder round-trip would otherwise let the host suspend before the
      // request is dispatched.
      const encodeAsync = vi.fn<AsyncEncoder>().mockResolvedValue({
        data: new Uint8Array([9, 9, 9]),
        isCompressed: true,
      });
      const lifecycleTransporter = new Transporter({ config: asConfigManager(), sendBatch: fetchSender, encodeAsync });

      await lifecycleTransporter.send(testBatch, { lifecycle: true });

      // Inline path uses strToU8 + gzipSync (mocked here); the injected
      // async encoder must never be consulted.
      expect(encodeAsync).not.toHaveBeenCalled();
      expect(mockedStrToU8).toHaveBeenCalledWith(testBatchJSON);
      expect(mockedGzipSync).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        expect.objectContaining({ method: 'POST', body: mockCompressedData }),
      );
    });

    it('routes non-lifecycle sends through the injected async encoder', async () => {
      const encodedData = new Uint8Array([7, 7, 7]);
      const encodeAsync = vi.fn<AsyncEncoder>().mockResolvedValue({
        data: encodedData,
        isCompressed: true,
      });
      const asyncTransporter = new Transporter({ config: asConfigManager(), sendBatch: fetchSender, encodeAsync });

      await asyncTransporter.send(testBatch);

      expect(encodeAsync).toHaveBeenCalledWith(testBatchJSON, true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Encoding': 'gzip' }),
          body: encodedData,
        }),
      );
    });

    it('falls back to the inline path when the injected async encoder fails', async () => {
      const encodeAsync = vi.fn<AsyncEncoder>().mockRejectedValue(new Error('encoder crashed'));
      const asyncTransporter = new Transporter({ config: asConfigManager(), sendBatch: fetchSender, encodeAsync });

      await asyncTransporter.send(testBatch);

      expect(encodeAsync).toHaveBeenCalledWith(testBatchJSON, true);
      // Inline fallback compresses via strToU8 + gzipSync (mocked here).
      expect(mockedStrToU8).toHaveBeenCalledWith(testBatchJSON);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        expect.objectContaining({ method: 'POST', body: mockCompressedData }),
      );
    });

    // A custom encoder that throws SYNCHRONOUSLY (before returning a promise)
    // must be treated exactly like a rejected one: the inline fallback still
    // sends the batch once. Unguarded, the sync throw would skip the `.catch()`
    // and bubble to send()'s outer catch, silently dropping the batch.
    it('falls back to the inline path when the injected async encoder throws synchronously', async () => {
      const encodeAsync = vi.fn<AsyncEncoder>().mockImplementation(() => {
        throw new Error('sync encoder crash');
      });
      const asyncTransporter = new Transporter({ config: asConfigManager(), sendBatch: fetchSender, encodeAsync });

      await asyncTransporter.send(testBatch);

      expect(encodeAsync).toHaveBeenCalledWith(testBatchJSON, true);
      // Inline fallback compresses via strToU8 + gzipSync (mocked here) and
      // still dispatches the batch — a sync throw must not drop telemetry.
      expect(mockedStrToU8).toHaveBeenCalledWith(testBatchJSON);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-endpoint.com/json/rum',
        expect.objectContaining({ method: 'POST', body: mockCompressedData }),
      );
    });
  });

  describe('buildEndpoint', () => {
    it('should build the correct endpoint URL', () => {
      // Access private method for testing using a function property accessor
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildEndpoint = (transporter as any).buildEndpoint.bind(transporter);
      expect(buildEndpoint()).toBe('https://test-endpoint.com/json/rum');
    });

    it('should return empty string if config is not available for buildEndpoint', () => {
      mockConfigManager.getConfig.mockReturnValueOnce(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildEndpoint = (transporter as any).buildEndpoint.bind(transporter);
      expect(buildEndpoint()).toBe("");
    });

    it('upgrades a bare-host dsn via getEndpoint instead of sending it as a relative URL', () => {
      // A bare host has no scheme; getEndpoint() upgrades it to https://. The
      // endpoint must use that, not the raw dsn (which the sender would treat as relative).
      mockConfigManager.getConfig.mockReturnValueOnce({
        ...defaultConfig,
        dsn: 'bare-host.com',
        getEndpoint: () => 'https://bare-host.com',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildEndpoint = (transporter as any).buildEndpoint.bind(transporter);
      expect(buildEndpoint()).toBe('https://bare-host.com/json/rum');
    });
  });
}); 