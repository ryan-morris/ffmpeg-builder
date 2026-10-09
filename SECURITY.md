# Security

Please report vulnerabilities privately, through GitHub's **Report a vulnerability** (Security → Advisories) on this
repository, not in a public issue. You'll get an answer within a week.

In scope: the CLI and its handling of untrusted input (archives `fetch` unpacks, release manifests, upstream version
listings, `ffmpeg-build.yml`), the build driver and recipes (what they download and how they check it), the toolchain
images, and the reusable workflows.

Vulnerabilities in FFmpeg or in the libraries it is built with belong upstream; once they are fixed there, `ffmpeg-build
update` picks the fixed versions up.
