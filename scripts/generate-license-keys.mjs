import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = publicKey.export({ format: "jwk" });

if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || !privateJwk.d || publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519" || !publicJwk.x) {
  throw new Error("Failed to generate raw Ed25519 license keys.");
}

console.log(`BEZGROW_LICENSE_PRIVATE_KEY=${privateJwk.d}`);
console.log(`NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY=${publicJwk.x}`);
