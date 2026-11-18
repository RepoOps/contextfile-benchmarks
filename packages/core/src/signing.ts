// Report signing: the guarantee you can check without trusting us (Report
// Invariant 4). Reports are signed; the public key is published at
// /.well-known/report-keys so anyone verifies offline. Reports name their key id.
//
// Algorithm: Ed25519 (RFC 8032, PureEdDSA over the message bytes) via Node crypto,
// decision D6 of the PromptReports integration plan. Verifiable with public tooling,
// no ContextFile dependency.
//
// Keys: ContextFile has no cloud KMS. Each private key is an Ed25519 PKCS8 PEM in a
// sealed environment variable, one key per purpose (reports, AISoT records, Rooms
// statements, receipts, receipt tree heads, trust snapshots, the A2A Agent Card, claim
// credentials, C2PA manifests), read only through the Signer interface so a KMS signer can
// replace it later. An ephemeral key generated here is named "dev-..." so nothing
// pretends to be production-signed; a stable key loaded from env is "pem-...".

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export interface Signature {
  keyId: string;
  alg: "Ed25519";
  value: string; // base64
}

export interface Signer {
  keyId: string;
  publicKeyPem(): string;
  sign(message: string): Signature;
}

export class SigningKeyError extends Error {
  constructor(message: string) {
    super(`[contextfile] ${message}`);
    this.name = "SigningKeyError";
  }
}

