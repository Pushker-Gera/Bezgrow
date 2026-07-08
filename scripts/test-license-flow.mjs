import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DEVICE_ID = "BZG-54842A525D2A47A5BEB2CBD7";
const outDir = await mkdtemp(join(tmpdir(), "bezgrow-license-flow-"));

async function transpileSource(relativePath) {
  const sourcePath = resolve(process.cwd(), relativePath);
  const outputPath = join(outDir, relativePath.replace(/\.ts$/, ".mjs"));
  const source = await readFile(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: false,
    },
    fileName: sourcePath,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output.outputText);
  return pathToFileURL(outputPath).href;
}

function generateRawKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    privateKeyRaw: privateJwk.d,
    publicKeyRaw: publicJwk.x,
    keyId: "ed25519_test",
  };
}

function privateKeyObject(keys) {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: keys.publicKeyRaw,
      d: keys.privateKeyRaw,
    },
    format: "jwk",
  });
}

function basePayload(overrides = {}) {
  return {
    schema_version: 1,
    license_id: `lic_${Math.random().toString(36).slice(2)}`,
    customer_id: "cust_release",
    customer_name: "Release Customer",
    customer_email: "release@example.com",
    business_id: "biz_release",
    business_name: "Release Business",
    device_id: DEVICE_ID,
    plan_name: "Offline ERP",
    expiry_date: "2099-12-31",
    grace_period_days: 7,
    allowed_features: ["backup", "billing", "customers", "inventory", "orders", "products", "reports"],
    issued_by_admin: "admin@example.com",
    issued_at: "2026-07-09T00:00:00.000Z",
    notes: null,
    ...overrides,
  };
}

function rowFromPayload(payload, licenseKey, signatureText) {
  const expiry = new Date(`${payload.expiry_date}T23:59:59.999`);
  expiry.setDate(expiry.getDate() + payload.grace_period_days);
  return {
    id: payload.license_id,
    license_key: licenseKey,
    status: "active",
    device_id: payload.device_id,
    expiry_date: payload.expiry_date,
    grace_period_days: payload.grace_period_days,
    grace_until: expiry.toISOString(),
    last_verified_at: "2026-07-09T00:00:00.000Z",
    allowed_features: JSON.stringify(payload.allowed_features),
    issued_at: payload.issued_at,
    signature: signatureText,
  };
}

async function main() {
  try {
    const codec = await import(await transpileSource("lib/license/codec.ts"));
    const policy = await import(await transpileSource("lib/license/policy.ts"));
    const keys = generateRawKeys();

    function signPayload(payload) {
      const signedPayload = {
        ...payload,
        allowed_features: [...payload.allowed_features].sort(),
        signature_algorithm: "ed25519",
        issuer_key_id: keys.keyId,
      };
      const payloadText = codec.canonicalLicenseText(signedPayload);
      const signature = sign(null, new TextEncoder().encode(payloadText), privateKeyObject(keys));
      return {
        payload: signedPayload,
        licenseKey: codec.encodeLicenseKey(signedPayload, signature),
        signatureText: signature.toString("base64url"),
      };
    }

    async function activateLikeDesktop(input, deviceId = DEVICE_ID, now = new Date("2026-07-09T00:00:00.000Z")) {
      const parsed = codec.parseLicenseInput(input);
      if (parsed.payload.device_id !== deviceId) throw new Error("wrong_device");

      const verified = await codec.verifyLicenseSignature(parsed, keys.publicKeyRaw);
      if (!verified) throw new Error("tampered");

      const graceEnd = new Date(`${parsed.payload.expiry_date}T23:59:59.999`);
      graceEnd.setDate(graceEnd.getDate() + parsed.payload.grace_period_days);
      if (now.getTime() > graceEnd.getTime()) throw new Error("expired");

      const row = rowFromPayload(parsed.payload, parsed.licenseKey, parsed.signatureText);
      const status = policy.evaluateStoredLicense([row], { deviceId, now });
      if (!status.allowed) throw new Error(status.status);
      return { parsed, row, status };
    }

    const generated = signPayload(basePayload());
    assert.match(generated.licenseKey, /^BZG-LIC-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(generated.payload.device_id, DEVICE_ID);

    const activated = await activateLikeDesktop(generated.licenseKey);
    assert.equal(activated.parsed.payload.device_id, DEVICE_ID);
    assert.equal(activated.status.allowed, true);

    const lineBroken = generated.licenseKey.replace(/(.{24})/g, "$1\n  ");
    const activatedFromPasted = await activateLikeDesktop(lineBroken);
    assert.equal(activatedFromPasted.parsed.licenseKey, generated.licenseKey);

    await assert.rejects(() => activateLikeDesktop(generated.licenseKey, "BZG-WRONGDEVICE000000000000"), /wrong_device/);

    const parts = generated.licenseKey.split(".");
    const decodedPayload = JSON.parse(new TextDecoder().decode(codec.base64UrlToBytes(parts[1])));
    decodedPayload.business_name = "Tampered Business";
    parts[1] = codec.bytesToBase64Url(new TextEncoder().encode(JSON.stringify(decodedPayload)));
    await assert.rejects(() => activateLikeDesktop(parts.join(".")), /tampered/);

    const expired = signPayload(basePayload({ expiry_date: "2020-01-01", grace_period_days: 0 }));
    await assert.rejects(() => activateLikeDesktop(expired.licenseKey), /expired/);

    assert.equal(policy.isLicenseRestrictedCollection("products"), true);
    assert.equal(policy.isLicenseRestrictedCollection("customers"), true);
    assert.equal(policy.isLicenseRestrictedCollection("invoices"), true);
    assert.equal(activated.row.license_key, generated.licenseKey);

    console.log("license-flow-ok");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

await main();
