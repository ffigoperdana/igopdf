# Pin to a ClamAV feature release rather than `latest` so signature-engine
# upgrades are deliberate. The database itself is persisted in a named volume
# and refreshed by FreshClam inside the official image.
FROM clamav/clamav:1.4_base

USER root

# The IGO application permits PDF samples up to 1 GiB. ClamAV's stream and
# archive limits must be slightly higher than that or clamd would return a
# false "size limit exceeded" result for an otherwise permitted upload.
RUN set -eux; \
    sed -i -E \
      -e 's|^#?StreamMaxLength[[:space:]].*$|StreamMaxLength 1100M|' \
      -e 's|^#?MaxScanSize[[:space:]].*$|MaxScanSize 1100M|' \
      -e 's|^#?MaxFileSize[[:space:]].*$|MaxFileSize 1100M|' \
      -e 's|^#?ReadTimeout[[:space:]].*$|ReadTimeout 900|' \
      -e 's|^#?MaxThreads[[:space:]].*$|MaxThreads 2|' \
      -e 's|^#?MaxQueue[[:space:]].*$|MaxQueue 8|' \
      /etc/clamav/clamd.conf
