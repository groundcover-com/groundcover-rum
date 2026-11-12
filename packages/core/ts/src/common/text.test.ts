import { describe, it, expect } from 'vitest';
import { normalizeWhitespace, truncate } from './text';

describe('truncate', () => {
  describe('falsy values', () => {
    it('should return empty string for null', () => {
      const result = truncate({ text: null as unknown as string });
      expect(result).toBe('');
    });

    it('should return empty string for undefined', () => {
      const result = truncate({ text: undefined as unknown as string });
      expect(result).toBe('');
    });

    it('should return empty string for empty string', () => {
      const result = truncate({ text: '' });
      expect(result).toBe('');
    });
  });

  describe('string truncation', () => {
    it('should return string unchanged if within maxLength', () => {
      const text = 'Hello, world!';
      const result = truncate({ text, maxLength: 100 });
      
      expect(result).toBe(text);
    });

    it('should return string unchanged if exactly at maxLength', () => {
      const text = 'Hello';
      const result = truncate({ text, maxLength: 5 });
      
      expect(result).toBe(text);
    });

    it('should truncate string if exceeds maxLength', () => {
      const text = 'Hello, world!';
      const result = truncate({ text, maxLength: 5 });
      
      expect(result).toBe('Hello');
    });

    it('should use default maxLength of 10,000', () => {
      const text = 'a'.repeat(15000);
      const result = truncate({ text });
      
      expect(result.length).toBe(10000);
    });

    it('should handle unicode characters correctly', () => {
      const text = '👋🌍🎉';
      const result = truncate({ text, maxLength: 2 });
      
      // Note: substring counts code units, not graphemes
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it('should handle empty string without error', () => {
      const result = truncate({ text: '', maxLength: 10 });
      
      expect(result).toBe('');
    });

    it('should handle very long strings', () => {
      const text = 'x'.repeat(100000);
      const result = truncate({ text, maxLength: 1000 });
      
      expect(result.length).toBe(1000);
      expect(result).toBe('x'.repeat(1000));
    });
  });


  describe('edge cases', () => {
    it('should handle maxLength of 0', () => {
      const result = truncate({ text: 'hello', maxLength: 0 });
      
      expect(result).toBe('');
    });

    it('should handle negative maxLength', () => {
      const result = truncate({ text: 'hello', maxLength: -5 });
      
      expect(result).toBe('');
    });

    it('should handle maxLength of 1', () => {
      const result = truncate({ text: 'hello', maxLength: 1 });
      
      expect(result).toBe('h');
    });

  });

  describe('ellipsis parameter', () => {
    it('appends the ellipsis when the text is truncated', () => {
      const result = truncate({ text: 'hello world', maxLength: 5, ellipsis: '...' });

      expect(result).toBe('hello...');
    });

    it('does not append the ellipsis when the text is within the limit', () => {
      const result = truncate({ text: 'hi', maxLength: 5, ellipsis: '...' });

      expect(result).toBe('hi');
    });

    it('does not append an ellipsis by default', () => {
      const result = truncate({ text: 'hello world', maxLength: 5 });

      expect(result).toBe('hello');
    });
  });

  describe('non-string input', () => {
    it('coerces a truthy non-string to a string (honors the : string return type)', () => {
      // A stray non-string must not flow through as-is into string-typed event
      // fields; it's coerced so the return type holds.
      const result = truncate({ text: 123 as unknown as string });

      expect(typeof result).toBe('string');
      expect(result).toBe('123');
    });

    it('still applies maxLength/ellipsis to a coerced non-string', () => {
      // The coercion must not bypass the cap — a large non-string is bounded too.
      const result = truncate({
        text: 1234567 as unknown as string,
        maxLength: 3,
        ellipsis: '…',
      });

      expect(result).toBe('123…');
    });

    it('stringifies falsy primitives instead of collapsing them to empty', () => {
      // 0 / false / NaN are meaningful values, not "absent" — coerce them.
      expect(truncate({ text: 0 as unknown as string })).toBe('0');
      expect(truncate({ text: false as unknown as string })).toBe('false');
      expect(truncate({ text: NaN as unknown as string })).toBe('NaN');
    });

    it('still maps null/undefined to empty string', () => {
      expect(truncate({ text: null as unknown as string })).toBe('');
      expect(truncate({ text: undefined as unknown as string })).toBe('');
    });
  });

});

describe('normalizeWhitespace', () => {
  it('collapses runs of spaces, tabs and newlines into single spaces', () => {
    expect(normalizeWhitespace('a   b\t\tc\n\nd')).toBe('a b c d');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  hello  ')).toBe('hello');
  });

  it('returns empty string for falsy input', () => {
    expect(normalizeWhitespace('')).toBe('');
    expect(normalizeWhitespace(null as unknown as string)).toBe('');
    expect(normalizeWhitespace(undefined as unknown as string)).toBe('');
  });
});
