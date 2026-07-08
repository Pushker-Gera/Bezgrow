import { generateKeyPairSync } from "node:crypto";

function envValue(pem) {
  return JSON.stringify(pem.replace(/\n/g, "\\n"));
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
});

console.log(`BEZGROW_LICENSE_PRIVATE_KEY=${envValue(privateKey)}`);
console.log(`NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY=${envValue(publicKey)}`);
