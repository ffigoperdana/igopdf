import argon2 from 'argon2';

const hashingOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  saltLength: 16,
  hashLength: 32,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, hashingOptions);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function generateRandomPassword(length: number = 16): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    password += charset[array[i] % charset.length];
  }
  return password;
}
