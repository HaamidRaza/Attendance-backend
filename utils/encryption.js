const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.AADHAR_ENCRYPTION_KEY || "", "hex");

function assertKey() {
  if (KEY.length !== 32) {
    throw new Error(
      "AADHAR_ENCRYPTION_KEY must be set as a 64-character hex string (32 bytes) in your environment.",
    );
  }
}

// Encrypts a plaintext Aadhar number for storage. Each call uses a fresh
// random IV, so encrypting the same number twice produces different
// ciphertext — this is correct and expected for AES-GCM.
function encrypt(plainText) {
  assertKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

function decrypt(payload) {
  assertKey();
  const [ivHex, tagHex, dataHex] = (payload || "").split(":");
  if (!ivHex || !tagHex || !dataHex)
    throw new Error("Invalid encrypted payload");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// A separate, deterministic (unsalted) hash of the plaintext number, used
// ONLY to detect duplicate Aadhar numbers across students. This is not
// reversible and is never used to display the number — it exists purely
// so two different students can't be registered with the same Aadhar,
// which the encrypted field alone can't check (its ciphertext is
// different every time by design).
function hashAadhar(plainText) {
  return crypto.createHash("sha256").update(plainText).digest("hex");
}

function maskAadhar(plainText) {
  if (!plainText || plainText.length < 4) return "XXXX XXXX XXXX";
  return `XXXX XXXX ${plainText.slice(-4)}`;
}

module.exports = { encrypt, decrypt, hashAadhar, maskAadhar };
