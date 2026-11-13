#!/usr/bin/env python3
"""Build a reproducible, checksummed extension archive."""

import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "extension"
manifest = json.loads((source / "manifest.json").read_text())

assert manifest["manifest_version"] == 3, "Expected a Manifest V3 extension"
assert set(manifest["permissions"]) == {
    "storage", "webRequest", "declarativeNetRequestWithHostAccess",
}, "Unexpected permission set"
assert manifest["host_permissions"], "host_permissions must not be empty"
assert all("*://*/*" not in host for host in manifest["host_permissions"]), \
    "Refusing to package an extension with unrestricted host access"

out = root / "dist"
out.mkdir(exist_ok=True)
archive = out / f"lane-guard-{manifest['version']}.zip"
files = sorted(path for path in source.rglob("*") if path.is_file() and
               path.relative_to(source).parts[0] != "_metadata")
assert not any(path.is_symlink() for path in source.rglob("*")), "Do not package symlinks"

digests = {}
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for path in files:
        relative = path.relative_to(source).as_posix()
        assert path.suffix in {".js", ".json", ".html"}, f"Unexpected package file: {relative}"
        data = path.read_bytes()
        digests[relative] = hashlib.sha256(data).hexdigest()
        entry = zipfile.ZipInfo(relative, (2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        bundle.writestr(entry, data)

receipt = {
    "version": manifest["version"],
    "host_permissions": manifest["host_permissions"],
    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "files": digests,
}
(out / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(archive)
print(f"SHA-256 {receipt['sha256']}")
