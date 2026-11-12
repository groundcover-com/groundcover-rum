const SPAN_ID_BYTES = 8;
const TRACE_ID_LOWER_BYTES = 8; // Only use lower 64 bits for trace IDs
const ID_BYTES = 16;

export interface IdGenerator {
  generateTraceId(): string;
  generateSpanId(): string;
  generateId(): string;
}

export class RandomIdGenerator implements IdGenerator {
  generateTraceId = getTraceIdGenerator();
  generateSpanId = getIdGenerator(SPAN_ID_BYTES);
  generateId = getIdGenerator(ID_BYTES);
}

const SHARED_CHAR_CODES_ARRAY = Array(32);
function getIdGenerator(bytes: number): () => string {
  return function generateId() {
    for (let i = 0; i < bytes * 2; i++) {
      SHARED_CHAR_CODES_ARRAY[i] = Math.floor(Math.random() * 16) + 48;

      if (SHARED_CHAR_CODES_ARRAY[i] >= 58) {
        SHARED_CHAR_CODES_ARRAY[i] += 39;
      }
    }
    return String.fromCharCode.apply(
      null,
      SHARED_CHAR_CODES_ARRAY.slice(0, bytes * 2)
    );
  };
}

const TRACE_ID_ZERO_PREFIX = '0000000000000000'; // 16 zeros for upper 64 bits
function getTraceIdGenerator(): () => string {
  return function generateTraceId() {
    for (let i = 0; i < TRACE_ID_LOWER_BYTES * 2; i++) {
      SHARED_CHAR_CODES_ARRAY[i] = Math.floor(Math.random() * 16) + 48;

      if (SHARED_CHAR_CODES_ARRAY[i] >= 58) {
        SHARED_CHAR_CODES_ARRAY[i] += 39;
      }
    }
    return (
      TRACE_ID_ZERO_PREFIX +
      String.fromCharCode.apply(
        null,
        SHARED_CHAR_CODES_ARRAY.slice(0, TRACE_ID_LOWER_BYTES * 2)
      )
    );
  };
}