/** Load an Ed25519 private key from PKCS8 PEM; any other key type is refused. */
export function ed25519PrivateKeyFromPem(pem: string, setting: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SigningKeyError(`${setting} is not a readable PKCS8 PEM private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new SigningKeyError(`${setting} must be an Ed25519 key (found ${key.asymmetricKeyType ?? "unknown"}); generate one with: openssl genpkey -algorithm ed25519`);
  }
  return key;
}

/** The 32 raw public key bytes, base64url: the `public_key` of the shared key set shape. */
export function ed25519PublicKeyRaw(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return pub.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
}

/** An Ed25519 public key from PEM (SPKI) or 32 raw bytes in base64url. */
export function ed25519PublicKey(input: string): KeyObject {
  const s = input.trim();
  if (s.startsWith("-----BEGIN")) return createPublicKey(s);
  const raw = Buffer.from(s, "base64url");
  if (raw.length !== 32) throw new SigningKeyError("an Ed25519 public key is 32 bytes");
  // SPKI prefix for Ed25519 (RFC 8410), then the 32 key bytes.
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** The key id for a stable env key: "pem-" plus 16 hex of the SPKI hash. */
export function keyIdForPublicKey(publicKey: KeyObject): string {
  return keyIdFor(publicKey, "pem");
}

function keyIdFor(publicKey: KeyObject, prefix: string): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return `${prefix}-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

/** The env-var signer. Loads REPORT_SIGNING_KEY_PEM (or the PEM passed in) when
 *  present, so the key id is stable across restarts; otherwise generates an
 *  ephemeral dev key and warns. */
export class LocalDevSigner implements Signer {
  private priv: KeyObject;
  private pub: KeyObject;
  keyId: string;

  constructor(pem?: string, setting = "REPORT_SIGNING_KEY_PEM") {
    if (pem) {
      this.priv = ed25519PrivateKeyFromPem(pem, setting);
    } else {
      this.priv = generateKeyPairSync("ed25519").privateKey;
      // eslint-disable-next-line no-console
      console.warn(`[contextfile] LocalDevSigner: no ${setting}, using an ephemeral dev key. Not for production.`);
    }
    this.pub = createPublicKey(this.priv);
    // A stable key loaded from env is published and can be checked by anyone, so it
    // is named "pem-..."; only an ephemeral key generated here is "dev-...". The
    // registry publisher refuses "dev-" keys, never "pem-" ones.
    this.keyId = keyIdFor(this.pub, pem ? "pem" : "dev");
  }

  publicKeyPem(): string {
    return this.pub.export({ type: "spki", format: "pem" }).toString();
  }

  /** The 32 raw public key bytes, base64url. */
  publicKeyRaw(): string {
    return ed25519PublicKeyRaw(this.pub);
  }

  sign(message: string): Signature {
    const value = cryptoSign(null, Buffer.from(message), this.priv).toString("base64");
    return { keyId: this.keyId, alg: "Ed25519", value };
  }
}

/** Verify a signature against a published public key (PEM, or the key set's raw
 *  base64url `public_key`): the client-side check the registry's "verify signature"
 *  button runs. Pure, no platform trust. */
export function verifySignature(message: string, sig: Signature, publicKey: string): boolean {
  try {
    if (sig.alg !== "Ed25519") return false;
    const pub = ed25519PublicKey(publicKey);
    if (pub.asymmetricKeyType !== "ed25519") return false;
    return cryptoVerify(null, Buffer.from(message), pub, Buffer.from(sig.value, "base64"));
  } catch {
    return false;
  }
}

/** Choose the report signer for this environment: the stable env key when set,
 *  otherwise an ephemeral dev key. GCP_KMS_KEY is refused rather than ignored, so a
 *  deploy that expects KMS never signs with a local key in its place. */
export function buildSigner(env: Record<string, string | undefined> = process.env): Signer {
  if (env.GCP_KMS_KEY) {
    throw new SigningKeyError(
      "GCP_KMS_KEY is set but ContextFile has no KMS signer; report keys are Ed25519 PEMs in REPORT_SIGNING_KEY_PEM. Remove GCP_KMS_KEY."
    );
  }
  return new LocalDevSigner(env.REPORT_SIGNING_KEY_PEM);
}

export class ReportKeyUnavailableError extends Error {
  constructor(message: string) {
    super(`[contextfile] ${message}`);
    this.name = "ReportKeyUnavailableError";
  }
}

/** One entry of the shared key set shape (promptcompute docs/receipts.md). */
export interface PublishedKey {
  key_id: string;
  alg: "Ed25519";
  /** 32 raw public key bytes, base64url. */
  public_key: string;
  valid_from: string;
  valid_to: string | null;
  /** "retired" once the key was rotated out (its `valid_to` is the retirement date);
   *  a retired key stays listed so what it signed before rotation still verifies. */
  status: "active" | "retired";
  /** SPKI PEM of the same key. Kept for one release for readers of the old shape. */
  pem: string;
}

/** Start of the validity window when none is configured: no lower bound. */
const NO_LOWER_BOUND = new Date(0).toISOString();

function isoOrThrow(v: string, setting: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ReportKeyUnavailableError(`${setting} holds a time that does not parse: ${v}`);
  return d.toISOString();
}

function publishedKey(pub: KeyObject, validFrom: string, validTo: string | null): PublishedKey {
  return {
    key_id: keyIdFor(pub, "pem"),
    alg: "Ed25519",
    public_key: ed25519PublicKeyRaw(pub),
    valid_from: validFrom,
    valid_to: validTo,
    status: validTo === null ? "active" : "retired",
    pem: pub.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * A key set for one signing purpose, read from env: `<keyVar>` (the current private
 * key), `<keyVar minus _PEM>_VALID_FROM` (optional, ISO time) and
 * `<keyVar minus _PEM>_RETIRED` (optional JSON array of
 * `{ public_key, valid_from, valid_to }`, public_key as PEM or raw base64url), so a
 * rotated key stays listed and older signatures still verify. Fails closed when no
 * stable key is set: an ephemeral dev key changes every process start, and
 * publishing it would let a checker "verify" against a key nothing was signed with.
 */
export function publishedKeySet(keyVar: string, env: Record<string, string | undefined> = process.env): { keys: PublishedKey[] } {
  const base = keyVar.replace(/_PEM$/, "");
  const pem = env[keyVar];
  if (!pem) throw new ReportKeyUnavailableError(`${keyVar} is not set; no stable signing key to publish`);
  const current = createPublicKey(ed25519PrivateKeyFromPem(pem, keyVar));
  const validFromVar = `${base}_VALID_FROM`;
  const validFrom = env[validFromVar] ? isoOrThrow(env[validFromVar]!, validFromVar) : NO_LOWER_BOUND;
  const keys = [publishedKey(current, validFrom, null)];
  const retiredVar = `${base}_RETIRED`;
  const retiredRaw = env[retiredVar];
  if (retiredRaw) {
    let list: unknown;
    try {
      list = JSON.parse(retiredRaw);
    } catch {
      throw new ReportKeyUnavailableError(`${retiredVar} is not JSON`);
    }
    if (!Array.isArray(list)) throw new ReportKeyUnavailableError(`${retiredVar} must be a JSON array`);
    for (const item of list as { public_key?: unknown; valid_from?: unknown; valid_to?: unknown }[]) {
      if (typeof item?.public_key !== "string" || typeof item.valid_to !== "string") {
        throw new ReportKeyUnavailableError(`${retiredVar}: every retired key needs public_key and valid_to`);
      }
      let pub: KeyObject;
      try {
        pub = ed25519PublicKey(item.public_key);
      } catch {
        throw new ReportKeyUnavailableError(`${retiredVar}: a public_key is not an Ed25519 key`);
      }
      if (pub.asymmetricKeyType !== "ed25519") throw new ReportKeyUnavailableError(`${retiredVar}: a public_key is not an Ed25519 key`);
      const from = typeof item.valid_from === "string" ? isoOrThrow(item.valid_from, retiredVar) : NO_LOWER_BOUND;
      const entry = publishedKey(pub, from, isoOrThrow(item.valid_to, retiredVar));
      if (!keys.some((k) => k.public_key === entry.public_key)) keys.push(entry);
    }
  }
  return { keys };
}

/** The report key set served at /.well-known/report-keys. */
export function publishedReportKeys(env: Record<string, string | undefined> = process.env): { keys: PublishedKey[] } {
  if (env.GCP_KMS_KEY) throw new ReportKeyUnavailableError("GCP_KMS_KEY is set but ContextFile has no KMS signer, so no key is published");
  return publishedKeySet("REPORT_SIGNING_KEY_PEM", env);
}

/** The key-set entry a signature was made with, and whether it verifies. Picks the
 *  entry by key id, so a report signed by a retired key verifies against that entry
 *  and the caller can show the key as retired. Pure, no platform trust. */
export function verifyWithKeySet(
  message: string,
  sig: Signature,
  keySet: { keys: (Pick<PublishedKey, "key_id" | "public_key" | "valid_to"> & { status?: PublishedKey["status"] })[] },
): { signatureValid: boolean; key: { key_id: string; status: PublishedKey["status"]; valid_to: string | null } | null } {
  const entry = keySet.keys.find((k) => k.key_id === sig.keyId);
  if (!entry) return { signatureValid: false, key: null };
  const status = entry.status ?? (entry.valid_to === null ? "active" : "retired");
  return { signatureValid: verifySignature(message, sig, entry.public_key), key: { key_id: entry.key_id, status, valid_to: entry.valid_to } };
}

/** The private-key settings that must each hold a different key (decision D6: one
 *  key per purpose, so one leaked key cannot sign for another purpose). */
export const SIGNING_KEY_SETTINGS = [
  "REPORT_SIGNING_KEY_PEM",
  "AISOT_REGISTRY_PRIVATE_KEY_PEM",
  "ROOMS_SIGNING_KEY_PEM",
  "RECEIPT_SIGNING_KEY_PEM",
  "RECEIPT_ANCHOR_SIGNING_KEY_PEM",
  "TRUST_SNAPSHOT_SIGNING_KEY_PEM",
  "AGENT_CARD_SIGNING_KEY_PEM",
  // R16: claim credentials and status lists (did:web), and C2PA manifests (its X.509
  // certificate chain is C2PA_SIGNING_CERT_CHAIN_PEM).
  "VC_SIGNING_KEY_PEM",
  "C2PA_SIGNING_KEY_PEM",
] as const;

/** Refuse to start when two signing settings hold the same key. Compares public
 *  keys, so the same key in two PEM spellings is still caught. Names both settings. */
export function assertDistinctSigningKeys(
  env: Record<string, string | undefined> = process.env,
  settings: readonly string[] = SIGNING_KEY_SETTINGS,
): void {
  const seen = new Map<string, string>();
  for (const setting of settings) {
    const pem = env[setting];
    if (!pem) continue;
    let fingerprint: string;
    try {
      const der = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
      fingerprint = createHash("sha256").update(der).digest("hex");
    } catch {
      throw new SigningKeyError(`${setting} is not a readable PKCS8 PEM private key`);
    }
    const other = seen.get(fingerprint);
    if (other) throw new SigningKeyError(`${other} and ${setting} hold the same key; each purpose needs its own key`);
    seen.set(fingerprint, setting);
  }
}
