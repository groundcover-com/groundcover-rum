import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from './config-manager';
import { SDKConfig } from './sdk-config';
import { SDKConfigInput } from './types';

// Mock the Logger class
vi.mock('../common/logger', () => {
  return {
    Logger: {
      getInstance: vi.fn(() => ({
        log: vi.fn(),
      })),
    },
  };
});

// ConfigManager is config-only: session identity/activity state is SessionState's, tested in
// src/session/session-state.test.ts.
describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let mockConfig: SDKConfigInput;

  beforeEach(() => {
    // Create a mock config for testing
    mockConfig = {
      dsn: 'https://test-dsn.com',
      appId: 'test-app-id',
      cluster: 'test-cluster',
      environment: 'test',
      apiKey: 'test-api-key',
      user: {
        id: 'test-user-id',
        email: 'test@example.com',
      },
      options: {
        debug: true,
        sessionSampleRate: 0.5,
      },
    };

    // Get a fresh instance of ConfigManager
    configManager = new ConfigManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('construction', () => {
    // ConfigManager is not a singleton: each construction yields an independent
    // instance.
    it('should return independent instances when constructed multiple times', () => {
      const instance1 = new ConfigManager();
      const instance2 = new ConfigManager();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('should initialize the config with the provided input', () => {
      configManager.initialize(mockConfig);

      const config = configManager.getConfig();

      expect(config).toBeInstanceOf(SDKConfig);
      expect(config?.dsn).toBe(mockConfig.dsn);
      expect(config?.appId).toBe(mockConfig.appId);
      expect(config?.cluster).toBe(mockConfig.cluster);
      expect(config?.environment).toBe(mockConfig.environment);
      expect(config?.apiKey).toBe(mockConfig.apiKey);
      expect(config?.user).toEqual(mockConfig.user);
      expect(config?.options.debug).toBe(mockConfig.options?.debug);
      expect(config?.options.sessionSampleRate).toBe(mockConfig.options?.sessionSampleRate);
    });

    it('should not reinitialize if config is already initialized', () => {
      configManager.initialize(mockConfig);

      const updatedMockConfig = {
        ...mockConfig,
        appId: 'different-app-id',
      };

      configManager.initialize(updatedMockConfig);

      const config = configManager.getConfig();
      expect(config?.appId).toBe(mockConfig.appId); // Should still be the original value
    });

    it('should initialize with default values when no config provided', () => {
      configManager.initialize();

      const config = configManager.getConfig();

      expect(config).toBeInstanceOf(SDKConfig);
      expect(config?.dsn).toBe('');
      expect(config?.appId).toBe('');
      expect(config?.cluster).toBe('');
      expect(config?.environment).toBe('');
      expect(config?.apiKey).toBe('');
      expect(config?.user).toBe(null);
      expect(config?.options).toBeDefined();
    });

    it('should initialize with partial config when only some properties provided', () => {
      const partialConfig: Partial<SDKConfigInput> = {
        appId: 'test-app',
        cluster: 'test-cluster',
        options: {
          debug: true,
        },
      };

      configManager.initialize(partialConfig as SDKConfigInput);

      const config = configManager.getConfig();

      expect(config?.appId).toBe('test-app');
      expect(config?.cluster).toBe('test-cluster');
      expect(config?.dsn).toBe(''); // Should use default empty string
      expect(config?.options.debug).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return the initialized config', () => {
      configManager.initialize(mockConfig);

      const config = configManager.getConfig();

      expect(config).toBeInstanceOf(SDKConfig);
      expect(config?.dsn).toBe(mockConfig.dsn);
    });
  });

  describe('updateConfig', () => {
    it('should update options when provided', () => {
      configManager.initialize(mockConfig);

      configManager.updateConfig({
        options: {
          debug: false,
          sessionSampleRate: 0.75,
        },
      });

      const config = configManager.getConfig();

      expect(config?.options.debug).toBe(false);
      expect(config?.options.sessionSampleRate).toBe(0.75);
      expect(config?.options.transport?.batchSize).toBeDefined();
    });

    it('should update userIdentifier when provided', () => {
      configManager.initialize(mockConfig);

      const newUserIdentifier = {
        id: 'new-user-id',
        email: 'new@example.com',
        name: 'New User',
      };

      configManager.updateConfig({
        user: newUserIdentifier,
      });

      const config = configManager.getConfig();

      expect(config?.user).toEqual({
        ...mockConfig.user,
        ...newUserIdentifier,
      });
    });

    it('should update both options and user when provided', () => {
      configManager.initialize(mockConfig);

      configManager.updateConfig({
        options: {
          debug: false,
        },
        user: {
          email: 'new@example.com',
          id: 'new-user-id',
        },
      });

      const config = configManager.getConfig();

      expect(config?.options.debug).toBe(false);
      expect(config?.user?.id).toBe('new-user-id');
    });

    // getConfig() hands back the LIVE SDKConfig, so holding the object and
    // comparing it to itself after the update would assert nothing. updateConfig
    // assigns every one of these identity fields, so this pins that they are
    // mutable, snapshotting primitives rather than the reference.
    it('should update identity config fields (they are not readonly)', () => {
      configManager.initialize(mockConfig);
      const original = { ...configManager.getConfig() };

      configManager.updateConfig({
        cluster: 'updated-cluster',
        environment: 'production',
        dsn: 'https://updated-dsn.com',
        appId: 'updated-app',
        apiKey: 'updated-api-key',
        namespace: 'updated-namespace',
      });

      const config = configManager.getConfig();

      expect(config?.cluster).toBe('updated-cluster');
      expect(config?.environment).toBe('production');
      expect(config?.dsn).toBe('https://updated-dsn.com');
      expect(config?.appId).toBe('updated-app');
      expect(config?.apiKey).toBe('updated-api-key');
      expect(config?.namespace).toBe('updated-namespace');

      // ...and they really did change from what init established.
      expect(config?.cluster).not.toBe(original.cluster);
      expect(config?.dsn).not.toBe(original.dsn);
    });

    it('should leave identity fields untouched when the update omits them', () => {
      configManager.initialize(mockConfig);
      const original = { ...configManager.getConfig() };

      configManager.updateConfig({ options: { debug: true } });

      const config = configManager.getConfig();

      expect(config?.cluster).toBe(original.cluster);
      expect(config?.environment).toBe(original.environment);
      expect(config?.dsn).toBe(original.dsn);
      expect(config?.appId).toBe(original.appId);
      expect(config?.apiKey).toBe(original.apiKey);
      expect(config?.namespace).toBe(original.namespace);
    });

    it('should handle updating only supported fields (options and user)', () => {
      configManager.initialize(mockConfig);

      configManager.updateConfig({
        options: {
          debug: true,
          transport: { batchSize: 50 },
        },
        user: {
          id: 'test-user',
          email: 'test@example.com',
        },
      });

      const config = configManager.getConfig();

      // Should maintain original core config values
      expect(config?.cluster).toBe(mockConfig.cluster);
      expect(config?.appId).toBe(mockConfig.appId);

      // Should update the mutable fields
      expect(config?.options.debug).toBe(true);
      expect(config?.options.transport?.batchSize).toBe(50);
      expect(config?.user?.id).toBe('test-user');
      expect(config?.user?.email).toBe('test@example.com');
    });
  });

  describe('releaseId configuration', () => {
    it('should initialize with releaseId when provided', () => {
      const configWithReleaseId = {
        ...mockConfig,
        releaseId: 'v1.2.3',
      };

      configManager.initialize(configWithReleaseId);

      const config = configManager.getConfig();

      expect(config?.releaseId).toBe('v1.2.3');
    });

    it('should initialize with undefined releaseId when not provided', () => {
      configManager.initialize(mockConfig);

      const config = configManager.getConfig();

      expect(config?.releaseId).toBeUndefined();
    });

    it('should allow setting releaseId with a commit hash', () => {
      const configWithCommitHash = {
        ...mockConfig,
        releaseId: 'abc123def456',
      };

      configManager.initialize(configWithCommitHash);

      const config = configManager.getConfig();

      expect(config?.releaseId).toBe('abc123def456');
    });
  });

  describe('trace propagation header configuration', () => {
    it('should initialize with default empty trace propagation header names', () => {
      configManager.initialize(mockConfig);

      const config = configManager.getConfig();

      expect(config?.options.tracing?.traceIdHeaderName).toBe('');
      expect(config?.options.tracing?.spanIdHeaderName).toBe('');
    });

    it('should allow setting custom trace propagation header names', () => {
      const configWithTraceHeaders = {
        ...mockConfig,
        options: {
          ...mockConfig.options,
          tracing: {
            traceIdHeaderName: 'x-groundcover-trace-id',
            spanIdHeaderName: 'x-groundcover-parent-id',
          },
        },
      };

      configManager.initialize(configWithTraceHeaders);

      const config = configManager.getConfig();

      expect(config?.options.tracing?.traceIdHeaderName).toBe('x-groundcover-trace-id');
      expect(config?.options.tracing?.spanIdHeaderName).toBe('x-groundcover-parent-id');
    });

    it('should update trace propagation header names via updateConfig', () => {
      configManager.initialize(mockConfig);

      configManager.updateConfig({
        options: {
          tracing: {
            traceIdHeaderName: 'x-custom-trace-id',
            spanIdHeaderName: 'x-custom-span-id',
          },
        },
      });

      const config = configManager.getConfig();

      expect(config?.options.tracing?.traceIdHeaderName).toBe('x-custom-trace-id');
      expect(config?.options.tracing?.spanIdHeaderName).toBe('x-custom-span-id');
    });

    it('should maintain other options when updating trace propagation headers', () => {
      configManager.initialize(mockConfig);

      configManager.updateConfig({
        options: {
          tracing: {
            traceIdHeaderName: 'x-trace-id',
            spanIdHeaderName: 'x-span-id',
          },
        },
      });

      const config = configManager.getConfig();

      // Original options should be preserved
      expect(config?.options.debug).toBe(mockConfig.options?.debug);
      expect(config?.options.sessionSampleRate).toBe(mockConfig.options?.sessionSampleRate);

      // New options should be set
      expect(config?.options.tracing?.traceIdHeaderName).toBe('x-trace-id');
      expect(config?.options.tracing?.spanIdHeaderName).toBe('x-span-id');
    });
  });
});
