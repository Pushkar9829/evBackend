// Small PKI for OCPP Security Profile 3 and ISO 15118 contract certificates.
//   CSMS root CA      signs charging-station client certificates (SignCertificate -> CertificateSigned)
//                     and the server certificate of the optional mutual-TLS listener.
//   MO sub-CA         signs Plug & Charge contract certificates for our drivers (we are the eMSP / MO).
// Keys come from env (PKI_CA_CERT / PKI_CA_KEY as PEM or base64) or are generated once and stored.
// In production the V2G root and MO certificates come from the Hubject / CCP PKI — see docs.
import crypto from 'node:crypto';
import forge from 'node-forge';
import mongoose from 'mongoose';
import { PlatformSettings } from '../models/index.js';
import { badRequest } from '../lib/errors.js';
import { invalidateSettings } from './settings.js';

const { pki, md } = forge;

const CertSchema = new mongoose.Schema(
  {
    charger: { type: mongoose.Types.ObjectId, ref: 'Charger', index: true },
    user: { type: mongoose.Types.ObjectId, ref: 'User', index: true },
    kind: { type: String, enum: ['ChargingStationCertificate', 'V2GCertificate', 'ContractCertificate'], required: true },
    subject: String,
    emaid: { type: String, index: true },
    serial: { type: String, unique: true },
    issuerNameHash: String,
    issuerKeyHash: String,
    pem: String,
    notBefore: Date,
    notAfter: Date,
    revokedAt: Date,
    sha256: String,
  },
  { timestamps: true },
);
export const IssuedCertificate = mongoose.models.IssuedCertificate || mongoose.model('IssuedCertificate', CertSchema);

const decode = (v) => (v && !v.includes('-----BEGIN') ? Buffer.from(v, 'base64').toString() : v);
// 16-byte positive serial: even-length hex with a leading 0x01..0x7f byte (DER INTEGER must not look negative)
const randSerial = () => `${(1 + crypto.randomInt(126)).toString(16).padStart(2, '0')}${crypto.randomBytes(15).toString('hex')}`;

function makeCa(cn, issuer) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400_000);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'ChargeX' }, { name: 'countryName', value: 'IN' }];
  cert.setSubject(attrs);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true, pathLenConstraint: issuer ? 0 : 1, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }, { name: 'subjectKeyIdentifier' }]);
  cert.sign(issuer ? issuer.key : keys.privateKey, md.sha256.create());
  return { cert, key: keys.privateKey };
}

let cache = null;

/** Load (or create once) the CSMS root CA and the MO sub-CA. */
export async function getCas() {
  if (cache) return cache;
  if (process.env.PKI_CA_CERT && process.env.PKI_CA_KEY) {
    const root = { cert: pki.certificateFromPem(decode(process.env.PKI_CA_CERT)), key: pki.privateKeyFromPem(decode(process.env.PKI_CA_KEY)) };
    cache = { root, mo: root };
    return cache;
  }
  const s = await PlatformSettings.findOne({ key: 'platform' }).lean();
  if (s?.pki?.rootCert) {
    cache = {
      root: { cert: pki.certificateFromPem(s.pki.rootCert), key: pki.privateKeyFromPem(s.pki.rootKey) },
      mo: { cert: pki.certificateFromPem(s.pki.moCert), key: pki.privateKeyFromPem(s.pki.moKey) },
    };
    return cache;
  }
  const root = makeCa('ChargeX CSMS Root CA');
  const mo = makeCa('ChargeX MO Sub-CA (test)', root);
  await PlatformSettings.updateOne(
    { key: 'platform' },
    { $set: { pki: { rootCert: pki.certificateToPem(root.cert), rootKey: pki.privateKeyToPem(root.key), moCert: pki.certificateToPem(mo.cert), moKey: pki.privateKeyToPem(mo.key) } } },
    { upsert: true },
  );
  invalidateSettings();
  cache = { root, mo };
  return cache;
}

export const resetPkiCache = () => {
  cache = null;
};

export async function rootCaPem() {
  return pki.certificateToPem((await getCas()).root.cert);
}

/** OCPP CertificateHashData of a certificate as issued by `issuer` (issuerNameHash, issuerKeyHash, serialNumber). */
export function hashData(cert, issuerCert) {
  const nameDer = forge.asn1.toDer(pki.distinguishedNameToAsn1(issuerCert.subject)).getBytes();
  const keyDer = forge.asn1.toDer(pki.publicKeyToAsn1(issuerCert.publicKey)).getBytes();
  // issuerKeyHash = hash of the BIT STRING value of the issuer public key (subjectPublicKey)
  const spki = forge.asn1.fromDer(keyDer);
  const bitString = spki.value[1].value.slice(1);
  return {
    hashAlgorithm: 'SHA256',
    issuerNameHash: md.sha256.create().update(nameDer).digest().toHex(),
    issuerKeyHash: md.sha256.create().update(bitString).digest().toHex(),
    serialNumber: cert.serialNumber.replace(/^0+/, '') || '0',
  };
}

