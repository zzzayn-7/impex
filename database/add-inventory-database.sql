-- Creates the impex_inventory database on an EXISTING PostgreSQL volume.
-- Safe to run any number of times: it does nothing if the database already exists, and it never touches
-- the other databases. (Fresh installs get this database from database/init/01-create-databases.sql.)
--
-- PowerShell:
--   Get-Content database/add-inventory-database.sql | docker exec -i impex-postgres sh -c 'psql -U $POSTGRES_USER -d postgres'
SELECT 'CREATE DATABASE impex_inventory'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'impex_inventory')\gexec
