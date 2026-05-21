-- opn-visualized-traffic-map cold-tier schema (PostgreSQL + TimescaleDB)

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS flows (
    recv_time    timestamptz NOT NULL,
    src_addr     inet        NOT NULL,
    dst_addr     inet        NOT NULL,
    src_port     integer,
    dst_port     integer,
    protocol     smallint,
    tcp_flags    smallint,
    tos          smallint,
    packets      bigint,
    octets       bigint,
    if_index_in  integer,
    if_index_out integer,
    gateway_addr inet,
    agent_addr   inet,
    src_as       bigint,
    dst_as       bigint,
    netflow_ver  smallint,
    flow_start   timestamptz,
    flow_end     timestamptz
);

SELECT create_hypertable(
    'flows', 'recv_time',
    if_not_exists      => TRUE,
    chunk_time_interval => INTERVAL '1 hour'
);

CREATE INDEX IF NOT EXISTS flows_src_addr_idx ON flows (src_addr, recv_time DESC);
CREATE INDEX IF NOT EXISTS flows_dst_addr_idx ON flows (dst_addr, recv_time DESC);
CREATE INDEX IF NOT EXISTS flows_dst_port_idx ON flows (dst_port, recv_time DESC);
CREATE INDEX IF NOT EXISTS flows_proto_idx    ON flows (protocol, recv_time DESC);
