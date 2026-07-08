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

console.log("");
console.log("Bezgrow offline license key pair");
console.log("================================");
console.log("");
console.log("Bezgrow now initializes license signing keys automatically on first admin launch.");
console.log("Use this script only for emergency/manual deployments or external key backup workflows.");
console.log("");
console.log("PRIVATE KEY - server/admin environment only");
console.log("Do not paste this into client code, public files, or desktop-only env.");
console.log("");
console.log(`BEZGROW_LICENSE_PRIVATE_KEY=${envValue(privateKey)}`);
console.log("");
console.log("PUBLIC KEY - app/client environment");
console.log("This key is safe to expose. New Bezgrow licenses also include issuer public key metadata automatically.");
console.log("");
console.log(`NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY=${envValue(publicKey)}`);
console.log("");
console.log("Normal production installs should use the auto-generated server keystore instead of manual env keys.");
console.log("");
