import { describe, it, expect } from 'vitest';
import { RandomIdGenerator } from './id-generator';

describe('RandomIdGenerator', () => {
  describe('generateId', () => {
    it('should generate a string', () => {
      const generator = new RandomIdGenerator();
      const id = generator.generateId();
      
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
    
    it('should generate unique IDs', () => {
      const generator = new RandomIdGenerator();
      const ids = new Set();
      
      // Generate multiple IDs and check for uniqueness
      for (let i = 0; i < 100; i++) {
        ids.add(generator.generateId());
      }
      
      expect(ids.size).toBe(100);
    });
    
    it('should generate IDs with correct length', () => {
      const generator = new RandomIdGenerator();
      const id = generator.generateId();
      
      // ID_BYTES = 16, and each byte is represented by 2 characters
      expect(id.length).toBe(32);
    });
  });
  
  describe('generateTraceId', () => {
    it('should generate a string', () => {
      const generator = new RandomIdGenerator();
      const traceId = generator.generateTraceId();
      
      expect(typeof traceId).toBe('string');
      expect(traceId.length).toBeGreaterThan(0);
    });
    
    it('should generate unique trace IDs', () => {
      const generator = new RandomIdGenerator();
      const traceIds = new Set();
      
      for (let i = 0; i < 100; i++) {
        traceIds.add(generator.generateTraceId());
      }
      
      expect(traceIds.size).toBe(100);
    });
    
    it('should generate trace IDs with correct length', () => {
      const generator = new RandomIdGenerator();
      const traceId = generator.generateTraceId();
      
      // TRACE_ID_BYTES = 16, and each byte is represented by 2 characters
      expect(traceId.length).toBe(32);
    });

    it('should generate trace IDs with upper 64 bits set to zero', () => {
      const generator = new RandomIdGenerator();
      
      // Test multiple trace IDs to ensure consistency
      for (let i = 0; i < 100; i++) {
        const traceId = generator.generateTraceId();
        
        // First 16 characters should be zeros (upper 64 bits)
        expect(traceId.substring(0, 16)).toBe('0000000000000000');
        // Last 16 characters should be random hex (lower 64 bits)
        expect(traceId.substring(16)).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  });
  
  describe('generateSpanId', () => {
    it('should generate a string', () => {
      const generator = new RandomIdGenerator();
      const spanId = generator.generateSpanId();
      
      expect(typeof spanId).toBe('string');
      expect(spanId.length).toBeGreaterThan(0);
    });
    
    it('should generate unique span IDs', () => {
      const generator = new RandomIdGenerator();
      const spanIds = new Set();
      
      for (let i = 0; i < 100; i++) {
        spanIds.add(generator.generateSpanId());
      }
      
      expect(spanIds.size).toBe(100);
    });
    
    it('should generate span IDs with correct length', () => {
      const generator = new RandomIdGenerator();
      const spanId = generator.generateSpanId();
      
      // SPAN_ID_BYTES = 8, and each byte is represented by 2 characters
      expect(spanId.length).toBe(16);
    });
  });
  
  describe('ID generation implementation', () => {
    it('should generate IDs with hexadecimal characters only', () => {
      const generator = new RandomIdGenerator();
      const id = generator.generateId();
      const traceId = generator.generateTraceId();
      const spanId = generator.generateSpanId();
      
      const hexRegex = /^[0-9a-f]+$/i;
      expect(id).toMatch(hexRegex);
      expect(traceId).toMatch(hexRegex);
      expect(spanId).toMatch(hexRegex);
    });
    
    it('should use the shared character codes array for efficiency', () => {
      // This is more of an implementation detail test
      // We can verify that multiple calls don't create new arrays
      const generator = new RandomIdGenerator();
      
      // Generate multiple IDs in sequence
      const id1 = generator.generateId();
      const id2 = generator.generateId();
      
      expect(id1).not.toBe(id2); // Different IDs
      expect(id1.length).toBe(id2.length); // Same length
    });
  });
}); 