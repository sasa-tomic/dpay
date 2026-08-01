# Google Play app-signing certificates

These are the public X.509 certificates downloaded from Google Play Console for
the app-signing keys managed by Play App Signing. They contain no private key
material and are safe to keep in version control.

Files:

- `deployment_cert.der`: certificate for the key used to sign installed APKs.
- `hybrid_classical_cert.der`: classical part of Google's hybrid signing key.
- `hybrid_pqc_cert.der`: post-quantum part of Google's hybrid signing key.
- `upload_cert.pem`: public certificate for the developer-held upload key.

For this quantum-ready app, register all three Google-held app-signing
fingerprints with API providers and Android App Links: the deployment,
hybrid-classical, and hybrid-PQC certificates. Do not substitute the upload
certificate fingerprint; that certificate only authenticates bundle uploads to
Google Play.

Verify a DER certificate locally with:

```sh
keytool -printcert -file app/android/app/play-signing/deployment_cert.der
```

The current SHA-256 fingerprints are:

```text
deployment:       1C:5E:E4:87:52:6D:63:FC:53:DD:FD:21:93:F5:3A:FC:AB:9C:0B:31:7C:43:1F:AC:D6:19:34:63:CC:D7:27:A8
hybrid classical: 97:FD:D0:85:8A:17:39:C4:70:4D:94:A3:AF:D8:48:AD:88:F4:15:52:D1:13:26:5E:51:D7:0D:EC:9B:80:EC:53
hybrid PQC:       9E:F9:18:3B:37:9B:C0:7E:E0:B1:5D:70:F5:60:C0:F2:1C:39:D2:44:0A:DE:56:A9:09:6A:63:43:66:C5:D1:BE
upload:           1E:5C:F5:10:04:51:87:9C:BD:08:1C:C0:A1:3A:15:63:43:18:AD:32:A0:E7:6A:E8:07:A9:91:18:0E:FC:89:D1
```

Do not place the upload keystore, its passwords, a private key, or signing
property files in this directory or anywhere else in the repository. Keep a
local upload keystore outside the repository and store the CI copy in the CI
provider's encrypted secret store.

Local release builds default to
`~/.config/dpay/android/keystore.properties`, which points to the private
PKCS#12 upload keystore. CI may instead set `DPAY_KEYSTORE_PROPERTIES` or all
four `DPAY_UPLOAD_*` environment variables. Release artifact tasks fail when
neither source is configured; there is no debug-key fallback.

`app/android/app/debug.keystore` is only the React Native development key. It
must not be used to sign a Play release.
