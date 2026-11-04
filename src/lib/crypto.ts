import type { DocPayload } from './types';

const AUTH_ITERATIONS = 210_000;
const ENC_ITERATIONS = 310_000;

// 加密密钥只存模块内存，刷新页面即丢弃，永不进 localStorage
let encKey: CryptoKey | null = null;

export function holdKey(key: CryptoKey) {
  encKey = key;
}

export function currentKey(): CryptoKey | null {
  return encKey;
}

export function dropKey() {
  encKey = null;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function pbkdf2Bits(password: string, saltHex: string, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

// 登录凭证：PBKDF2(password, authSalt) 的 base64。服务端只见到它（再哈希后存储），
// 且与加密密钥使用不同 salt，两者无法互推。
export async function deriveAuthHash(password: string, authSaltHex: string): Promise<string> {
  return toBase64(await pbkdf2Bits(password, authSaltHex, AUTH_ITERATIONS));
}

export async function deriveEncKey(password: string, encSaltHex: string): Promise<CryptoKey> {
  const raw = await pbkdf2Bits(password, encSaltHex, ENC_ITERATIONS);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptValue<T>(key: CryptoKey, value: T): Promise<{ cipher: string; nonce: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { cipher: toBase64(new Uint8Array(buf)), nonce: [...iv].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

export async function decryptValue<T>(key: CryptoKey, cipher: string, nonce: string): Promise<T> {
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(nonce) }, key, fromBase64(cipher));
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

// 文档载荷的加解密（encryptValue 的特化别名，保留调用点语义清晰）
export const encryptDoc = (key: CryptoKey, payload: DocPayload) => encryptValue(key, payload);
export const decryptDoc = (key: CryptoKey, cipher: string, nonce: string) => decryptValue<DocPayload>(key, cipher, nonce);
