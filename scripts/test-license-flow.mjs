import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, pbkdf2Sync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DEVICE_ID = "BZG-54842A525D2A47A5BEB2CBD7";
const APP_PASSWORD = "ReleaseSecure9";
const APP_SALT = Buffer.from("0123456789abcdef", "utf8");
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
  const outputText = output.outputText.replace(
    /from "zod";/g,
    `from "${import.meta.resolve("zod")}";`,
  )
    .replace(/from "@\/lib\/app-lock\/shared";/g, 'from "../app-lock/shared.mjs";')
    .replace(/from "@\/lib\/time\/canonical";/g, 'from "../time/canonical.mjs";');
  await writeFile(outputPath, outputText);
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
    platform: "windows",
    architecture: "x86_64",
    expiry_date: "2099-12-31",
    grace_period_days: 7,
    allowed_features: ["backup", "billing", "customers", "inventory", "orders", "products", "reports"],
    issued_by_admin: "admin@example.com",
    issued_at: "2026-07-09T00:00:00.000Z",
    app_lock: {
      version: 1,
      algorithm: "pbkdf2-sha256",
      iterations: 600000,
      salt: APP_SALT.toString("base64url"),
      verifier: pbkdf2Sync(`${DEVICE_ID}\u0000${APP_PASSWORD}`, APP_SALT, 600000, 32, "sha256").toString("base64url"),
      device_id: DEVICE_ID,
      credential_id: "credential-release-flow-0001",
      issued_at: "2026-07-09T00:00:00.000Z",
      reset_authorization: null,
    },
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
    await transpileSource("lib/time/canonical.ts");
    await transpileSource("lib/app-lock/shared.ts");
    const codec = await import(await transpileSource("lib/license/codec.ts"));
    const policy = await import(await transpileSource("lib/license/policy.ts"));
    const adminValidation = await import(await transpileSource("lib/license/admin-license-validation.ts"));
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
    assert.equal(generated.payload.platform, "windows");
    assert.equal(generated.payload.architecture, "x86_64");
    assert.equal(generated.payload.app_lock.verifier.includes(APP_PASSWORD), false, "The signed licence must never contain plaintext password material.");

    const activated = await activateLikeDesktop(generated.licenseKey);
    assert.equal(activated.parsed.payload.device_id, DEVICE_ID);
    assert.equal(activated.status.allowed, true);
    assert.equal(activated.status.status, "valid");

    const resetPayloadBase = basePayload();
    const resetPayload = {
      ...resetPayloadBase,
      app_lock: {
        ...resetPayloadBase.app_lock,
        credential_id: "credential-release-reset-0002",
        issued_at: "2026-08-26T18:45:00.000Z",
        reset_authorization: {
          id: "reset-authorization-release-0002",
          issued_at: "2026-08-26T18:45:00.000Z",
          expires_at: "2026-08-26T19:15:00.000Z",
        },
      },
    };
    const reversedResetPayload = Object.fromEntries(Object.entries(resetPayload).reverse());
    assert.equal(
      codec.canonicalLicenseText(reversedResetPayload),
      codec.canonicalLicenseText(resetPayload),
      "Signed reset canonicalization must not depend on insertion order.",
    );
    assert.doesNotMatch(
      codec.canonicalLicenseText({ ...resetPayload, future_optional_field: undefined }),
      /future_optional_field/,
      "Undefined signed fields must remain absent instead of becoming null.",
    );
    const signedReset = signPayload(resetPayload);
    const activatedReset = await activateLikeDesktop(signedReset.licenseKey);
    assert.deepEqual(
      activatedReset.parsed.payload.app_lock.reset_authorization,
      resetPayload.app_lock.reset_authorization,
      "Signing and verification must preserve the exact canonical reset timestamps and key presence.",
    );
    const tamperedResetParts = signedReset.licenseKey.split(".");
    const tamperedResetPayload = JSON.parse(new TextDecoder().decode(codec.base64UrlToBytes(tamperedResetParts[1])));
    tamperedResetPayload.app_lock.reset_authorization.expires_at = "2026-08-26T19:16:00.000Z";
    tamperedResetParts[1] = codec.bytesToBase64Url(new TextEncoder().encode(JSON.stringify(tamperedResetPayload)));
    await assert.rejects(
      () => activateLikeDesktop(tamperedResetParts.join(".")),
      /tampered/,
      "Changing a signed reset expiry must invalidate the Ed25519 signature.",
    );

    const offlineCached = policy.evaluateStoredLicense([activated.row], {
      deviceId: DEVICE_ID,
      now: new Date("2026-07-09T00:00:00.000Z"),
      connectivity: "offline",
    });
    assert.equal(offlineCached.allowed, true);
    assert.equal(offlineCached.status, "offline_valid_cached");

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

    const grace = signPayload(basePayload({ expiry_date: "2026-07-08", grace_period_days: 7 }));
    const graceActivation = await activateLikeDesktop(grace.licenseKey, DEVICE_ID, new Date("2026-07-09T00:00:00.000Z"));
    assert.equal(graceActivation.status.allowed, true);
    assert.equal(graceActivation.status.status, "grace_period");
    assert.match(graceActivation.status.reason, /grace period/i);

    const renewed = signPayload(basePayload({ expiry_date: "2100-12-31", issued_at: "2026-07-10T00:00:00.000Z" }));
    const renewedActivation = await activateLikeDesktop(renewed.licenseKey);
    assert.equal(renewedActivation.status.allowed, true);

    const expectedBlockedStatuses = {
      suspended: "cancelled",
      cancelled: "cancelled",
      revoked: "revoked",
      replaced: "invalid",
      invalid: "invalid",
      tampered: "tampered",
      device_mismatch: "device_mismatch",
    };
    for (const [blockedStatus, expectedStatus] of Object.entries(expectedBlockedStatuses)) {
      const blockedRow = { ...activated.row, status: blockedStatus };
      const blocked = policy.evaluateStoredLicense([blockedRow], {
        deviceId: DEVICE_ID,
        now: new Date("2026-07-09T00:00:00.000Z"),
      });
      assert.equal(blocked.allowed, false, `${blockedStatus} license must reject writes.`);
      assert.equal(blocked.status, expectedStatus, `${blockedStatus} must keep its explicit policy meaning.`);
    }

    const wrongClock = policy.evaluateStoredLicense([
      { ...activated.row, last_verified_at: "2026-07-09T12:00:01.000Z" },
    ], {
      deviceId: DEVICE_ID,
      now: new Date("2026-07-09T00:00:00.000Z"),
    });
    assert.equal(wrongClock.allowed, false);
    assert.equal(wrongClock.status, "clock_rollback");

    const missing = policy.evaluateStoredLicense([], { deviceId: DEVICE_ID });
    assert.equal(missing.allowed, false);
    assert.equal(missing.status, "not_activated");

    const malformedExpiry = policy.evaluateStoredLicense([
      { ...activated.row, expiry_date: "not-a-date", expires_at: "not-a-date" },
    ], { deviceId: DEVICE_ID });
    assert.equal(malformedExpiry.allowed, false);
    assert.equal(malformedExpiry.status, "tampered");

    const wrongDevicePolicy = policy.evaluateStoredLicense([activated.row], {
      deviceId: "BZG-SECOND-DEVICE-00000000",
      now: new Date("2026-07-09T00:00:00.000Z"),
    });
    assert.equal(wrongDevicePolicy.allowed, false, "The signed one-device limit must reject a second device.");
    assert.equal(wrongDevicePolicy.status, "device_mismatch");

    assert.equal(policy.isLicenseRestrictedCollection("products"), true);
    assert.equal(policy.isLicenseRestrictedCollection("customers"), true);
    assert.equal(policy.isLicenseRestrictedCollection("invoices"), true);
    assert.equal(activated.row.license_key, generated.licenseKey);

    const licenseFormBase = {
      customer_name: "Matrix Customer",
      customer_email: "matrix@example.com",
      customer_phone: "",
      customer_company: "",
      customer_country: "",
      business_name: "Matrix Business",
      workspace_id: "",
      device_id: DEVICE_ID,
      app_version: "",
      issue_date: "2026-07-28",
      grace_days: 7,
      allowed_features: ["billing", "customers", "inventory"],
      maximum_users: 1,
      maximum_businesses: 1,
      maximum_branches: 1,
      internal_notes: "",
      status: "active",
      app_password: APP_PASSWORD,
    };
    const durations = [
      ["monthly", "2026-08-28"],
      ["yearly", "2027-07-28"],
    ];
    let matrixCount = 0;

    for (const [duration, expiryDate] of durations) {
      for (const platform of ["windows", "macos"]) {
        for (const architecture of platform === "windows" ? ["x86_64", "arm64"] : ["x64", "arm64"]) {
          for (const planName of ["Starter", "Professional", "Enterprise"]) {
            const parsedForm = adminValidation.createLicenseSchema.safeParse({
              ...licenseFormBase,
              platform,
              architecture,
              plan_name: planName,
              expiry_date: expiryDate,
            });
            assert.equal(
              parsedForm.success,
              true,
              `${duration}/${platform}/${architecture}/${planName} must pass license validation.`,
            );
            assert.equal(parsedForm.data.workspace_id, undefined, "An empty optional Workspace ID must be omitted.");
            assert.equal(parsedForm.data.internal_notes, "", "Empty optional Internal notes must remain valid.");
            const signedArchitecture = platform === "windows" && parsedForm.data.architecture === "x64"
              ? "x86_64"
              : parsedForm.data.architecture;

            const signed = signPayload(basePayload({
              license_id: `lic_matrix_${matrixCount}`,
              platform,
              architecture: signedArchitecture,
              plan_name: planName,
              issue_date: parsedForm.data.issue_date,
              expiry_date: parsedForm.data.expiry_date,
              notes: parsedForm.data.internal_notes || null,
            }));
            const verified = await activateLikeDesktop(signed.licenseKey);
            assert.equal(verified.status.allowed, true);
            assert.equal(verified.parsed.payload.platform, platform);
            assert.equal(verified.parsed.payload.architecture, signedArchitecture);
            assert.equal(verified.parsed.payload.plan_name, planName);
            matrixCount += 1;
          }
        }
      }
    }
    assert.equal(matrixCount, 24, "The complete license duration/platform/architecture/plan matrix must run.");

    const invalidWorkspace = adminValidation.createLicenseSchema.safeParse({
      ...licenseFormBase,
      workspace_id: "ab",
      platform: "macos",
      architecture: "arm64",
      plan_name: "Starter",
      expiry_date: "2027-07-28",
    });
    assert.equal(invalidWorkspace.success, false);
    const invalidWorkspaceIssue = adminValidation.licenseValidationIssue(invalidWorkspace.error.issues[0]);
    assert.equal(invalidWorkspaceIssue.field, "workspace_id");
    assert.equal(invalidWorkspaceIssue.error, "Workspace ID: Enter at least 3 characters.");

    console.log(`license-flow-ok matrix=${matrixCount}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

await main();
