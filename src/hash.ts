export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function rotateLeft(lValue: number, iShiftBits: number): number {
  return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
}

function addUnsigned(lX: number, lY: number): number {
  const lX8 = lX & 0x80000000;
  const lY8 = lY & 0x80000000;
  const lX4 = lX & 0x40000000;
  const lY4 = lY & 0x40000000;
  const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
  if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
  if (lX4 | lY4) {
    if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
    return lResult ^ 0x40000000 ^ lX8 ^ lY8;
  }
  return lResult ^ lX8 ^ lY8;
}

function F(x: number, y: number, z: number): number {
  return (x & y) | (~x & z);
}
function G(x: number, y: number, z: number): number {
  return (x & z) | (y & ~z);
}
function H(x: number, y: number, z: number): number {
  return x ^ y ^ z;
}
function I(x: number, y: number, z: number): number {
  return y ^ (x | ~z);
}

function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
  return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)), s), b);
}
function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
  return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)), s), b);
}
function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
  return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)), s), b);
}
function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
  return addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)), s), b);
}

function convertToWordArray(string: string): number[] {
  const lMessageLength = string.length;
  const lNumberOfWords_temp1 = lMessageLength + 8;
  const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
  const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
  const lWordArray: number[] = new Array(lNumberOfWords).fill(0);
  let lBytePosition = 0;
  let lByteCount = 0;
  while (lByteCount < lMessageLength) {
    const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordCount] = (lWordArray[lWordCount] ?? 0) | (string.charCodeAt(lByteCount) << lBytePosition);
    lByteCount++;
  }
  const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
  lBytePosition = (lByteCount % 4) * 8;
  lWordArray[lWordCount] = (lWordArray[lWordCount] ?? 0) | (0x80 << lBytePosition);
  lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
  lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
  return lWordArray;
}

function wordToHex(lValue: number): string {
  let wordToHexValue = "";
  for (let lCount = 0; lCount <= 3; lCount++) {
    const lByte = (lValue >>> (lCount * 8)) & 255;
    const hex = lByte.toString(16).padStart(2, "0");
    wordToHexValue += hex;
  }
  return wordToHexValue;
}

function utf8Encode(string: string): string {
  const clean = string.replace(/\r\n/g, "\n");
  let utftext = "";
  for (let n = 0; n < clean.length; n++) {
    const c = clean.charCodeAt(n);
    if (c < 128) {
      utftext += String.fromCharCode(c);
    } else if (c > 127 && c < 2048) {
      utftext += String.fromCharCode((c >> 6) | 192);
      utftext += String.fromCharCode((c & 63) | 128);
    } else {
      utftext += String.fromCharCode((c >> 12) | 224);
      utftext += String.fromCharCode(((c >> 6) & 63) | 128);
      utftext += String.fromCharCode((c & 63) | 128);
    }
  }
  return utftext;
}

