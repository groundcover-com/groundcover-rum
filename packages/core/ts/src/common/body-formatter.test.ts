/* eslint-disable no-restricted-globals -- exercises the optional host body
   types formatBody probes (FormData, Blob, File, ReadableStream, URLSearchParams),
   which the Node test runtime provides. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatBody } from './body-formatter';
import * as errorHandler from './error-handler';

describe('formatBody', () => {
  let handleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handleErrorSpy = vi.spyOn(errorHandler, 'handleError');
  });

  afterEach(() => {
    handleErrorSpy.mockRestore();
  });


  describe('falsy values', () => {
    it('should return empty string for null', () => {
      const result = formatBody(null);
      expect(result).toBe('');
    });

    it('should return empty string for undefined', () => {
      const result = formatBody(undefined);
      expect(result).toBe('');
    });

    it('should return empty string for empty string', () => {
      const result = formatBody('');
      expect(result).toBe('');
    });

    it('should convert 0 to string', () => {
      const result = formatBody(0);
      expect(result).toBe('0');
    });

    it('should convert false to string', () => {
      const result = formatBody(false);
      expect(result).toBe('false');
    });
  });

  describe('string values', () => {
    it('should return string unchanged', () => {
      const body = 'Hello, world!';
      const result = formatBody(body);
      expect(result).toBe(body);
    });

    it('should handle JSON string', () => {
      const body = '{"key":"value"}';
      const result = formatBody(body);
      expect(result).toBe(body);
    });
  });

  describe('FormData', () => {
    it('should return "[form data]" for FormData instance', () => {
      const formData = new FormData();
      formData.append('key', 'value');
      const result = formatBody(formData);
      expect(result).toBe('[form data]');
    });
  });

  describe('Blob', () => {
    it('should return "[blob data]" for Blob instance', () => {
      const blob = new Blob(['test'], { type: 'text/plain' });
      const result = formatBody(blob);
      expect(result).toBe('[blob data]');
    });
  });

  describe('ArrayBuffer', () => {
    it('should return "[arraybuffer data]" for ArrayBuffer instance', () => {
      const buffer = new ArrayBuffer(8);
      const result = formatBody(buffer);
      expect(result).toBe('[arraybuffer data]');
    });
  });

  describe('URLSearchParams', () => {
    it('should return string representation for URLSearchParams', () => {
      const params = new URLSearchParams();
      params.append('key1', 'value1');
      params.append('key2', 'value2');
      const result = formatBody(params);
      expect(result).toBe('key1=value1&key2=value2');
    });
  });

  describe('arrays', () => {
    it('should JSON.stringify simple array', () => {
      const body = [1, 2, 3];
      const result = formatBody(body);
      expect(result).toBe('[1,2,3]');
    });

    it('should JSON.stringify array of strings', () => {
      const body = ['a', 'b', 'c'];
      const result = formatBody(body);
      expect(result).toBe('["a","b","c"]');
    });

    it('should JSON.stringify array of objects', () => {
      const body = [{ name: 'John' }, { name: 'Jane' }];
      const result = formatBody(body);
      expect(result).toBe('[{"name":"John"},{"name":"Jane"}]');
    });

    it('should JSON.stringify nested arrays', () => {
      const body = [[1, 2], [3, 4]];
      const result = formatBody(body);
      expect(result).toBe('[[1,2],[3,4]]');
    });

    it('should JSON.stringify empty array', () => {
      const body: unknown[] = [];
      const result = formatBody(body);
      expect(result).toBe('[]');
    });
  });

  describe('objects', () => {
    it('should JSON.stringify plain object', () => {
      const body = { foo: 'bar', count: 42 };
      const result = formatBody(body);
      expect(result).toBe('{"foo":"bar","count":42}');
    });

    it('should JSON.stringify nested object', () => {
      const body = { user: { name: 'John', age: 30 } };
      const result = formatBody(body);
      expect(result).toBe('{"user":{"name":"John","age":30}}');
    });

    it('should JSON.stringify empty object', () => {
      const body = {};
      const result = formatBody(body);
      expect(result).toBe('{}');
    });

    it('should JSON.stringify object with null values', () => {
      const body = { key: null, other: 'value' };
      const result = formatBody(body);
      expect(result).toBe('{"key":null,"other":"value"}');
    });
  });

  describe('primitive types', () => {
    it('should convert number to string', () => {
      const result = formatBody(42);
      expect(result).toBe('42');
    });

    it('should convert boolean to string', () => {
      const result = formatBody(true);
      expect(result).toBe('true');
    });
  });

  describe('error handling', () => {
    it('should return default error message on circular reference', () => {
      const body: Record<string, unknown> & { circular?: unknown } = { key: 'value' };
      body.circular = body; // Create circular reference
      const result = formatBody(body);
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });

    it('should handle objects with toJSON that throws', () => {
      const body = {
        toJSON: () => {
          throw new Error('Cannot serialize');
        },
      };
      const result = formatBody(body);
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });

    it('should call handleError with formatted error message', () => {
      const body: Record<string, unknown> & { circular?: unknown } = { key: 'value' };
      body.circular = body; // Create circular reference
      formatBody(body);
      
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      const callArg = handleErrorSpy.mock.calls[0]?.[0];
      expect(typeof callArg).toBe('string');
      expect(callArg).toContain('Failed to format body:');
    });

    it('should call handleError when error occurs', () => {
      const body: Record<string, unknown> & { circular?: unknown } = { key: 'value' };
      body.circular = body; // Create circular reference
      const result = formatBody(body);
      
      // JSON.stringify throws on the cycle; formatBody reports it and returns the placeholder.
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });
  });
});

describe('formatBody - crash prevention edge cases', () => {
  let handleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    handleErrorSpy = vi.spyOn(errorHandler, 'handleError');
  });

  afterEach(() => {
    handleErrorSpy.mockRestore();
  });

  describe('deeply nested structures', () => {
    it('should handle deeply nested objects without crashing', () => {
      const obj: Record<string, unknown> = {};
      let current: Record<string, unknown> = obj;
      // Create 1000 levels of nesting
      for (let i = 0; i < 1000; i++) {
        current.nested = {};
        current = current.nested as Record<string, unknown>;
      }
      const result = formatBody(obj);
      expect(result).toContain('nested');
      expect(typeof result).toBe('string');
    });

    it('should handle deeply nested arrays without crashing', () => {
      const arr: unknown[] = [];
      let current: unknown[] = arr;
      // Create 1000 levels of nesting
      for (let i = 0; i < 1000; i++) {
        current.push([]);
        current = current[0] as unknown[];
      }
      const result = formatBody(arr);
      expect(result).toContain('[');
      expect(typeof result).toBe('string');
    });
  });

  describe('complex circular references', () => {
    it('should handle multiple circular references', () => {
      const obj1: Record<string, unknown> & { ref?: unknown } = { name: 'obj1' };
      const obj2: Record<string, unknown> & { ref?: unknown } = { name: 'obj2' };
      const obj3: Record<string, unknown> & { ref?: unknown } = { name: 'obj3' };
      obj1.ref = obj2;
      obj2.ref = obj3;
      obj3.ref = obj1; // Circular reference
      const result = formatBody(obj1);
      expect(result).toBe('[unreadable body]');
    });

    it('should handle circular reference in array', () => {
      const arr: unknown[] = [1, 2, 3];
      arr.push(arr); // Circular reference
      const result = formatBody(arr);
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });
  });

  describe('objects with problematic getters', () => {
    it('should handle getters that throw errors', () => {
      const obj = Object.create(null);
      Object.defineProperty(obj, 'problematic', {
        get: () => {
          throw new Error('Getter error');
        },
        enumerable: true,
        configurable: true,
      });
      const result = formatBody(obj);
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });

    it('should handle getters that return circular references', () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, 'circular', {
        get: () => obj,
        enumerable: true,
        configurable: true,
      });
      const result = formatBody(obj);
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });
  });

  describe('prototype pollution', () => {
    it('should handle objects with modified prototypes', () => {
      const obj = Object.create({ __proto__: { malicious: true } });
      obj.key = 'value';
      const result = formatBody(obj);
      // Should not crash, should format the object
      expect(typeof result).toBe('string');
      expect(result).toContain('key');
    });

    it('should handle objects with null prototype', () => {
      const obj = Object.create(null);
      obj.key = 'value';
      const result = formatBody(obj);
      expect(result).toBe('{"key":"value"}');
    });
  });

  describe('symbols and non-enumerable properties', () => {
    it('should handle objects with symbol keys', () => {
      const sym = Symbol('test');
      const obj: Record<string | symbol, unknown> = {};
      obj[sym] = 'value';
      obj.regular = 'key';
      const result = formatBody(obj);
      // Symbols are not included in JSON.stringify, but shouldn't crash
      expect(result).toBe('{"regular":"key"}');
    });

    it('should handle objects with non-enumerable properties', () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, 'hidden', {
        value: 'secret',
        enumerable: false,
      });
      obj.visible = 'public';
      const result = formatBody(obj);
      expect(result).toBe('{"visible":"public"}');
    });
  });

  describe('proxy objects', () => {
    it('should handle proxy objects without infinite loops', () => {
      const target = { key: 'value' };
      const proxy = new Proxy(target, {
        get: (t, prop) => {
          if (prop === 'toJSON') return undefined;
          return t[prop as keyof typeof t];
        },
      });
      const result = formatBody(proxy);
      expect(result).toBe('{"key":"value"}');
    });

    it('should handle proxy that throws on property access', () => {
      const target = {};
      const proxy = new Proxy(target, {
        get: () => {
          throw new Error('Proxy access error');
        },
      });
      const result = formatBody(proxy);
      expect(result).toBe('[unreadable body]');
    });
  });

  describe('typed arrays', () => {
    // Typed arrays / DataView are ArrayBuffer VIEWS (not `instanceof ArrayBuffer`),
    // so they must be placeholdered like ArrayBuffer rather than JSON-serialized —
    // otherwise raw upload bytes leak into telemetry as an object of numeric keys.
    it('should return "[arraybuffer data]" for Uint8Array, not its serialized bytes', () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = formatBody(arr);
      expect(result).toBe('[arraybuffer data]');
      expect(result).not.toContain('"0"');
    });

    it('should return "[arraybuffer data]" for Int32Array', () => {
      const arr = new Int32Array([1, 2, 3]);
      const result = formatBody(arr);
      expect(result).toBe('[arraybuffer data]');
    });

    it('should return "[arraybuffer data]" for Float64Array', () => {
      const arr = new Float64Array([1.1, 2.2, 3.3]);
      const result = formatBody(arr);
      expect(result).toBe('[arraybuffer data]');
    });

    it('should return "[arraybuffer data]" for a DataView', () => {
      const view = new DataView(new ArrayBuffer(8));
      const result = formatBody(view);
      expect(result).toBe('[arraybuffer data]');
    });
  });

  describe('special number values', () => {
    it('should handle NaN', () => {
      const result = formatBody(NaN);
      expect(result).toBe('NaN');
    });

    it('should handle Infinity', () => {
      const result = formatBody(Infinity);
      expect(result).toBe('Infinity');
    });

    it('should handle -Infinity', () => {
      const result = formatBody(-Infinity);
      expect(result).toBe('-Infinity');
    });

    it('should handle Number.MAX_SAFE_INTEGER', () => {
      const result = formatBody(Number.MAX_SAFE_INTEGER);
      expect(result).toBe(String(Number.MAX_SAFE_INTEGER));
    });

    it('should handle Number.MIN_SAFE_INTEGER', () => {
      const result = formatBody(Number.MIN_SAFE_INTEGER);
      expect(result).toBe(String(Number.MIN_SAFE_INTEGER));
    });
  });

  describe('BigInt', () => {
    it('should handle BigInt values without crashing', () => {
      // Use a smaller number to avoid precision loss warning
      const bigInt = BigInt('12345678901234567890');
      const result = formatBody(bigInt);
      // BigInt cannot be JSON.stringify'd, so it falls through to String()
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle objects with BigInt values', () => {
      const obj = { big: BigInt(123) };
      const result = formatBody(obj);
      // BigInt in objects causes JSON.stringify to throw, should be caught
      expect(result).toBe('[unreadable body]');
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to format body:')
      );
    });
  });

  describe('functions', () => {
    it('should handle function values without crashing', () => {
      const fn = () => 'test';
      const result = formatBody(fn);
      // Functions are converted to string via String()
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle objects with function properties', () => {
      const obj = {
        method: () => 'test',
        data: 'value',
      };
      const result = formatBody(obj);
      // Functions are omitted from JSON.stringify
      expect(result).toBe('{"data":"value"}');
    });
  });

  describe('error objects', () => {
    it('should handle Error objects', () => {
      const error = new Error('Test error');
      const result = formatBody(error);
      // Error objects have non-enumerable properties, but shouldn't crash
      expect(typeof result).toBe('string');
    });

    it('should handle TypeError', () => {
      const error = new TypeError('Type error');
      const result = formatBody(error);
      expect(typeof result).toBe('string');
    });
  });

  describe('Date objects', () => {
    it('should handle Date objects', () => {
      const date = new Date('2023-01-01');
      const result = formatBody(date);
      // Dates are converted to ISO strings by JSON.stringify
      expect(result).toContain('2023');
    });
  });

  describe('RegExp objects', () => {
    it('should handle RegExp objects', () => {
      const regex = /test/g;
      const result = formatBody(regex);
      // RegExp becomes empty object in JSON.stringify
      expect(result).toBe('{}');
    });
  });

  describe('Map and Set', () => {
    it('should handle Map objects', () => {
      const map = new Map([['key', 'value']]);
      const result = formatBody(map);
      // Maps become empty objects in JSON.stringify
      expect(result).toBe('{}');
    });

    it('should handle Set objects', () => {
      const set = new Set([1, 2, 3]);
      const result = formatBody(set);
      // Sets become empty objects in JSON.stringify
      expect(result).toBe('{}');
    });
  });

  describe('URLSearchParams edge cases', () => {
    it('should handle URLSearchParams with special characters', () => {
      const params = new URLSearchParams();
      params.append('key', 'value with spaces');
      params.append('special', '&=');
      const result = formatBody(params);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle empty URLSearchParams', () => {
      const params = new URLSearchParams();
      const result = formatBody(params);
      expect(result).toBe('');
    });
  });

  describe('very large strings', () => {
    it('should handle very large strings without crashing', () => {
      const largeString = 'a'.repeat(1000000); // 1MB string
      const result = formatBody(largeString);
      expect(result).toBe(largeString);
    });
  });

  describe('objects with toString that throws', () => {
    it('should handle objects with toString that throws', () => {
      const obj = {
        toString: () => {
          throw new Error('toString error');
        },
      };
      const result = formatBody(obj);
      // Should use JSON.stringify, not toString
      expect(result).toBe('{}');
    });
  });

  describe('the global object', () => {
    it('should handle a globalThis reference safely', () => {
      const result = formatBody(globalThis);
      // Should not crash, should return some string representation
      expect(typeof result).toBe('string');
    });
  });

  describe('ReadableStream and other stream types', () => {
    it('should return "[stream data]" for a ReadableStream, not serialize it', () => {
      if (typeof ReadableStream !== 'undefined') {
        const stream = new ReadableStream();
        const result = formatBody(stream);
        expect(result).toBe('[stream data]');
      }
    });
  });

  describe('File objects', () => {
    it('should handle File objects', () => {
      if (typeof File !== 'undefined') {
        const file = new File(['content'], 'test.txt', { type: 'text/plain' });
        const result = formatBody(file);
        // File extends Blob, so should be handled as Blob
        expect(result).toBe('[blob data]');
      }
    });
  });

  describe('null prototype chain issues', () => {
    it('should handle objects created with Object.create(null)', () => {
      const obj = Object.create(null);
      obj.key = 'value';
      const result = formatBody(obj);
      expect(result).toBe('{"key":"value"}');
    });
  });

  describe('getter/setter properties', () => {
    it('should handle objects with getters and setters', () => {
      const obj: Record<string, unknown> = {};
      let _value = 'initial';
      Object.defineProperty(obj, 'prop', {
        get: () => _value,
        set: (val) => {
          _value = val;
        },
        enumerable: true,
      });
      obj.prop = 'updated';
      const result = formatBody(obj);
      expect(result).toBe('{"prop":"updated"}');
    });
  });
});

