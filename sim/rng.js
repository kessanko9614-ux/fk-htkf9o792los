// sim/rng.js — 決定論的な擬似乱数（mulberry32）。Math.random は使わない。
// 前作 proto/sim.js の DV.mulberry32 / DV.hashSeedString と同じ方式。

export function hashSeedString(str) {
  str = String(str);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  return {
    s: seed >>> 0,
    next() {
      this.s = (this.s + 0x6d2b79f5) | 0;
      let t = this.s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    // [min, max)
    range(min, max) {
      return min + this.next() * (max - min);
    },
    int(min, maxExclusive) {
      return Math.floor(this.range(min, maxExclusive));
    },
    pick(arr) {
      return arr[this.int(0, arr.length)];
    },
  };
}

export function createRng(seed) {
  return mulberry32(hashSeedString(seed));
}

export function fnv1a(str) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
