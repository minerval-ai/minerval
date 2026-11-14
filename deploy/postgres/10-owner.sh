#!/bin/sh
# Run once by the Postgres image, as the server's superuser, the first time
# the data volume is empty (deploy/compose.yml mounts it into
# /docker-entrypoint-initdb.d).
#
# It makes what a private deployment's database has to have before the API
# first connects:
#
#   - the role the API connects as, `minerval_owner`. It owns the database
#     and its tables, may create roles (the migrations make the roles the
#     label policies bind, `minerval_cleared` among them), and is not a
#     superuser and does not bypass row-level security. A superuser's
#     connections pass every policy, and the API does not start on a
#     deployment with a second label when the role it reads through is one.
#   - the database, owned by that role;
#   - the two extensions the schema uses, which only a superuser may create.
#
# The owner's password comes from the container's environment and is passed
# to psql as a variable, so it is in no file and in no statement's text
# here.
set -eu

: "${MINERVAL_DB_OWNER_PASSWORD:?MINERVAL_DB_OWNER_PASSWORD is not set: the password of the role the API connects as}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v owner_password="$MINERVAL_DB_OWNER_PASSWORD" <<'SQL'
CREATE ROLE minerval_owner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD :'owner_password';
CREATE DATABASE minerval OWNER minerval_owner;
\connect minerval
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
