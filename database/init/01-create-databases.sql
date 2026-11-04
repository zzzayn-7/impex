-- Runs once, only when the Postgres data volume is empty (first start).
-- Executed by the entrypoint as POSTGRES_USER, who becomes the owner of both databases.
CREATE DATABASE impex_auth;
CREATE DATABASE impex_organizations;
CREATE DATABASE impex_inventory;
CREATE DATABASE impex_sales;
