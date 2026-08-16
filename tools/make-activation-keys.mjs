/*  Generates the activation signing keypair.

    The plug-in verifies activation tokens with juce::RSAKey, which stores a key as two
    comma-separated hex numbers -- "exponent,modulus" -- and whose applyToValue computes
    value^exponent mod modulus. So both halves are emitted in exactly that format:

        public   e,n   compiled into the plug-in. Public by definition; extracting it
                       from the binary gains an attacker nothing.
        private  d,n   lives only in Supabase's secret store, where the activation
                       function signs with it. It never touches this repository.

    Run once:  node tools/make-activation-keys.mjs

    Why not just use juce::RSAKey::createKeyPair? Because that needs a compiled C++ tool
    to run, and the maths is identical -- an RSA keypair is an RSA keypair. Node's crypto
    generates one properly and this reformats the parts the way JUCE reads them.

    Note on the scheme: this is textbook RSA over a SHA-256 digest, with no PKCS#1
    padding, because that is the only thing juce::RSAKey can verify. It is what the JUCE
    ecosystem has used for licence tokens for over a decade and is sound against forging
    one; it is not what you would choose for a general-purpose signing system.        */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BITS = 2048;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: BITS,
  publicExponent: 65537,
});

// generateKeyPairSync already hands back KeyObjects, so this exports directly. JWK gives
// the raw parameters base64url encoded; n, e and d are what JUCE needs.
const jwk = privateKey.export({ format: "jwk" });

const toHex = (b64url) => {
  const bytes = Buffer.from(b64url, "base64url");
  const hex = bytes.toString("hex").replace(/^0+/, "");
  return hex === "" ? "0" : hex;
};

const n = toHex(jwk.n);
const e = toHex(jwk.e);
const d = toHex(jwk.d);

const publicJuce = `${e},${n}`;
const privateJuce = `${d},${n}`;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "cmake");
mkdirSync(outDir, { recursive: true });

/*  The public half is written where CMake can bake it into the binary. It is checked in
    deliberately -- it is public, and a build that silently loses it would refuse every
    activation.                                                                        */
writeFileSync(
  join(outDir, "activation-public-key.txt"),
  publicJuce + "\n",
  "utf8"
);

/*  The private half is written next to the secret that already must never be committed,
    and .gitignore covers it. It exists as a file only so it can be copied into Supabase;
    delete it afterwards if you like -- it is recoverable only by regenerating, which
    would invalidate every token already issued.                                       */
writeFileSync(
  join(outDir, "activation-private-key.SECRET.txt"),
  privateJuce + "\n",
  "utf8"
);

console.log(`RSA-${BITS} activation keypair generated.\n`);
console.log(`public  -> cmake/activation-public-key.txt        (${publicJuce.length} chars, safe to commit)`);
console.log(`private -> cmake/activation-private-key.SECRET.txt (${privateJuce.length} chars, NEVER commit)\n`);
console.log("Next: paste the private key into Supabase as the secret ACTIVATION_PRIVATE_KEY,");
console.log("then delete the .SECRET.txt file.\n");
console.log(`public key preview: ${publicJuce.slice(0, 48)}...`);
