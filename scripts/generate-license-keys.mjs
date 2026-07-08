import { generateKeyPairSync } from "node:crypto";

function envValue(pem) {
  return JSON.stringify(pem.replace(/\n/g, "\\n"));
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
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
console.log("PRIVATE KEY - server/admin environment only");
console.log("Do not paste this into client code, public files, or desktop-only env.");
console.log("");
console.log(`BEZGROW_LICENSE_PRIVATE_KEY=${envValue(privateKey)}`);
console.log("");
console.log("PUBLIC KEY - app/client environment");
console.log("This key is safe to expose and is used by the app to verify licenses offline.");
console.log("");
console.log(`NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY=${envValue(publicKey)}`);
console.log("");
console.log("After setting these variables, restart the admin server and rebuild the desktop app.");
console.log("");
