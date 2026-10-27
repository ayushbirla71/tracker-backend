-- The system admin is created by the seed / script (never from the website). Only it may manage admins and change passwords.
ALTER TABLE admins ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing installs: the first admin that was created from the seed becomes the system admin.
UPDATE admins SET is_system = TRUE WHERE id = (SELECT min(id) FROM admins);

-- At most one system admin
CREATE UNIQUE INDEX admins_one_system ON admins ((is_system)) WHERE is_system;
