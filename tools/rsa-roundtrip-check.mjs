/*  Proves the activation keypair works the way the plug-in will read it.

    juce::RSAKey::applyToValue computes value^part1 mod part2, and a key is stored as
    "part1,part2" in hex. If the server signs with (d, n) and the plug-in recovers with
    (e, n), the digest must come back byte-identical -- and a tampered token must not.

    Worth having as a file rather than a one-off: regenerating the keypair, or anyone
    touching the token format, should be able to re-run this before shipping a build
    that would otherwise reject every customer's activation.

    Usage:  node tools/rsa-roundtrip-check.mjs
*/

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pub = readFileSync(join(root, "cmake/activation-public-key.txt"), "utf8").trim();
const priv = readFileSync(join(root, "cmake/activation-private-key.SECRET.txt"), "utf8").trim();

const parse = (s) => {
  const [a, b] = s.split(",");
  return { exp: BigInt("0x" + a), mod: BigInt("0x" + b) };
};

const PUB = parse(pub);
const PRIV = parse(priv);

/** Exactly juce::RSAKey::applyToValue -- value^part1 mod part2. */
const applyToValue = (value, key) => {
  let result = 1n;
  let base = value % key.mod;
  let exp = key.exp;

  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % key.mod;
    base = (base * base) % key.mod;
    exp >>= 1n;
  }

  return result;
};

const token = '{"key":"K2P9-19Z0-QNCZ-N6HE","machine":"abc123","exp":0}';
const digest = BigInt("0x" + createHash("sha256").update(token).digest("hex"));

const signature = applyToValue(digest, PRIV);
const recovered = applyToValue(signature, PUB);

const tampered = BigInt("0x" + createHash("sha256").update(token + "x").digest("hex"));

console.log("modulus bits   :", PUB.mod.toString(2).length);
console.log("shared modulus :", PUB.mod === PRIV.mod);
console.log("round trip     :", recovered === digest ? "OK" : "FAILED");
console.log("forgery        :", recovered === tampered ? "FAILED - accepted" : "correctly rejected");

if (recovered !== digest) process.exit(1);