function issue({ subjectAttrs, publicKey, issuer, days, extensions }) {
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = randSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86400_000);
  cert.setSubject(subjectAttrs);
  cert.setIssuer(issuer.cert.subject.attributes);
  cert.setExtensions(extensions);
  cert.sign(issuer.key, md.sha256.create());
  return cert;
}

/**
 * Sign a charging station CSR (OCPP 2.0.1 A02/A03). The subject CN must be the charger's identity
 * so a certificate can never be used to impersonate another charger.
 */
export async function signStationCsr(charger, csrPem, kind = 'ChargingStationCertificate') {
  let csr;
  try {
    csr = pki.certificationRequestFromPem(csrPem);
  } catch {
    throw badRequest('BAD_CSR', 'CSR is not valid PEM');
  }
  if (!csr.verify()) throw badRequest('BAD_CSR', 'CSR signature does not verify');
  const cn = csr.subject.getField('CN')?.value;
  if (cn !== charger.ocppId) throw badRequest('CSR_CN_MISMATCH', `CSR common name "${cn}" must equal the charger id "${charger.ocppId}"`);
  const { root } = await getCas();
  const cert = issue({
    subjectAttrs: csr.subject.attributes,
    publicKey: csr.publicKey,
    issuer: root,
    days: 365,
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true }, { name: 'extKeyUsage', clientAuth: true, serverAuth: kind === 'V2GCertificate' }],
  });
  const pem = pki.certificateToPem(cert);
  const h = hashData(cert, root.cert);
  await IssuedCertificate.create({ charger: charger._id, kind, subject: cn, serial: h.serialNumber, issuerNameHash: h.issuerNameHash, issuerKeyHash: h.issuerKeyHash, pem, notBefore: cert.validity.notBefore, notAfter: cert.validity.notAfter, sha256: fingerprint(pem) });
  return { pem, chain: pem + pki.certificateToPem(root.cert), hash: h, notAfter: cert.validity.notAfter };
}

/** Server certificate for the mutual-TLS listener (self-hosted Security Profile 3). */
export async function serverCredentials(hostnames = ['localhost']) {
  const { root } = await getCas();
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = issue({
    subjectAttrs: [{ name: 'commonName', value: hostnames[0] }, { name: 'organizationName', value: 'ChargeX' }],
    publicKey: keys.publicKey,
    issuer: root,
    days: 397,
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: hostnames.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h })) }],
  });
  return { cert: pki.certificateToPem(cert), key: pki.privateKeyToPem(keys.privateKey), ca: pki.certificateToPem(root.cert) };
}

/**
 * ISO 15118 contract certificate for a driver's vehicle (test MO PKI). EMAID format: IN-CHX-C<8>-<check>.
 * Returns the certificate + private key so the EV / OEM backend can be provisioned.
 */
export async function issueContractCertificate(user) {
  const { mo } = await getCas();
  const emaid = `IN-CHX-C${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = issue({ subjectAttrs: [{ name: 'commonName', value: emaid.replace(/-/g, '') }, { name: 'organizationName', value: 'ChargeX eMSP' }, { name: 'countryName', value: 'IN' }], publicKey: keys.publicKey, issuer: mo, days: 730, extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true }] });
  const pem = pki.certificateToPem(cert);
  const h = hashData(cert, mo.cert);
  await IssuedCertificate.create({ user: user._id, kind: 'ContractCertificate', emaid, subject: emaid, serial: h.serialNumber, issuerNameHash: h.issuerNameHash, issuerKeyHash: h.issuerKeyHash, pem, notBefore: cert.validity.notBefore, notAfter: cert.validity.notAfter, sha256: fingerprint(pem) });
  return { emaid, pem, key: pki.privateKeyToPem(keys.privateKey), hash: h, chain: pem + pki.certificateToPem(mo.cert) + pki.certificateToPem((await getCas()).root.cert) };
}

/** Validate OCPP iso15118CertificateHashData against certificates we issued (Authorize with PnC). */
export async function checkContractHash(emaid, hashes = []) {
  const certs = await IssuedCertificate.find({ kind: 'ContractCertificate', emaid }).lean();
  if (!certs.length) return 'NoCertificateAvailable';
  const live = certs.filter((c) => !c.revokedAt && c.notAfter > new Date());
  if (!live.length) return certs.some((c) => c.revokedAt) ? 'CertificateRevoked' : 'CertificateExpired';
  if (!hashes.length) return 'Accepted';
  const ok = hashes.some((h) => live.some((c) => c.serial === String(h.serialNumber).replace(/^0+/, '') && c.issuerNameHash === String(h.issuerNameHash).toLowerCase() && c.issuerKeyHash === String(h.issuerKeyHash).toLowerCase()));
  return ok ? 'Accepted' : 'CertChainError';
}

export const fingerprint = (pem) => crypto.createHash('sha256').update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex');

/** CN of a peer certificate presented on the TLS socket (Security Profile 3). */
export function peerIdentity(socket) {
  const c = socket.getPeerCertificate?.();
  if (!c || !c.subject) return null;
  return { cn: c.subject.CN, authorized: socket.authorized, fingerprint: c.fingerprint256?.replace(/:/g, '').toLowerCase() };
}
