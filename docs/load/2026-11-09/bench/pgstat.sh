#!/bin/bash
# Снимок счётчиков теневой базы: транзакции, строки, WAL (байты), таблицы rooms/room_events/command_receipts/messages.
docker exec lt-pg psql -U streaming -d streaming -At -F' ' -c "
SELECT 'db', xact_commit, tup_inserted, tup_updated, tup_deleted, tup_fetched, blks_hit+blks_read FROM pg_stat_database WHERE datname='streaming';
SELECT 'wal', pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0')::bigint;
SELECT 'tbl', relname, n_tup_ins, n_tup_upd, n_tup_del, seq_scan, idx_scan FROM pg_stat_user_tables WHERE relname IN ('rooms','room_events','command_receipts','messages','system_lock') ORDER BY relname;
SELECT 'state', count(*), coalesce(avg(length(state))::int,0), coalesce(max(length(state)),0) FROM rooms;"