export function md5Hex(string: string): string {
  const x = convertToWordArray(utf8Encode(string));
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  for (let k = 0; k < x.length; k += 16) {
    const AA = a;
    const BB = b;
    const CC = c;
    const DD = d;

    const x0 = x[k + 0] ?? 0, x1 = x[k + 1] ?? 0, x2 = x[k + 2] ?? 0, x3 = x[k + 3] ?? 0;
    const x4 = x[k + 4] ?? 0, x5 = x[k + 5] ?? 0, x6 = x[k + 6] ?? 0, x7 = x[k + 7] ?? 0;
    const x8 = x[k + 8] ?? 0, x9 = x[k + 9] ?? 0, x10 = x[k + 10] ?? 0, x11 = x[k + 11] ?? 0;
    const x12 = x[k + 12] ?? 0, x13 = x[k + 13] ?? 0, x14 = x[k + 14] ?? 0, x15 = x[k + 15] ?? 0;

    a = FF(a, b, c, d, x0, S11, 0xd76aa478);
    d = FF(d, a, b, c, x1, S12, 0xe8c7b756);
    c = FF(c, d, a, b, x2, S13, 0x242070db);
    b = FF(b, c, d, a, x3, S14, 0xc1bdceee);
    a = FF(a, b, c, d, x4, S11, 0xf57c0faf);
    d = FF(d, a, b, c, x5, S12, 0x4787c62a);
    c = FF(c, d, a, b, x6, S13, 0xa8304613);
    b = FF(b, c, d, a, x7, S14, 0xfd469501);
    a = FF(a, b, c, d, x8, S11, 0x698098d8);
    d = FF(d, a, b, c, x9, S12, 0x8b44f7af);
    c = FF(c, d, a, b, x10, S13, 0xffff5bb1);
    b = FF(b, c, d, a, x11, S14, 0x895cd7be);
    a = FF(a, b, c, d, x12, S11, 0x6b901122);
    d = FF(d, a, b, c, x13, S12, 0xfd987193);
    c = FF(c, d, a, b, x14, S13, 0xa679438e);
    b = FF(b, c, d, a, x15, S14, 0x49b40821);

    a = GG(a, b, c, d, x1, S21, 0xf61e2562);
    d = GG(d, a, b, c, x6, S22, 0xc040b340);
    c = GG(c, d, a, b, x11, S23, 0x265e5a51);
    b = GG(b, c, d, a, x0, S24, 0xe9b6c7aa);
    a = GG(a, b, c, d, x5, S21, 0xd62f105d);
    d = GG(d, a, b, c, x10, S22, 0x2441453);
    c = GG(c, d, a, b, x15, S23, 0xd8a1e681);
    b = GG(b, c, d, a, x4, S24, 0xe7d3fbc8);
    a = GG(a, b, c, d, x9, S21, 0x21e1cde6);
    d = GG(d, a, b, c, x14, S22, 0xc33707d6);
    c = GG(c, d, a, b, x3, S23, 0xf4d50d87);
    b = GG(b, c, d, a, x8, S24, 0x455a14ed);
    a = GG(a, b, c, d, x13, S21, 0xa9e3e905);
    d = GG(d, a, b, c, x2, S22, 0xfcefa3f8);
    c = GG(c, d, a, b, x7, S23, 0x676f02d9);
    b = GG(b, c, d, a, x12, S24, 0x8d2a4c8a);

    a = HH(a, b, c, d, x5, S31, 0xfffa3942);
    d = HH(d, a, b, c, x8, S32, 0x8771f681);
    c = HH(c, d, a, b, x11, S33, 0x6d9d6122);
    b = HH(b, c, d, a, x14, S34, 0xfde5380c);
    a = HH(a, b, c, d, x1, S31, 0xa4beea44);
    d = HH(d, a, b, c, x4, S32, 0x4bdecfa9);
    c = HH(c, d, a, b, x7, S33, 0xf6bb4b60);
    b = HH(b, c, d, a, x10, S34, 0xbebfbc70);
    a = HH(a, b, c, d, x13, S31, 0x289b7ec6);
    d = HH(d, a, b, c, x0, S32, 0xeaa127fa);
    c = HH(c, d, a, b, x3, S33, 0xd4ef3085);
    b = HH(b, c, d, a, x6, S34, 0x4881d05);
    a = HH(a, b, c, d, x9, S31, 0xd9d4d039);
    d = HH(d, a, b, c, x12, S32, 0xe6db99e5);
    c = HH(c, d, a, b, x15, S33, 0x1fa27cf8);
    b = HH(b, c, d, a, x2, S34, 0xc4ac5665);

    a = II(a, b, c, d, x0, S41, 0xf4292244);
    d = II(d, a, b, c, x7, S42, 0x432aff97);
    c = II(c, d, a, b, x14, S43, 0xab9423a7);
    b = II(b, c, d, a, x5, S44, 0xfc93a039);
    a = II(a, b, c, d, x12, S41, 0x655b59c3);
    d = II(d, a, b, c, x3, S42, 0x8f0ccc92);
    c = II(c, d, a, b, x10, S43, 0xffeff47d);
    b = II(b, c, d, a, x1, S44, 0x85845dd1);
    a = II(a, b, c, d, x8, S41, 0x6fa87e4f);
    d = II(d, a, b, c, x15, S42, 0xfe2ce6e0);
    c = II(c, d, a, b, x6, S43, 0xa3014314);
    b = II(b, c, d, a, x13, S44, 0x4e0811a1);
    a = II(a, b, c, d, x4, S41, 0xf7537e82);
    d = II(d, a, b, c, x11, S42, 0xbd3af235);
    c = II(c, d, a, b, x2, S43, 0x2ad7d2bb);
    b = II(b, c, d, a, x9, S44, 0xeb86d391);

    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }

  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}
