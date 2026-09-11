# Verified package: Flowise 3.1.2, Node 20.20.2. Registry tag 3.1.4 was misleading.
FROM flowiseai/flowise@sha256:3922767afb52a5777759fd8b28a3c9eee864daea96018a791f2429eae2a76571
USER root
RUN mkdir -p /data && chown node:node /data
# 0.9.17 changed `db` from a filename to a Database object; Flowise passes a filename.
RUN cd /tmp && npm pack connect-sqlite3@0.9.15 --silent \
    && tar -xzf connect-sqlite3-0.9.15.tgz --strip-components=1 \
       -C /usr/local/lib/node_modules/flowise/node_modules/connect-sqlite3
COPY disable-retries.mjs /tmp/disable-retries.mjs
RUN node /tmp/disable-retries.mjs
USER node
