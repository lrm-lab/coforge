const POLYNOMIAL_LOW = 0xd7870f42;
const POLYNOMIAL_HIGH = 0xc96c5795;

const TABLE_LOW = new Uint32Array(256);
const TABLE_HIGH = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let low = index;
  let high = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    const carry = low & 1;
    low = ((low >>> 1) | (high << 31)) >>> 0;
    high >>>= 1;
    if (carry) {
      low = (low ^ POLYNOMIAL_LOW) >>> 0;
      high = (high ^ POLYNOMIAL_HIGH) >>> 0;
    }
  }
  TABLE_LOW[index] = low;
  TABLE_HIGH[index] = high;
}

export interface Crc64 {
  update(bytes: Uint8Array): void;
  digest(): string;
}

export function createCrc64(): Crc64 {
  let low = 0xffffffff;
  let high = 0xffffffff;
  return {
    update(bytes: Uint8Array): void {
      for (let offset = 0; offset < bytes.length; offset += 1) {
        const index = (low ^ bytes[offset]!) & 0xff;
        low = (((low >>> 8) | (high << 24)) ^ TABLE_LOW[index]!) >>> 0;
        high = ((high >>> 8) ^ TABLE_HIGH[index]!) >>> 0;
      }
    },
    digest(): string {
      const finalLow = (low ^ 0xffffffff) >>> 0;
      const finalHigh = (high ^ 0xffffffff) >>> 0;
      return ((BigInt(finalHigh) << 32n) | BigInt(finalLow)).toString();
    },
  };
}

export function crc64Decimal(bytes: Uint8Array): string {
  const crc = createCrc64();
  crc.update(bytes);
  return crc.digest();
}
