FROM postgres:16

# Patroni (with the etcd3 driver) on top of the stock Postgres image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip gettext-base \
 && pip3 install --break-system-packages --no-cache-dir "patroni[etcd3]" psycopg2-binary \
 && apt-get purge -y python3-pip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY patroni.yml.tpl /patroni.yml.tpl
COPY entrypoint.sh /usr/local/bin/patroni-entrypoint.sh
RUN chmod +x /usr/local/bin/patroni-entrypoint.sh

# Runs as root, fixes data-dir ownership, then drops to postgres via gosu.
ENTRYPOINT ["/usr/local/bin/patroni-entrypoint.sh"]
